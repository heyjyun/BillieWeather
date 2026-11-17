//! Atomic multi-statement writes and point-in-time multi-query reads on a local database.
//!
//! The SQL plugin hands every statement to a connection pool, so the web view cannot hold a
//! transaction open across calls: `BEGIN` and `COMMIT` may run on different connections. Financial
//! operations that touch several rows or tables (a restore, a multi-account import, deleting
//! everything, renaming a category across tables) therefore send their statements as ONE batch to
//! the commands in this module, which run them on a single pooled connection inside one SQLite
//! transaction: every statement applies or none does, also when the app is killed half-way.
//!
//! Reads for a backup go through `select_all`, which answers all queries from one read
//! transaction, so the exported tables describe the same instant even while something else writes.
//!
//! The pool is the plugin's own (same file, same pragmas, foreign keys on), so these commands and
//! the plugin's single statements serialize through SQLite's normal locking.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use sqlx::sqlite::{SqliteArguments, SqliteRow};
use sqlx::{Column, Row, Sqlite, SqlitePool, TypeInfo, ValueRef};

/// The most statements one batch may carry (a 20,000-row import stages 50 rows per statement).
pub const MAX_STATEMENTS: usize = 5_000;

#[derive(Deserialize, Debug, Clone)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<JsonValue>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

/// Binds JSON parameters with their natural SQLite type. Whole numbers are bound as integers
/// (money is integer cents), never as floating point.
fn bind(statement: &Statement) -> sqlx::query::Query<'_, Sqlite, SqliteArguments<'_>> {
    let mut query = sqlx::query(&statement.sql);
    for value in &statement.params {
        query = match value {
            JsonValue::Null => query.bind(None::<String>),
            JsonValue::Bool(flag) => query.bind(i64::from(*flag)),
            JsonValue::Number(number) => match number.as_i64() {
                Some(whole) => query.bind(whole),
                None => query.bind(number.as_f64().unwrap_or_default()),
            },
            JsonValue::String(text) => query.bind(text.as_str()),
            other => query.bind(other.to_string()),
        };
    }
    query
}

/// Runs every statement in one `BEGIN IMMEDIATE` transaction. Any failure rolls all of them back.
/// A later statement can refer to an earlier insert with `last_insert_rowid()`.
pub async fn execute_all(pool: &SqlitePool, statements: &[Statement]) -> Result<Vec<Outcome>, sqlx::Error> {
    if statements.len() > MAX_STATEMENTS {
        return Err(sqlx::Error::Protocol("too many statements in one transaction".into()));
    }
    // IMMEDIATE takes the write lock up front, so the batch never fails half-way on a lock upgrade.
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut outcomes = Vec::with_capacity(statements.len());
    for statement in statements {
        // Returning early drops the transaction, which rolls it back.
        let result = bind(statement).execute(&mut *transaction).await?;
        outcomes.push(Outcome { rows_affected: result.rows_affected(), last_insert_id: result.last_insert_rowid() });
    }
    transaction.commit().await?;
    Ok(outcomes)
}

/// Answers every query from one read transaction (one consistent point in time).
pub async fn select_all(pool: &SqlitePool, queries: &[Statement]) -> Result<Vec<Vec<Map<String, JsonValue>>>, sqlx::Error> {
    if queries.len() > MAX_STATEMENTS {
        return Err(sqlx::Error::Protocol("too many statements in one transaction".into()));
    }
    let mut transaction = pool.begin().await?;
    let mut results = Vec::with_capacity(queries.len());
    for query in queries {
        let rows = bind(query).fetch_all(&mut *transaction).await?;
        results.push(rows.iter().map(row_to_json).collect::<Result<Vec<_>, _>>()?);
    }
    transaction.rollback().await?;
    Ok(results)
}

