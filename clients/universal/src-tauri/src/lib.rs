mod device;
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
        .invoke_handler(tauri::generate_handler![
            device::device_name,
            session::session_load,
            session::session_save,
            session::session_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running BillieWeather");
}
