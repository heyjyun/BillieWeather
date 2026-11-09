//! Keeps the BillieWeather sign-in token (never financial data) out of the WebView.
//! macOS/iOS: Keychain. Windows: Credential Manager. Elsewhere (Android, Linux): a file
//! readable only by this app in its private data directory.

const SERVICE: &str = "com.billieweather.client";
const ACCOUNT: &str = "session";

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
mod store {
    use super::{ACCOUNT, SERVICE};

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| "keychain unavailable".to_string())
    }

    pub fn load(_app: &tauri::AppHandle) -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("keychain read failed".into()),
        }
    }

    pub fn save(_app: &tauri::AppHandle, token: &str) -> Result<(), String> {
        entry()?.set_password(token).map_err(|_| "keychain write failed".into())
    }

    pub fn clear(_app: &tauri::AppHandle) -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("keychain delete failed".into()),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
mod store {
    use std::path::PathBuf;
    use tauri::Manager;

    fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_data_dir().map_err(|_| "no data directory".to_string())?;
        std::fs::create_dir_all(&dir).map_err(|_| "no data directory".to_string())?;
        Ok(dir.join("session.token"))
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
