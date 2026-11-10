//! 🔒 Files readable by their owner only, and the node's iroh key kept in
//! one of them. Built in every feature set: a build without the chain lane
//! (`--no-default-features`) holds the iroh key too, and keeps it 0600 on
//! Unix as every other build does (stage 4 design §4.5). `chia_contact` writes its
//! own secrets through the same two functions.

use std::path::Path;

use anyhow::Result;

/// Write a secret file readable by its owner only (0600 on Unix; elsewhere the
/// platform's default), atomically: the bytes go to a fresh 0600 temporary
/// beside the destination, are synced, the temporary is renamed over the
/// destination and the directory is synced too (on Unix), so the new name
/// survives a power loss. A crash or short write thus
/// leaves the previous file intact — a half-written `contact.key` would
/// otherwise be read as damaged at the next start and silently replaced, making
/// every card handed out stale — and a destination left broader by an earlier
/// tool or run is replaced by the fresh 0600 file.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => Path::new(".").to_path_buf(),
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".to_string());
    let tmp = dir.join(format!(
        ".{name}.{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let written = (|| -> std::io::Result<()> {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)?;
        // The rename is directory metadata: until the directory is synced, a
        // power loss can still lose the new name (a freshly minted
        // `contact.key` would then rotate the identity at the next start).
        // Windows has no directory handle to sync; NTFS journals the rename.
        #[cfg(unix)]
        std::fs::File::open(&dir)?.sync_all()?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Rewrite a file where it is, readable by its owner only: on Unix a new
/// file is made 0600, and one an earlier run left broader is tightened once
/// it is emptied and before any byte goes in (best-effort: a file system
/// that keeps no modes leaves it as it is, and the write still happens);
/// elsewhere the platform's default. Not atomic: a crash mid-write leaves a
/// torn file. It is for the state files that were always written this way,
/// whose readers take a torn or missing file for what it is (the room
/// documents in `rooms/`), and for the fallback of
/// [`write_private_replacing`].
pub fn write_private_in_place(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    f.write_all(bytes)
}

/// Write `bytes` to `path` as a whole, readable by its owner only: into the
/// temporary file `<name>.tmp` beside it ([`write_private_in_place`], so a
/// stale temporary an earlier run left broader is tightened too), then a
/// rename over the destination, which `std::fs::rename` replaces on every
/// platform (on Windows through `MOVEFILE_REPLACE_EXISTING`). Windows can
/// still refuse that rename while another process holds the destination open
/// (a sharing violation); then the file is rewritten in place, owner-only as
/// well, rather than left stale. Unlike [`write_private`] it syncs nothing and
/// keeps that fallback: it is for the state files rewritten at every change
/// (`wallet_lease.json`, where a stale parking would silently forget live
/// spends and a torn one is unreadable and said at startup, #245 review,
/// round 18; `chia_peers.json`), not for keys.
pub fn write_private_replacing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    write_private_in_place(&tmp, bytes)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            let _ = std::fs::remove_file(&tmp);
            write_private_in_place(path, bytes).map_err(|_| rename_err)
        }
    }
}

