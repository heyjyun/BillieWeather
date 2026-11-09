mod session;

use tauri_plugin_sql::{Migration, MigrationKind};

/// The local database lives in the app's private data directory on every platform.
/// Schema changes ship as new numbered migrations; existing files are never edited.
pub const LOCAL_DATABASE: &str = "sqlite:billieweather.db";

fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "initial local schema",
        sql: include_str!("../migrations/0001_initial.sql"),
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(LOCAL_DATABASE, migrations())
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            session::session_load,
            session::session_save,
            session::session_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running BillieWeather");
}
