mod device;
mod identity;
mod ocr;
mod session;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Local databases live in the app's private data directory on every platform. A device can
/// keep several (each its own file: billieweather.db, billieweather-2.db, …), so every slot
/// gets the same migrations. Keep in step with MAX_DATABASES in src/services/databases.ts.
/// Schema changes ship as new numbered migrations; existing files are never edited.
const MAX_DATABASES: u32 = 8;

fn slot_file(slot: u32) -> String {
    if slot == 1 {
        "sqlite:billieweather.db".to_string()
    } else {
        format!("sqlite:billieweather-{slot}.db")
    }
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
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut sql = tauri_plugin_sql::Builder::default();
    for slot in 1..=MAX_DATABASES {
        sql = sql.add_migrations(&slot_file(slot), migrations());
    }
    tauri::Builder::default()
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
            session::session_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running BillieWeather");
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
