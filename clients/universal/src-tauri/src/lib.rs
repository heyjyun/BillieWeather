mod device;
mod identity;
mod ocr;
mod session;
mod snapshot;
mod startup;
mod transaction;
mod variant;

#[cfg(target_os = "macos")]
pub use ocr::{run_prepare as run_vision_prepare, run_worker as run_vision_worker};

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
        Migration {
            version: 10,
            description: "editing history for undo and redo",
            sql: include_str!("../migrations/0010_editing_history.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

// SQLx and this probe link to the same SQLite library (unique Cargo `links = "sqlite3"`).
pub fn sqlite_version() -> String {
    // The SQLite library owns these static NUL-terminated strings for the process lifetime.
    unsafe {
        let version = std::ffi::CStr::from_ptr(libsqlite3_sys::sqlite3_libversion());
        let source = std::ffi::CStr::from_ptr(libsqlite3_sys::sqlite3_sourceid());
        format!("{} {}", version.to_string_lossy(), source.to_string_lossy())
    }
}

fn context() -> tauri::Context {
    tauri::generate_context!()
}

/// For `--billie-identity` (scripts/qa.mjs): what this build would open, without opening it.
pub fn identity_report() -> String {
    variant::report(context().config()).to_string() + "\n"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = context();
    variant::enforce(context.config());
    assert!(
        unsafe { libsqlite3_sys::sqlite3_libversion_number() } >= 3_054_000,
        "The runtime SQLite requires version 3.54.0 or newer"
    );
    let mut sql = tauri_plugin_sql::Builder::default();
    for slot in 1..=MAX_DATABASES {
        sql = sql.add_migrations(&slot_file(slot), migrations());
    }
    tauri::Builder::default()
        .setup(|app| {
            // Before any database is opened (and migrated) by the web view: copy every slot file
            // whose schema is about to change. Refuse startup if protection fails: otherwise the
            // SQL plugin could migrate the only copy. Says so in a system alert, without data paths.
            use tauri::Manager;
            let dir = app.path().app_config_dir()?;
            let files: Vec<String> = (1..=MAX_DATABASES).map(slot_name).collect();
            variant::check_data_dir(&dir, &app.config().identifier, &files).map_err(std::io::Error::other)?;
            // Phones run one process per app; on desktops a second copy would share the databases.
            #[cfg(desktop)]
            match startup::hold_data_dir(&dir, std::time::Duration::from_secs(3)) {
                Ok(lock) => { app.manage(lock); }
                Err(()) => startup::explain_already_open(),
            }
            snapshot::keep_private(&dir);
            let version = migrations().len() as u32;
            for slot in 1..=MAX_DATABASES {
                if snapshot::snapshot_if_needed(&dir, &slot_name(slot), version).is_err() {
                    startup::explain_unprotected();
                }
            }
            Ok(())
        })
        .manage(ocr::VisionJobs::default())
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
            ocr::ocr_prepare,
            ocr::ocr_recognize_image,
            ocr::ocr_cancel_image,
            session::session_load,
            session::session_save,
            session::session_clear,
            snapshot_list,
            snapshot_restore,
            db_transaction,
            db_snapshot
        ])
        .run(context)
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
mod history_tests;

#[cfg(test)]
mod tests {
    use super::slot_file;
    use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::SqlSafeStr;

    pub(crate) fn migrator() -> Migrator {
        let list: Vec<SqlxMigration> = super::migrations()
            .into_iter()
            .map(|migration| SqlxMigration::new(
                migration.version, migration.description.into(), MigrationType::ReversibleUp,
                migration.sql.into_sql_str(), false,
            ))
            .collect();
        Migrator { migrations: list.into(), ..Migrator::DEFAULT }
    }

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
        let dir = std::env::temp_dir().join(format!("bw-fresh-slots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        tauri::async_runtime::block_on(async {
            for slot in 1..=super::MAX_DATABASES {
                let path = dir.join(super::slot_name(slot));
                assert!(!path.exists());
                let options = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
                let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
                migrator().run(&pool).await.unwrap_or_else(|e| panic!("slot {slot}: {e}"));
                let runtime: String = sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&pool).await.unwrap();
                assert_eq!(super::sqlite_version().split_whitespace().next(), Some(runtime.as_str()));
                assert!(unsafe { libsqlite3_sys::sqlite3_libversion_number() } >= 3_054_000);
                let (applied,): (i64,) = sqlx::query_as("SELECT count(*) FROM _sqlx_migrations WHERE success").fetch_one(&pool).await.unwrap();
                assert_eq!(applied as usize, super::migrations().len(), "slot {slot}");
                pool.close().await;
                assert!(path.is_file());
            }
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn preserves_prior_sqlx_migration_history_and_financial_rows() {
        let path = std::env::temp_dir().join(format!("bw-prior-slot-{}.db", std::process::id()));
        tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
            let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
            sqlx::raw_sql(include_str!("../migrations/0001_initial.sql")).execute(&pool).await.unwrap();
            sqlx::raw_sql("
                CREATE TABLE _sqlx_migrations (
                    version BIGINT PRIMARY KEY, description TEXT NOT NULL,
                    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL
                );
                INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                VALUES (1, 'initial local schema', 1,
                    X'AFA78FAD11642B7404627C1F79EEBF98BCF424717DB5EAF45C411A071F15C347D0073152587E7926292CC1A892AF0163', 123);
                INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at)
                VALUES (1, 'synthetic.csv', 'USD', 'synthetic-fixture', 1, '2026-11-20');
                INSERT INTO transactions (id, statement_id, booked_on, description, amount_cents, category, updated_at)
                VALUES (12, 1, '2026-11-20', 'Synthetic transfer input', -1025, 'Transfers', '2026-11-20');
            ").execute(&pool).await.unwrap();
            pool.close().await;

            let options = SqliteConnectOptions::new().filename(&path);
            let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
            let migrator = migrator();
            migrator.run(&pool).await.unwrap();
            migrator.run(&pool).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(count as usize, super::migrations().len());
            let first_time: i64 = sqlx::query_scalar("SELECT execution_time FROM _sqlx_migrations WHERE version = 1")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(first_time, 123);
            let entry: (i64, String, String, String) = sqlx::query_as(
                "SELECT t.amount_cents, t.booked_on, s.filename, s.currency FROM transactions t
                 JOIN statements s ON s.id = t.statement_id WHERE t.id = 12"
            ).fetch_one(&pool).await.unwrap();
            assert_eq!(entry, (-1025, "2026-11-20".into(), "synthetic.csv".into(), "USD".into()));
            assert!(sqlx::query("PRAGMA foreign_key_check").fetch_all(&pool).await.unwrap().is_empty());
            let integrity: String = sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&pool).await.unwrap();
            assert_eq!(integrity, "ok");
            pool.close().await;
        });
        std::fs::remove_file(path).unwrap();
    }

    fn book(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("bw-{name}-{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        path
    }

    async fn filled(path: &std::path::Path) -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect_with(SqliteConnectOptions::new().filename(path).create_if_missing(true)).await.unwrap();
        migrator().run(&pool).await.unwrap();
        sqlx::raw_sql("INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at) VALUES (1, 's.csv', 'USD', 's', 1, '2026-11-20');
            INSERT INTO transactions (id, statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1, 1, '2026-11-20', 'Synthetic', -1025, 'Shopping', '2026-11-20');")
            .execute(&pool).await.unwrap();
        pool
    }

    async fn schema(pool: &sqlx::SqlitePool) -> Vec<(String,)> {
        sqlx::query_as("SELECT COALESCE(sql, name) FROM sqlite_master ORDER BY type, name").fetch_all(pool).await.unwrap()
    }

    /// An update whose migration fails leaves the old schema and every row, and can be fixed by a later update.
    #[test]
    fn a_failing_migration_changes_nothing_and_can_be_retried() {
        let path = book("failing-migration");
        tauri::async_runtime::block_on(async {
            let pool = filled(&path).await;
            let before = schema(&pool).await;
            let with = |sql: &'static str| {
                let mut list = migrator().migrations.to_vec();
                list.push(SqlxMigration::new(super::migrations().len() as i64 + 1, "next".into(), MigrationType::ReversibleUp, sql.into_sql_str(), false));
                Migrator { migrations: list.into(), ..Migrator::DEFAULT }
            };
            let broken = with("ALTER TABLE transactions ADD COLUMN half TEXT; UPDATE transactions SET description = 'damaged'; INSERT INTO no_such_table VALUES (1);");
            assert!(broken.run(&pool).await.is_err());
            assert_eq!(schema(&pool).await, before);
            let row: (String, i64) = sqlx::query_as("SELECT description, amount_cents FROM transactions").fetch_one(&pool).await.unwrap();
            assert_eq!(row, ("Synthetic".into(), -1025));
            // The version that is installed now still opens the book…
            migrator().run(&pool).await.unwrap();
            // …and so does the corrected update.
            with("ALTER TABLE transactions ADD COLUMN whole TEXT;").run(&pool).await.unwrap();
            assert!(sqlx::query("SELECT whole FROM transactions").fetch_all(&pool).await.is_ok());
            // Going back to the old version afterwards is refused, and the book stays as it is.
            let refused = migrator().run(&pool).await.unwrap_err().to_string();
            assert!(refused.contains("previously applied but is missing"), "{refused}");
            let rows: (i64,) = sqlx::query_as("SELECT count(*) FROM transactions WHERE amount_cents = -1025").fetch_one(&pool).await.unwrap();
            assert_eq!(rows.0, 1);
            pool.close().await;
        });
        let _ = std::fs::remove_file(path);
    }

    /// Version 10 itself: stopped in the middle it leaves the version 9 book exactly as it was, and succeeds later.
    #[test]
    fn the_history_migration_applies_whole_or_not_at_all() {
        let path = book("history-migration");
        tauri::async_runtime::block_on(async {
            let nine = Migrator { migrations: migrator().migrations.iter().filter(|migration| migration.version <= 9).cloned().collect::<Vec<_>>().into(), ..Migrator::DEFAULT };
            let pool = sqlx::SqlitePool::connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true)).await.unwrap();
            nine.run(&pool).await.unwrap();
            sqlx::raw_sql("INSERT INTO statements (id, filename, currency, sha256, transaction_count, imported_at) VALUES (1, 's.csv', 'USD', 's', 1, '2026-11-20');
                INSERT INTO transactions (id, statement_id, booked_on, description, amount_cents, category, updated_at) VALUES (1, 1, '2026-11-20', 'Synthetic', -1025, 'Shopping', '2026-11-20');
                CREATE TRIGGER history_budgets_delete BEFORE DELETE ON budgets BEGIN SELECT 1; END;")
                .execute(&pool).await.unwrap();
            let before = schema(&pool).await;
            // Nearly the last statement of the migration fails: its tables and other triggers must not stay.
            assert!(migrator().run(&pool).await.is_err());
            assert_eq!(schema(&pool).await, before);
            nine.run(&pool).await.unwrap();
            sqlx::raw_sql("DROP TRIGGER history_budgets_delete").execute(&pool).await.unwrap();
            migrator().run(&pool).await.unwrap();
            let row: (String, i64, i64) = sqlx::query_as("SELECT description, amount_cents, (SELECT count(*) FROM history_groups) FROM transactions").fetch_one(&pool).await.unwrap();
            assert_eq!(row, ("Synthetic".into(), -1025, 0));
            assert!(nine.run(&pool).await.unwrap_err().to_string().contains("previously applied but is missing"));
            pool.close().await;
        });
        let _ = std::fs::remove_file(path);
    }

    /// Downgrade fence (audit A-01): a schema-10 book is refused by a build that only knows versions
    /// 1-9, on every attempt, and keeps its rows. The SQL plugin now runs the migrator on every load
    /// (vendor/tauri-plugin-sql/src/commands.rs), so a retry meets this same refusal.
    #[test]
    fn an_older_build_refuses_a_current_book_on_every_attempt() {
        let path = book("downgrade-fence");
        tauri::async_runtime::block_on(async {
            let pool = filled(&path).await;
            let older = Migrator { migrations: migrator().migrations.iter().filter(|migration| migration.version < super::migrations().len() as i64).cloned().collect::<Vec<_>>().into(), ..Migrator::DEFAULT };
            let before = schema(&pool).await;
            for _ in 0..3 {
                let refused = older.run(&pool).await.unwrap_err().to_string();
                assert!(refused.contains("previously applied but is missing"), "{refused}");
            }
            assert_eq!(schema(&pool).await, before);
            let (rows,): (i64,) = sqlx::query_as("SELECT count(*) FROM transactions WHERE amount_cents = -1025").fetch_one(&pool).await.unwrap();
            assert_eq!(rows, 1);
            migrator().run(&pool).await.unwrap();
            pool.close().await;
        });
        let _ = std::fs::remove_file(path);
    }

    /// A damaged file is reported, never replaced by an empty book.
    #[test]
    fn a_damaged_file_is_reported_and_left_untouched() {
        let path = book("damaged");
        let bytes = vec![0x5a_u8; 8192];
        std::fs::write(&path, &bytes).unwrap();
        tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
            let error = match sqlx::SqlitePool::connect_with(options).await {
                Ok(pool) => migrator().run(&pool).await.unwrap_err().to_string(),
                Err(error) => error.to_string(),
            };
            assert!(error.contains("not a database"), "{error}");
        });
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let _ = std::fs::remove_file(path);
    }
}
