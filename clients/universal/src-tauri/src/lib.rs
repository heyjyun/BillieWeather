mod device;
mod identity;
mod ocr;
mod session;
mod snapshot;
mod transaction;

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
        Migration {
            version: 8,
            description: "refund integrity on edits, links and restore",
            sql: include_str!("../migrations/0008_refund_integrity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "refund guard independent of insert helpers, derived link amounts, lookup indexes",
            sql: include_str!("../migrations/0009_refund_guard_and_link_hygiene.sql"),
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
            // whose schema is about to change. Refuse startup if protection fails: otherwise the
            // SQL plugin could migrate the only copy. Report a generic error without data paths.
            use tauri::Manager;
            let dir = app.path().app_config_dir()?;
            let version = migrations().len() as u32;
            for slot in 1..=MAX_DATABASES {
                snapshot::snapshot_if_needed(&dir, &slot_name(slot), version)
                    .map_err(|_| std::io::Error::other("Could not protect the local database before migration"))?;
            }
            Ok(())
        })
        .plugin(sql.build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
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
            snapshot_restore,
            db_transaction,
            db_snapshot
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

/// The plugin's pool for one of this app's database slots (only after the web view loaded it).
async fn slot_pool(instances: &tauri_plugin_sql::DbInstances, db: &str) -> Result<sqlx::SqlitePool, String> {
    if !(1..=MAX_DATABASES).any(|slot| slot_file(slot) == db) {
        return Err("unknown database".into());
    }
    let pools = instances.0.read().await;
    #[allow(unreachable_patterns)]
    match pools.get(db) {
        Some(tauri_plugin_sql::DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err("database not loaded".into()),
    }
}

/// Runs the statements in ONE transaction on one connection: all of them apply or none
/// (src/transaction.rs). SQLite's own message is returned so trigger codes reach the app.
#[tauri::command]
async fn db_transaction(instances: tauri::State<'_, tauri_plugin_sql::DbInstances>, db: String, statements: Vec<transaction::Statement>) -> Result<Vec<transaction::Outcome>, String> {
    let pool = slot_pool(&instances, &db).await?;
    transaction::execute_all(&pool, &statements).await.map_err(|error| error.to_string())
}

/// Answers the queries from one read transaction, so a backup describes a single instant.
#[tauri::command]
async fn db_snapshot(instances: tauri::State<'_, tauri_plugin_sql::DbInstances>, db: String, queries: Vec<transaction::Statement>) -> Result<Vec<Vec<serde_json::Map<String, serde_json::Value>>>, String> {
    let pool = slot_pool(&instances, &db).await?;
    transaction::select_all(&pool, &queries).await.map_err(|error| error.to_string())
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

    /// Every slot is created from nothing with the full migration chain, the way the SQL plugin
    /// does it (sqlx, each migration in its own transaction, `create_if_missing`), in a temp folder.
    #[test]
    fn fresh_slot_files_are_created_and_fully_migrated() {
        use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
        use sqlx::sqlite::SqliteConnectOptions;
        let dir = std::env::temp_dir().join(format!("bw-fresh-slots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        tauri::async_runtime::block_on(async {
            for slot in 1..=super::MAX_DATABASES {
                let path = dir.join(super::slot_name(slot));
                assert!(!path.exists());
                let options = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
                let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
                let list: Vec<SqlxMigration> = super::migrations()
                    .into_iter()
                    .map(|m| SqlxMigration::new(m.version, m.description.into(), MigrationType::ReversibleUp, m.sql.into(), false))
                    .collect();
                let migrator = Migrator { migrations: list.into(), ..Migrator::DEFAULT };
                migrator.run(&pool).await.unwrap_or_else(|e| panic!("slot {slot}: {e}"));
                let (applied,): (i64,) = sqlx::query_as("SELECT count(*) FROM _sqlx_migrations WHERE success").fetch_one(&pool).await.unwrap();
                assert_eq!(applied as usize, super::migrations().len(), "slot {slot}");
                pool.close().await;
                assert!(path.is_file());
            }
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
