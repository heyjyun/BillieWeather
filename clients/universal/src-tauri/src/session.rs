//! Keeps the BillieWeather sign-in token (never financial data) out of the WebView.
//! macOS/iOS: Keychain. Windows: Credential Manager. Elsewhere (Android, Linux): a file
//! readable only by this app in its private data directory.
//!
//! Each build variant keeps its own sign-in. The keychain service is the bundle identifier
//! (`com.billieweather.client` for the shipped app, exactly the name used before, so existing
//! sign-ins survive updates). Debug builds (`desktop:dev`, `cargo test`) add `.dev`, and QA/beta
//! builds with their own identifier get their own entry, so no variant can read or overwrite
//! the installed app's token.

const ACCOUNT: &str = "session";

/// The keychain service (desktop/iOS) or token file stem (Android/Linux) for this build.
fn service_name(identifier: &str, debug: bool) -> String {
    if debug {
        format!("{identifier}.dev")
    } else {
        identifier.to_string()
    }
}

fn current_service(app: &tauri::AppHandle) -> String {
    service_name(&app.config().identifier, cfg!(debug_assertions))
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
mod store {
    use super::{current_service, ACCOUNT};

    fn entry(app: &tauri::AppHandle) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&current_service(app), ACCOUNT).map_err(|_| "keychain unavailable".to_string())
    }

    pub fn load(app: &tauri::AppHandle) -> Result<Option<String>, String> {
        match entry(app)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("keychain read failed".into()),
        }
    }

    pub fn save(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
        entry(app)?.set_password(token).map_err(|_| "keychain write failed".into())
    }

    pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
        match entry(app)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("keychain delete failed".into()),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
mod store {
    use std::path::PathBuf;
    use tauri::Manager;

    /// The data directory is already per identifier; debug builds also use their own file.
    fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_data_dir().map_err(|_| "no data directory".to_string())?;
        std::fs::create_dir_all(&dir).map_err(|_| "no data directory".to_string())?;
        Ok(dir.join(if cfg!(debug_assertions) { "session.dev.token" } else { "session.token" }))
    }

    pub fn load(app: &tauri::AppHandle) -> Result<Option<String>, String> {
        match std::fs::read_to_string(path(app)?) {
            Ok(token) => Ok(Some(token)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("session read failed".into()),
        }
    }

    pub fn save(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
        let path = path(app)?;
        std::fs::write(&path, token).map_err(|_| "session write failed".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|_| "session write failed".to_string())?;
        }
        Ok(())
    }

    pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
        match std::fs::remove_file(path(app)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("session delete failed".into()),
        }
    }
}

#[tauri::command]
pub fn session_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    store::load(&app)
}

#[tauri::command]
pub fn session_save(app: tauri::AppHandle, token: String) -> Result<(), String> {
    if token.is_empty() || token.len() > 4096 {
        return Err("invalid token".into());
    }
    store::save(&app, &token)
}

#[tauri::command]
pub fn session_clear(app: tauri::AppHandle) -> Result<(), String> {
    store::clear(&app)
}

#[cfg(test)]
mod tests {
    use super::service_name;

    const PRODUCTION: &str = "com.billieweather.client";

    #[test]
    fn shipped_app_keeps_the_existing_keychain_entry() {
        // Changing this would sign every existing user out after an update.
        assert_eq!(service_name(PRODUCTION, false), "com.billieweather.client");
    }

    #[test]
    fn debug_builds_never_use_the_shipped_entry() {
        assert_eq!(service_name(PRODUCTION, true), "com.billieweather.client.dev");
        assert_ne!(service_name(PRODUCTION, true), service_name(PRODUCTION, false));
    }

    #[test]
    fn other_variants_get_their_own_entry() {
        for variant in ["com.billieweather.qa", "com.billieweather.beta"] {
            assert_eq!(service_name(variant, false), variant);
            assert_ne!(service_name(variant, false), PRODUCTION);
            assert_ne!(service_name(variant, true), PRODUCTION);
        }
    }

    #[test]
    fn tests_run_as_a_debug_build() {
        // `cargo test` compiles with debug assertions, so tests can only reach `.dev` entries.
        assert!(cfg!(debug_assertions));
    }
}
