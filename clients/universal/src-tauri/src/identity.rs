//! This installation's stable device id for the website's "Local database" cards.
//!
//! A random UUID kept in `device-identity.json` in the app's config directory: the same
//! directory tauri-plugin-sql resolves `sqlite:billieweather.db` against, so the id lives and
//! dies with the databases it describes. Unlike WebView localStorage it is shared by every
//! WebView origin of a build (`tauri dev` and the bundled app), survives restarts and updates,
//! and is never derived from hardware, a name, a launch time or a session.
//!
//! The file is created once with an atomic "create if absent" (write a temp file, hard-link it
//! into place), so two windows starting at once agree on one id. An existing but unreadable
//! file is never replaced: the app then simply does not report (identity is ambiguous).
use std::{fs, io::Write, path::Path};
use tauri::Manager;

const FILE: &str = "device-identity.json";
/// Only the released app reports metadata. QA builds (other identifiers) and debug builds
/// keep their own data and never appear as devices on the website.
pub const PRODUCTION_IDENTIFIER: &str = "com.billieweather.client";

pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "device identity unreadable".to_string())?;
            match value.get("device_id").and_then(|id| id.as_str()) {
                Some(id) if is_uuid(id) => Ok(Some(id.to_string())),
                _ => Err("device identity unreadable".into()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("device identity unreadable".into()),
    }
}

/// Returns the stored id, or stores `candidate` (a random UUID made by the app, or the id an
/// older version kept in WebView storage, so the website card carries on) and returns it.
pub fn load_or_create(dir: &Path, candidate: &str) -> Result<String, String> {
    let path = dir.join(FILE);
    if let Some(id) = read(&path)? {
        return Ok(id);
    }
    if !is_uuid(candidate) {
        return Err("invalid device id".into());
    }
    fs::create_dir_all(dir).map_err(|_| "no data directory".to_string())?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = dir.join(format!("{FILE}.{}-{unique}.tmp", std::process::id()));
    {
        let mut file = fs::File::create(&temp).map_err(|_| "device identity write failed".to_string())?;
        let body = serde_json::json!({ "version": 1, "device_id": candidate });
        file.write_all(body.to_string().as_bytes()).and_then(|_| file.sync_all()).map_err(|_| "device identity write failed".to_string())?;
    }
    let linked = fs::hard_link(&temp, &path);
    let _ = fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(candidate.to_string()),
        // Someone else created it first: theirs wins.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read(&path)?.ok_or_else(|| "device identity unreadable".into()),
        Err(_) => Err("device identity write failed".into()),
    }
}

#[tauri::command]
pub fn device_identity(app: tauri::AppHandle, candidate: String) -> Result<serde_json::Value, String> {
    let dir = app.path().app_config_dir().map_err(|_| "no data directory".to_string())?;
    let device_id = load_or_create(&dir, &candidate)?;
    let reportable = !cfg!(debug_assertions) && app.config().identifier == PRODUCTION_IDENTIFIER;
    Ok(serde_json::json!({ "deviceId": device_id, "platform": std::env::consts::OS, "reportable": reportable }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "754309e7-4ba6-4336-9347-5eb71ddbd657";
    const B: &str = "d30ddb65-2073-4d9a-8278-4890c8721cc3";

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("billie-identity-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_first_id_is_kept_across_restarts() {
        let dir = temp_dir("restart");
        assert_eq!(load_or_create(&dir, A).unwrap(), A);
        for _ in 0..20 {
            assert_eq!(load_or_create(&dir, B).unwrap(), A, "a later launch never replaces the id");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_starts_agree_on_one_id() {
        let dir = temp_dir("race");
        let ids: Vec<String> = [A, B, A, B]
            .iter()
            .map(|candidate| {
                let dir = dir.clone();
                let candidate = candidate.to_string();
                std::thread::spawn(move || load_or_create(&dir, &candidate).unwrap())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_file_is_never_silently_replaced() {
        let dir = temp_dir("damaged");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load_or_create(&dir, A).is_err());
        assert_eq!(fs::read_to_string(dir.join(FILE)).unwrap(), "not json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_ids_that_are_not_lowercase_uuids() {
        let dir = temp_dir("invalid");
        assert!(load_or_create(&dir, "Jyun's MacBook Air").is_err());
        assert!(load_or_create(&dir, &A.to_uppercase()).is_err());
        assert!(!dir.join(FILE).exists());
    }
}