/// Remove a file [`write_private`] wrote, so that the removal survives a
/// power loss as the write does: the directory is synced after it (on
/// Unix). A file that is not there counts as removed, and nothing is synced
/// then, since nothing changed.
pub fn remove_private(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }
    #[cfg(unix)]
    {
        let dir = match path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p,
            _ => Path::new("."),
        };
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// Reset an EXISTING secret file to 0600 without rewriting it (Unix; a no-op
/// elsewhere). The contact key is written once and then only read, so a copy
/// left broader than 0600 would otherwise stay readable for the life of the
/// node — `write_private` never gets a chance to tighten it.
pub fn tighten_private(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// The file of the node's iroh identity key, beside `contact.key` in a build
/// with the chain lane.
pub const NODE_KEY_FILE: &str = "iroh_node_id.key";

/// Load the node's iroh secret key, or mint one, kept as the contact key is
/// (stage 4 design §4.5, on every network and in every build): a new key is
/// written 0600 and atomically ([`write_private`]), and a loaded key's file
/// is tightened to 0600 on the way, since it was once a plain write that
/// left the mode to the umask. A file of the wrong size is replaced, as it always was. A
/// file that cannot be tightened is said, and the key still loads: the
/// node keeps its identity, and its dial key, whatever the file's mode.
pub fn load_or_create_node_key(path: &Path) -> Result<iroh::SecretKey> {
    if path.exists() {
        let bytes = std::fs::read(path)?;
        if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
            if let Err(e) = tighten_private(path) {
                eprintln!("🔑 {}: could not make it readable by its owner only ({e}); the node keeps its key", path.display());
            }
            return Ok(iroh::SecretKey::from_bytes(&arr));
        }
    }
    let sk = iroh::SecretKey::generate();
    write_private(path, &sk.to_bytes())?;
    Ok(sk)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stage 4 design §4.5: `iroh_node_id.key` is kept as `contact.key` is,
    /// on every network (it is one file for both) and in every build, a
    /// build without the chain lane too: minted 0600, the same key
    /// back on every load, a broader file tightened when it is loaded, and a
    /// damaged one replaced by a fresh 0600 key. Unix only, where the mode
    /// is the owner-only rule.
    #[cfg(unix)]
    #[test]
    fn the_node_key_is_written_0600_and_tightened_on_load() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let dir = std::env::temp_dir().join(format!("ssf-nk-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(NODE_KEY_FILE);
        let a = load_or_create_node_key(&path).unwrap();
        assert_eq!(mode(&path), 0o600, "a new key is written owner-only");
        let b = load_or_create_node_key(&path).unwrap();
        assert_eq!(a.public(), b.public(), "the same key comes back");
        assert_eq!(std::fs::read(&path).unwrap().len(), 32, "the file holds the 32 bytes, as before");
        // A key file an older node wrote with a plain write, under a broad
        // umask: tightened when it is loaded, the key unchanged.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let loaded = load_or_create_node_key(&path).unwrap();
        assert_eq!(loaded.public(), a.public(), "the broader file still holds the same key");
        assert_eq!(mode(&path), 0o600, "loading a broader key file tightens it to 0600");
        // A damaged file is replaced, as it always was, and the new one is owner-only.
        std::fs::write(&path, b"short").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let c = load_or_create_node_key(&path).unwrap();
        assert_ne!(c.public(), a.public(), "a damaged file is replaced by a fresh key");
        assert_eq!(mode(&path), 0o600, "rewriting a broader file tightens it to 0600");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The state files rewritten at every change (stage 4 privacy gaps,
    /// docs/TDD/ChiaLanePrivacy.md §11): `write_private_in_place` and
    /// `write_private_replacing` write the bytes whole, leave a new file
    /// owner-only, and tighten one an older build left to the umask, the
    /// stale temporary of a crashed write among them.
    #[test]
    fn a_state_file_is_rewritten_owner_only_in_place_and_by_replacing() {
        let dir = std::env::temp_dir().join(format!("ssf-pf-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        let mode = |p: &Path| {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        };
        #[cfg(unix)]
        let broaden = |p: &Path| {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o644)).unwrap();
        };
        type Write = fn(&Path, &[u8]) -> std::io::Result<()>;
        let ways: [(&str, Write); 2] = [("in-place.bin", write_private_in_place), ("replacing.json", write_private_replacing)];
        for (name, write) in ways {
            let path = dir.join(name);
            write(&path, b"first").unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), b"first", "{name}");
            #[cfg(unix)]
            assert_eq!(mode(&path), 0o600, "{name}: a new file is owner-only");
            // A longer file an older build wrote, left to the umask: the
            // rewrite is whole (nothing of the old tail) and owner-only.
            std::fs::write(&path, b"an older and longer file").unwrap();
            #[cfg(unix)]
            broaden(&path);
            write(&path, b"second").unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), b"second", "{name}");
            #[cfg(unix)]
            assert_eq!(mode(&path), 0o600, "{name}: a broader file is owner-only after the rewrite");
        }
        // The temporary of a write that crashed under an older build, left
        // broad beside the destination: its mode does not come back with the
        // rename, and no temporary is left behind.
        let path = dir.join("replacing.json");
        let tmp = dir.join("replacing.json.tmp");
        std::fs::write(&tmp, b"torn").unwrap();
        #[cfg(unix)]
        broaden(&tmp);
        write_private_replacing(&path, b"third").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"third");
        assert!(!tmp.exists(), "the temporary became the file");
        #[cfg(unix)]
        assert_eq!(mode(&path), 0o600, "a stale temporary's mode is not the file's");
        // A destination the rename cannot replace (a directory stands in
        // for Windows' sharing violation) fails with the rename's error,
        // and the temporary is not left behind.
        let taken = dir.join("taken.json");
        std::fs::create_dir_all(&taken).unwrap();
        assert!(write_private_replacing(&taken, b"x").is_err());
        assert!(!dir.join("taken.json.tmp").exists(), "no temporary left after a failure");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file written owner-only is removed, and one that is not there
    /// counts as removed; something that is not a file is not removed, and
    /// the error says so.
    #[test]
    fn a_private_file_is_removed_and_a_missing_one_counts_as_removed() {
        let dir = std::env::temp_dir().join(format!("ssf-rm-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("switch.json");
        write_private(&path, b"{}").unwrap();
        remove_private(&path).unwrap();
        assert!(!path.exists(), "removed");
        remove_private(&path).expect("a missing file counts as removed");
        let folder = dir.join("folder.json");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(remove_private(&folder).is_err(), "a directory is not a file");
        assert!(folder.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
