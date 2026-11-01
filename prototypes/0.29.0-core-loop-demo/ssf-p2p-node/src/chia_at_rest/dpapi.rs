//! Windows DPAPI for the identity's entropy: `CryptProtectData` and
//! `CryptUnprotectData` for the current user (no machine scope), never with
//! a prompt, with [`dpapi_entropy`] as the extra entropy. What DPAPI hands
//! back lives in a `LocalAlloc` buffer: an opened entropy is copied into a
//! buffer wiped when dropped, and the OS buffer is wiped before `LocalFree`.

use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use zeroize::{Zeroize, Zeroizing};

use super::{classify_dpapi, dpapi_entropy, AtRest, SecretStore, StoreError};

pub struct Dpapi;

/// A read-only view of `bytes` for DPAPI's input parameters.
fn blob_of(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
}

/// DPAPI's output buffer, freed with `LocalFree` when dropped, and wiped
/// first when it holds a secret.
struct Output {
    blob: CRYPT_INTEGER_BLOB,
    secret: bool,
}

impl Output {
    fn new(secret: bool) -> Output {
        Output { blob: CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() }, secret }
    }

    fn bytes(&self) -> &[u8] {
        if self.blob.pbData.is_null() {
            return &[];
        }
        // SAFETY: DPAPI filled `pbData` with `cbData` bytes it allocated.
        unsafe { std::slice::from_raw_parts(self.blob.pbData, self.blob.cbData as usize) }
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        if self.blob.pbData.is_null() {
            return;
        }
        if self.secret {
            // SAFETY: as in `bytes`; nothing else holds the buffer.
            unsafe { std::slice::from_raw_parts_mut(self.blob.pbData, self.blob.cbData as usize) }.zeroize();
        }
        // SAFETY: DPAPI allocates its output with LocalAlloc; freed once.
        unsafe { LocalFree(self.blob.pbData as _) };
    }
}

fn last_error() -> StoreError {
    // SAFETY: no arguments; reads the calling thread's last error.
    let code = unsafe { GetLastError() };
    StoreError { refusal: classify_dpapi(code), code: code as i64 }
}

impl SecretStore for Dpapi {
    fn protect(&self) -> AtRest {
        AtRest::Dpapi
    }

    fn wrap(&self, entropy: &[u8; 32], fingerprint: u32) -> Result<Vec<u8>, StoreError> {
        let extra = dpapi_entropy(fingerprint);
        let input = blob_of(&entropy[..]);
        let extra = blob_of(extra.as_bytes());
        let mut out = Output::new(false);
        // SAFETY: every pointer is valid for the call; the output is ours to free.
        let ok = unsafe {
            CryptProtectData(&input, null(), &extra, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out.blob)
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(out.bytes().to_vec())
    }

    fn unwrap(&self, blob: &[u8], fingerprint: u32) -> Result<Zeroizing<Vec<u8>>, StoreError> {
        let extra = dpapi_entropy(fingerprint);
        let input = blob_of(blob);
        let extra = blob_of(extra.as_bytes());
        let mut out = Output::new(true);
        // SAFETY: as in `wrap`; no description is asked back.
        let ok = unsafe {
            CryptUnprotectData(&input, null_mut(), &extra, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out.blob)
        };
        if ok == 0 {
            return Err(last_error());
        }
        let bytes = out.bytes();
        let mut opened = Zeroizing::new(Vec::with_capacity(bytes.len()));
        opened.extend_from_slice(bytes);
        Ok(opened)
    }
}
