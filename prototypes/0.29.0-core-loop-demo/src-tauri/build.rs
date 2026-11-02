// The app's own commands get an ACL manifest, so each is refused unless a
// capability grants it: capabilities/main.json gives the game page's window
// `open_backup` only, capabilities/reveal.json gives the backup window the
// two reveal commands only (permission names take dashes: allow-open-backup).
fn main() {
    if let Err(e) = tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["open_backup", "backup_reveal", "backup_saved"])),
    ) {
        panic!("tauri-build: {e:#}");
    }
}
