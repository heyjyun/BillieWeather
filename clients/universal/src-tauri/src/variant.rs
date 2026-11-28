//! Which app this build is, and which data it may open.
//!
//! The shipped app (`com.billieweather.client`) owns the person's ledgers, sign-in and WebView
//! storage. The folder and the keychain entry follow the identifier compiled into the binary; the
//! WebView storage and caches follow the bundle's Info.plist. A test build whose two names differ,
//! or that carries the shipped name, can reach the real data, so the app stops before opening
//! anything (window, database, keychain) unless everything agrees.
use serde_json::{json, Value};
use std::path::Path;
use tauri::{utils::config::Csp, Config};

pub const PRODUCTION_IDENTIFIER: &str = "com.billieweather.client";
/// Looked for (ops/sync-dev-mac.sh) before a binary is asked for `--billie-identity`: without it,
/// the flag would be an unknown argument to an older build.
#[used]
static MARKER: [u8; 28] = *b"billie-launch-guard-version1";
pub const REFUSED: i32 = 78;

/// What a build says about itself. `bundle` is the Info.plist identifier of the running bundle.
pub struct Build<'a> {
    pub identifier: &'a str,
    pub bundle: Option<&'a str>,
    pub debug: bool,
}

/// The reason this build must not open its data, if any.
pub fn refusal(build: &Build) -> Option<&'static str> {
    if build.debug && build.identifier == PRODUCTION_IDENTIFIER {
        return Some("a debug build must not use the shipped app's identifier");
    }
    if cfg!(target_os = "macos") {
        match build.bundle {
            Some(bundle) if bundle != build.identifier => return Some("the bundle and the binary have different identifiers"),
            None if !build.debug => return Some("a release build runs only inside its app bundle"),
            _ => {}
        }
    }
    None
}

/// The `connect-src` sources of the app's Content Security Policy.
fn connect_sources(config: &Config) -> Vec<String> {
    let Some(Csp::Policy(policy)) = &config.app.security.csp else { return vec!["*".into()] };
    policy
        .split(';')
        .find_map(|directive| directive.trim().strip_prefix("connect-src "))
        .map_or(vec!["*".into()], |sources| sources.split_whitespace().map(str::to_owned).collect())
}

/// The folder must be this identifier's own: a link to another folder, or a database file that is a
/// link, would open someone else's ledger. Never looks at any other folder.
pub fn check_data_dir(dir: &Path, identifier: &str, files: &[String]) -> Result<(), &'static str> {
    if dir.file_name().and_then(|name| name.to_str()) != Some(identifier) {
        return Err("the data folder does not belong to this identifier");
    }
    if identifier == PRODUCTION_IDENTIFIER || std::fs::symlink_metadata(dir).is_err() {
        return Ok(());
    }
    let resolved = std::fs::canonicalize(dir).map_err(|_| "the data folder cannot be resolved")?;
    if resolved.file_name().and_then(|name| name.to_str()) != Some(identifier) {
        return Err("the data folder is a link to another folder");
    }
    for name in files {
        let Ok(meta) = std::fs::symlink_metadata(dir.join(name)) else { continue };
        #[cfg(unix)]
        let linked = std::os::unix::fs::MetadataExt::nlink(&meta) > 1;
        #[cfg(not(unix))]
        let linked = false;
        if !meta.is_file() || linked {
            return Err("a database file is a link");
        }
    }
    Ok(())
}

/// Called first in `run()`: ends the process before any window, database or keychain is opened.
pub fn enforce(config: &Config) {
    if !cfg!(desktop) {
        return;
    }
    let bundle = bundle_identifier();
    let build = Build { identifier: &config.identifier, bundle: bundle.as_deref(), debug: cfg!(debug_assertions) };
    if let Some(reason) = refusal(&build) {
        use std::io::Write;
        // A fixed sentence only: no paths, names or data.
        let _ = std::io::stderr().lock().write_all(format!("BillieWeather did not start: {reason}.\n").as_bytes());
        std::process::exit(REFUSED);
    }
}

