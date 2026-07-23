/**
 * 📟 Installed app version — shown on the SpacePhone's Settings › Stats page.
 *
 * ⚠ RELEASE MECHANICS: this constant is the NINTH version location. The
 * release bump must update it alongside package.json, package-lock.json (×2),
 * tauri.conf.json, both Cargo.toml files and both Cargo.lock entries:
 *   sed -i "s/APP_VERSION = '<old>'/APP_VERSION = '<new>'/" src/version.ts
 */
export const APP_VERSION = '0.33.25';