fn row_to_json(row: &SqliteRow) -> Result<Map<String, JsonValue>, sqlx::Error> {
    let mut object = Map::with_capacity(row.columns().len());
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(index)?;
        let value = if raw.is_null() {
            JsonValue::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" | "NUMERIC" | "BOOLEAN" => JsonValue::from(row.try_get::<i64, _>(index)?),
                "REAL" => JsonValue::from(row.try_get::<f64, _>(index)?),
                "BLOB" => JsonValue::from(row.try_get::<Vec<u8>, _>(index)?),
                _ => JsonValue::String(row.try_get::<String, _>(index)?),
            }
        };
        object.insert(column.name().to_string(), value);
    }
    Ok(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    fn statement(sql: &str, params: JsonValue) -> Statement {
        Statement { sql: sql.to_string(), params: params.as_array().cloned().unwrap_or_default() }
    }

    /// A file-backed pool with several connections, like the app's (an in-memory database would
    /// give every connection its own data).
    async fn pool(name: &str) -> SqlitePool {
        let path = std::env::temp_dir().join(format!("bw-transaction-test-{name}-{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true))
            .await
            .unwrap();
        execute_all(&pool, &[
            statement("CREATE TABLE statements (id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE)", json!([])),
            statement("CREATE TABLE transactions (id INTEGER PRIMARY KEY, statement_id INTEGER NOT NULL REFERENCES statements(id), amount_cents INTEGER NOT NULL, note)", json!([])),
        ]).await.unwrap();
        pool
    }

    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")).fetch_one(pool).await.unwrap()
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn a_failing_statement_rolls_back_every_earlier_one() {
        run(async {
            let pool = pool("rollback").await;
            let error = execute_all(&pool, &[
                statement("INSERT INTO statements (sha256) VALUES (?)", json!(["a"])),
                statement("INSERT INTO transactions (statement_id, amount_cents) VALUES (last_insert_rowid(), ?)", json!([-1250])),
                // Violates the UNIQUE constraint: the two inserts above must disappear with it.
                statement("INSERT INTO statements (sha256) VALUES (?)", json!(["a"])),
            ]).await;
            assert!(error.is_err());
            assert_eq!((count(&pool, "statements").await, count(&pool, "transactions").await), (0, 0));
            // The pool is usable afterwards and holds no half-open transaction.
            let done = execute_all(&pool, &[statement("INSERT INTO statements (sha256) VALUES (?)", json!(["a"]))]).await.unwrap();
            assert_eq!(done, vec![Outcome { rows_affected: 1, last_insert_id: 1 }]);
        });
    }

    #[test]
    fn statements_share_one_connection_and_foreign_keys_are_enforced() {
        run(async {
            let pool = pool("chain").await;
            let outcomes = execute_all(&pool, &[
                statement("INSERT INTO statements (sha256) VALUES ($1)", json!(["a"])),
                statement("INSERT INTO transactions (statement_id, amount_cents) VALUES (last_insert_rowid(), $1)", json!([4200])),
            ]).await.unwrap();
            assert_eq!(outcomes[0].last_insert_id, 1);
            assert_eq!(count(&pool, "transactions").await, 1);
            let orphan = execute_all(&pool, &[statement("INSERT INTO transactions (statement_id, amount_cents) VALUES (99, 1)", json!([]))]).await;
            assert!(orphan.is_err(), "an entry cannot point at a statement that does not exist");
        });
    }

    #[test]
    fn whole_numbers_are_stored_as_integers_and_read_back_exactly() {
        run(async {
            let pool = pool("types").await;
            execute_all(&pool, &[
                statement("INSERT INTO statements (sha256) VALUES ('a')", json!([])),
                // `note` has no declared type, so it keeps exactly what was bound.
                statement("INSERT INTO transactions (statement_id, amount_cents, note) VALUES (1, ?, ?)", json!([900_719_925_474_099_i64, 12])),
                statement("INSERT INTO transactions (statement_id, amount_cents, note) VALUES (1, ?, ?)", json!([-5, "text"])),
                statement("INSERT INTO transactions (statement_id, amount_cents, note) VALUES (1, ?, ?)", json!([0, null])),
                statement("INSERT INTO transactions (statement_id, amount_cents, note) VALUES (1, ?, ?)", json!([1, 1.5])),
            ]).await.unwrap();
            let rows = select_all(&pool, &[statement("SELECT amount_cents, note, typeof(note) AS kind FROM transactions ORDER BY id", json!([]))]).await.unwrap();
            assert_eq!(JsonValue::from(rows[0].clone()), json!([
                {"amount_cents": 900_719_925_474_099_i64, "note": 12, "kind": "integer"},
                {"amount_cents": -5, "note": "text", "kind": "text"},
                {"amount_cents": 0, "note": null, "kind": "null"},
                {"amount_cents": 1, "note": 1.5, "kind": "real"},
            ]));
        });
    }

    #[test]
    fn a_snapshot_answers_every_query_and_refuses_oversized_batches() {
        run(async {
            let pool = pool("snapshot").await;
            execute_all(&pool, &[
                statement("INSERT INTO statements (sha256) VALUES ('a')", json!([])),
                statement("INSERT INTO transactions (statement_id, amount_cents) VALUES (1, 100), (1, -40)", json!([])),
            ]).await.unwrap();
            let results = select_all(&pool, &[
                statement("SELECT COUNT(*) AS n FROM statements", json!([])),
                statement("SELECT SUM(amount_cents) AS total FROM transactions WHERE statement_id = ?", json!([1])),
            ]).await.unwrap();
            assert_eq!(JsonValue::from(results), json!([[{"n": 1}], [{"total": 60}]]));
            let many: Vec<Statement> = (0..=MAX_STATEMENTS).map(|_| statement("SELECT 1", json!([]))).collect();
            assert!(execute_all(&pool, &many).await.is_err());
            assert!(select_all(&pool, &many).await.is_err());
        });
    }
}