/// For `--billie-identity`: what this binary would use, without opening any of it.
pub fn report(config: &Config) -> Value {
    let bundle = bundle_identifier();
    let connect = connect_sources(config);
    let identifier = config.identifier.as_str();
    let dev_url = config.build.dev_url.as_ref().map(|url| url.to_string());
    let build = Build { identifier, bundle: bundle.as_deref(), debug: cfg!(debug_assertions) };
    let home = std::env::home_dir().unwrap_or_default();
    let webkit = bundle.as_deref().unwrap_or("");
    let library = |folder: &str, name: &str| home.join("Library").join(folder).join(name).to_string_lossy().into_owned();
    json!({
        "marker": String::from_utf8_lossy(&MARKER),
        "identifier": identifier,
        "bundleIdentifier": bundle,
        "productName": config.product_name,
        "windowTitles": config.app.windows.iter().map(|window| window.title.clone()).collect::<Vec<_>>(),
        "debug": build.debug,
        "devUrl": dev_url,
        "sourceRevision": env!("BILLIE_SOURCE_REVISION"),
        "sqlite": crate::sqlite_version(),
        "dataDir": library("Application Support", identifier),
        "cacheDir": library("Caches", identifier),
        "webkitDir": library("WebKit", webkit),
        "preferences": library("Preferences", &format!("{webkit}.plist")),
        "keychainService": crate::session::service_name(identifier, build.debug),
        "connect": connect,
        "refusal": refusal(&build),
    })
}

#[cfg(target_os = "macos")]
fn bundle_identifier() -> Option<String> {
    use std::ffi::{c_char, c_void, CStr};
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFBundleGetMainBundle() -> *const c_void;
        fn CFBundleGetIdentifier(bundle: *const c_void) -> *const c_void;
        fn CFStringGetCString(string: *const c_void, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
    }
    const UTF8: u32 = 0x0800_0100;
    let mut buffer = [0 as c_char; 256];
    // SAFETY: both references are borrowed ("Get" rule) and checked; the buffer size is passed on.
    unsafe {
        let bundle = CFBundleGetMainBundle();
        if bundle.is_null() {
            return None;
        }
        let identifier = CFBundleGetIdentifier(bundle);
        if identifier.is_null() || CFStringGetCString(identifier, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) == 0 {
            return None;
        }
        Some(CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into_owned())
    }
}

#[cfg(not(target_os = "macos"))]
fn bundle_identifier() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV: &str = "com.billieweather.client.dev";

    fn check(identifier: &str, bundle: Option<&str>, debug: bool) -> bool {
        refusal(&Build { identifier, bundle, debug }).is_none()
    }

    #[test]
    fn a_debug_build_never_runs_as_the_shipped_app() {
        assert!(!check(PRODUCTION_IDENTIFIER, None, true));
        assert!(!check(PRODUCTION_IDENTIFIER, Some(PRODUCTION_IDENTIFIER), true));
        assert!(check("com.billieweather.client.dev", None, true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_rewritten_bundle_is_refused() {
        // The 2026-11-24 incident: a binary built as the shipped app inside a test-named bundle.
        assert!(!check(PRODUCTION_IDENTIFIER, Some("com.billieweather.roadmap.phase52"), false));
        assert!(!check(DEV, Some(PRODUCTION_IDENTIFIER), false));
        assert!(!check(PRODUCTION_IDENTIFIER, Some(DEV), false));
        assert!(!check(PRODUCTION_IDENTIFIER, None, false));
        assert!(!check(DEV, None, false));
        assert!(check(PRODUCTION_IDENTIFIER, Some(PRODUCTION_IDENTIFIER), false));
        assert!(check(DEV, Some(DEV), false));
    }


    #[cfg(unix)]
    #[test]
    fn links_to_another_ledger_are_refused() {
        let root = std::env::temp_dir().join(format!("bw-variant-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("billieweather.db"), "x").unwrap();
        let files = vec!["billieweather.db".to_string()];
        let dir = root.join(DEV);
        assert_eq!(check_data_dir(&dir, DEV, &files), Ok(()), "first launch: no folder yet");
        assert!(check_data_dir(&other, DEV, &files).is_err());
        std::os::unix::fs::symlink(&other, &dir).unwrap();
        assert!(check_data_dir(&dir, DEV, &files).is_err());
        std::fs::remove_file(&dir).unwrap();
        std::fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink(other.join("billieweather.db"), dir.join("billieweather.db")).unwrap();
        assert!(check_data_dir(&dir, DEV, &files).is_err());
        std::fs::remove_file(dir.join("billieweather.db")).unwrap();
        std::fs::hard_link(other.join("billieweather.db"), dir.join("billieweather.db")).unwrap();
        assert!(check_data_dir(&dir, DEV, &files).is_err());
        std::fs::remove_file(dir.join("billieweather.db")).unwrap();
        std::fs::write(dir.join("billieweather.db"), "x").unwrap();
        assert_eq!(check_data_dir(&dir, DEV, &files), Ok(()));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
