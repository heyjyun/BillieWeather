mod device;
mod identity;
mod ocr;
mod session;
mod snapshot;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Local databases live in the app's private data directory on every platform. A device can
/// keep several (each its own file: billieweather.db, billieweather-2.db, …), so every slot
/// gets the same migrations. Keep in step with MAX_DATABASES in src/services/databases.ts.
/// Schema changes ship as new numbered migrations; existing files are never edited.
const MAX_DATABASES: u32 = 8;

fn slot_name(slot: u32) -> String {
    if slot == 1 {
        "billieweather.db".to_string()
    } else {
        format!("billieweather-{slot}.db")
    }
}

fn slot_file(slot: u32) -> String {
    format!("sqlite:{}", slot_name(slot))
}

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial local schema",
            sql: include_str!("../migrations/0001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "copies of website statements",
            sql: include_str!("../migrations/0002_web_sync.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "custom categories",
            sql: include_str!("../migrations/0003_custom_categories.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "universal import schema",
            sql: include_str!("../migrations/0004_universal_import.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "optional statement region",
            sql: include_str!("../migrations/0005_statement_region.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "statement region detection",
            sql: include_str!("../migrations/0006_statement_region_detection.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "hybrid ledger: accounts, kinds, links, dimensions, budgets, recurring, audit",
            sql: include_str!("../migrations/0007_ledger.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut sql = tauri_plugin_sql::Builder::default();
    for slot in 1..=MAX_DATABASES {
        sql = sql.add_migrations(&slot_file(slot), migrations());
    }
    tauri::Builder::default()
        .setup(|app| {
            // Before any database is opened (and migrated) by the web view: copy every slot file
            // whose schema is about to change. A failed copy does not stop the app (nothing is
            // printed: logs must never carry anything about a person's data); the app's Data page
            // lists the copies that exist.
            use tauri::Manager;
            if let Ok(dir) = app.path().app_config_dir() {
                let version = migrations().len() as u32;
                for slot in 1..=MAX_DATABASES {
                    let _ = snapshot::snapshot_if_needed(&dir, &slot_name(slot), version);
                }
            }
            Ok(())
        })
        .plugin(sql.build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_billie_ocr::init())
        .invoke_handler(tauri::generate_handler![
            device::device_name,
            identity::device_identity,
            ocr::ocr_capabilities,
            ocr::ocr_recognize_image,
            session::session_load,
            session::session_save,
            session::session_clear,
            snapshot_list,
            snapshot_restore
        ])
        .run(tauri::generate_context!())
        .expect("error while running BillieWeather");
}

/// The automatic pre-migration copies on this device (file names only), newest first.
#[tauri::command]
fn snapshot_list(app: tauri::AppHandle) -> Result<Vec<snapshot::SnapshotInfo>, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let names: Vec<String> = (1..=MAX_DATABASES).map(slot_name).collect();
    snapshot::list(&dir, &names).map_err(|e| e.to_string())
}

/// Copies one automatic copy into an EMPTY slot (a file name that does not exist yet), so it can
/// be opened as a new database. Never overwrites a file.
#[tauri::command]
fn snapshot_restore(app: tauri::AppHandle, snapshot: String, slot: u32) -> Result<(), String> {
    use tauri::Manager;
    if !(1..=MAX_DATABASES).contains(&slot) {
        return Err("invalid slot".into());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let names: Vec<String> = (1..=MAX_DATABASES).map(slot_name).collect();
    snapshot::restore(&dir, &names, &snapshot, &slot_name(slot)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::slot_file;

    /// The SQLite file names never depend on the build, the launch or the session; the plugin
    /// resolves them against the app's fixed config directory (one per identifier).
    #[test]
    fn database_paths_are_fixed_per_slot() {
        assert_eq!(slot_file(1), "sqlite:billieweather.db");
        assert_eq!(slot_file(2), "sqlite:billieweather-2.db");
        for _ in 0..3 {
            assert_eq!(slot_file(1), slot_file(1));
        }
    }
}
