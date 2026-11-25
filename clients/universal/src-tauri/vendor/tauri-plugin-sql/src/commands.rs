// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
use sqlx::migrate::Migrator;
use tauri::{AppHandle, Runtime, State, command};

use std::collections::HashMap;

use crate::{DbInstances, DbPool, Error, LastInsertId, Migration, MigrationKind, MigrationList, Migrations};

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct LoadOptions {
    pub auto_create: bool,
}

impl Default for LoadOptions {
    fn default() -> Self {
        Self { auto_create: true }
    }
}

#[command]
pub(crate) async fn load<R: Runtime>(
    app: AppHandle<R>,
    db_instances: State<'_, DbInstances>,
    migrations: State<'_, Migrations>,
    db: String,
    options: Option<LoadOptions>,
) -> Result<String, crate::Error> {
    let options = options.unwrap_or_default();
    // BillieWeather patch (audit A-01, A-14): only a database registered with migrations may be
    // opened, and its migrations stay registered. Upstream removed them before running them, so a
    // second `load` after a failed migration (a newer book opened by an older build, a locked or full
    // disk) connected without migrating or checking. Now every `load` runs the migrator, which applies
    // what is pending or refuses a book that is newer than this build. The lock is held while
    // migrating, so two loads never migrate the same file at the same time.
    let registered = migrations.0.lock().await;
    let list = registered_migrations(&registered, &db)?;
    let pool = DbPool::connect(&db, &app, options.auto_create).await?;
    migrate_registered(&pool, list).await?;
    drop(registered);

    db_instances.0.write().await.insert(db.clone(), pool);

    Ok(db)
}

/// The migrations registered for `db`, or an error when it was never registered (the app may only open
/// the databases it declared; any other connection string, including other paths, is refused).
pub(crate) fn registered_migrations<'a>(registered: &'a HashMap<String, MigrationList>, db: &str) -> Result<&'a MigrationList, crate::Error> {
    registered.get(db).ok_or_else(|| crate::Error::InvalidDbUrl(db.to_string()))
}

/// Runs a copy of `list` on `pool`; the registered list itself is kept for the next load.
pub(crate) async fn migrate_registered(pool: &DbPool, list: &MigrationList) -> Result<(), crate::Error> {
    let copy = MigrationList(
        list.0
            .iter()
            .map(|migration| Migration {
                version: migration.version,
                description: migration.description,
                sql: migration.sql,
                kind: match migration.kind {
                    MigrationKind::Up => MigrationKind::Up,
                    MigrationKind::Down => MigrationKind::Down,
                },
            })
            .collect(),
    );
    let migrator = Migrator::new(copy).await?;
    pool.migrate(&migrator).await
}

/// Allows the database connection(s) to be closed; if no database
/// name is passed in then _all_ database connection pools will be
/// shut down.
#[command]
pub(crate) async fn close(
    db_instances: State<'_, DbInstances>,
    db: Option<String>,
) -> Result<bool, crate::Error> {
    let instances = db_instances.0.read().await;

    let pools = if let Some(db) = db {
        vec![db]
    } else {
        instances.keys().cloned().collect()
    };

    for pool in pools {
        let db = instances.get(&pool).ok_or(Error::DatabaseNotLoaded(pool))?;
        db.close().await;
    }

    Ok(true)
}

/// Execute a command against the database
#[command]
pub(crate) async fn execute(
    db_instances: State<'_, DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<(u64, LastInsertId), crate::Error> {
    let instances = db_instances.0.read().await;

    let db = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db))?;
    db.execute(query, values).await
}

#[command]
pub(crate) async fn select(
    db_instances: State<'_, DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<IndexMap<String, JsonValue>>, crate::Error> {
    let instances = db_instances.0.read().await;

    let db = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db))?;
    db.select(query, values).await
}

#[cfg(all(test, feature = "sqlite"))]
mod tests {
    use super::{migrate_registered, registered_migrations};
    use crate::{DbPool, Migration, MigrationKind, MigrationList};
    use std::collections::HashMap;

    fn up(version: i64, sql: &'static str) -> Migration {
        Migration { version, description: "test", sql, kind: MigrationKind::Up }
    }

    fn temp_pool(name: &str) -> (std::path::PathBuf, DbPool) {
        let path = std::env::temp_dir().join(format!("bw-plugin-{name}-{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
        let pool = tauri::async_runtime::block_on(sqlx::SqlitePool::connect_with(options)).unwrap();
        (path, DbPool::Sqlite(pool))
    }

    /// Audit A-14: a connection string that was never registered is refused before anything is opened.
    #[test]
    fn unregistered_databases_are_refused() {
        let mut registered = HashMap::new();
        registered.insert("sqlite:billieweather.db".to_string(), MigrationList(vec![up(1, "CREATE TABLE t (id INTEGER);")]));
        assert!(registered_migrations(&registered, "sqlite:billieweather.db").is_ok());
        for other in ["sqlite:../billieweather.db", "sqlite:other.db", "sqlite:/tmp/billieweather.db"] {
            assert!(registered_migrations(&registered, other).is_err(), "{other}");
        }
    }

    /// Audit A-01: a failed migration keeps its migrations registered, so loading again migrates again
    /// (and fails again while the cause remains) instead of opening the book unmigrated.
    #[test]
    fn a_second_load_after_a_failed_migration_still_migrates() {
        let (path, pool) = temp_pool("retry");
        let broken = MigrationList(vec![up(1, "CREATE TABLE t (id INTEGER);"), up(2, "INSERT INTO no_such_table VALUES (1);")]);
        tauri::async_runtime::block_on(async {
            assert!(migrate_registered(&pool, &broken).await.is_err());
            assert!(migrate_registered(&pool, &broken).await.is_err(), "the retry must not skip the migrations");
            let DbPool::Sqlite(sqlite) = &pool;
            let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success").fetch_one(sqlite).await.unwrap();
            assert_eq!(applied, 1);
            let fixed = MigrationList(vec![up(1, "CREATE TABLE t (id INTEGER);"), up(2, "CREATE TABLE u (id INTEGER);")]);
            migrate_registered(&pool, &fixed).await.unwrap();
            migrate_registered(&pool, &fixed).await.unwrap();
            sqlite.close().await;
        });
        let _ = std::fs::remove_file(path);
    }

    /// Audit A-01 downgrade fence: a book migrated by a newer build is refused by an older list on
    /// every load, not only on the first.
    #[test]
    fn an_older_build_refuses_a_newer_book_on_every_load() {
        let (path, pool) = temp_pool("downgrade");
        let newer = MigrationList(vec![up(1, "CREATE TABLE t (id INTEGER);"), up(2, "CREATE TABLE u (id INTEGER);")]);
        let older = MigrationList(vec![up(1, "CREATE TABLE t (id INTEGER);")]);
        tauri::async_runtime::block_on(async {
            migrate_registered(&pool, &newer).await.unwrap();
            for _ in 0..2 {
                let refused = migrate_registered(&pool, &older).await.unwrap_err().to_string();
                assert!(refused.contains("previously applied but is missing"), "{refused}");
            }
            let DbPool::Sqlite(sqlite) = &pool;
            sqlite.close().await;
        });
        let _ = std::fs::remove_file(path);
    }
}
