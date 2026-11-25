//! Undo and Redo on the app's own SQLite, through its own transaction command: the statements are the ones the
//! app sends (tests/fixtures/history.json, kept in step by test/historyNative.test.ts). Synthetic data only.

use crate::transaction::{execute_all, select_all, Statement};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::collections::BTreeMap;

const TABLES: [&str; 15] = [
    "settings", "accounts", "merchants", "projects", "tags", "recurring_rules", "statements", "transactions", "transaction_tags", "transaction_links",
    "custom_categories", "category_meta", "merchant_rules", "budgets", "organize_runs",
];

async fn rows(pool: &sqlx::SqlitePool, sql: &str) -> Vec<Value> {
    select_all(pool, &[Statement { sql: sql.into(), params: vec![] }]).await.unwrap().remove(0).into_iter().map(Value::Object).collect()
}

/// The whole book, without the times a replay sets.
async fn dump(pool: &sqlx::SqlitePool) -> BTreeMap<&'static str, Vec<String>> {
    let mut book = BTreeMap::new();
    for table in TABLES {
        // The hidden container of manual entries is part of the database, not of any edit.
        let only = if table == "statements" { " WHERE source_format IS NOT 'manual'" } else { "" };
        let mut list: Vec<String> = rows(pool, &format!("SELECT * FROM {table}{only}")).await.into_iter().map(|mut row| {
            row.as_object_mut().unwrap().remove("updated_at");
            row.to_string()
        }).collect();
        list.sort();
        book.insert(table, list);
    }
    book
}

async fn sound(pool: &sqlx::SqlitePool) {
    assert!(rows(pool, "SELECT * FROM pragma_foreign_key_check").await.is_empty());
    assert_eq!(rows(pool, "SELECT * FROM pragma_integrity_check").await, vec![json!({"integrity_check": "ok"})]);
    assert!(rows(pool, "SELECT id FROM statements s WHERE source_format = 'manual' AND transaction_count <> (SELECT COUNT(*) FROM transactions WHERE statement_id = s.id)").await.is_empty());
    assert_eq!(rows(pool, "SELECT group_id, replaying, conflict FROM history_state").await, vec![json!({"group_id": null, "replaying": 0, "conflict": 0})]);
}

fn params(value: &Value) -> Vec<Value> {
    value.as_array().unwrap().clone()
}

#[test]
fn recorded_edits_are_undone_and_redone_exactly_on_the_native_database() {
    let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/history.json")).unwrap();
    let path = std::env::temp_dir().join(format!("bw-history-{}.db", std::process::id()));
    let clean = || for suffix in ["", "-wal", "-shm", "-journal"] { let _ = std::fs::remove_file(format!("{}{suffix}", path.display())); };
    clean();
    let connect = || SqlitePoolOptions::new().max_connections(4).connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(true));
    let replay = |direction: &str, group: i64| -> Vec<Statement> {
        fixture["replay"][direction].as_array().unwrap().iter()
            .map(|item| Statement { sql: item[0].as_str().unwrap().replace("987654321", &group.to_string()), params: params(&item[1]) }).collect()
    };
    tauri::async_runtime::block_on(async {
        let mut pool = connect().await.unwrap();
        crate::tests::migrator().run(&pool).await.unwrap();
        // What the book was before and after every group, learned while the edits run.
        let mut states: Vec<BTreeMap<&'static str, Vec<String>>> = vec![dump(&pool).await];
        let mut groups: Vec<i64> = vec![];
        let (mut undone, mut redone) = (0, 0);
        for step in fixture["steps"].as_array().unwrap() {
            let kind = step["kind"].as_str().unwrap();
            match kind {
                "edit" | "outside" => {
                    let statements: Vec<Statement> = step["statements"].as_array().unwrap().iter()
                        .map(|item| Statement { sql: fixture["sql"][item[0].as_u64().unwrap() as usize].as_str().unwrap().into(), params: params(&item[1]) }).collect();
                    execute_all(&pool, &statements).await.unwrap_or_else(|error| panic!("{}: {error}", step["name"]));
                    if kind == "edit" {
                        let newest = rows(&pool, "SELECT MAX(id) AS id FROM history_groups").await[0]["id"].as_i64();
                        if newest.is_some() && newest != groups.last().copied() {
                            groups.push(newest.unwrap());
                            states.push(dump(&pool).await);
                        } else {
                            *states.last_mut().unwrap() = dump(&pool).await;
                        }
                    }
                }
                "undo" | "redo" => {
                    let group = step["group"].as_i64().unwrap();
                    let at = groups.iter().position(|id| *id == group).unwrap();
                    execute_all(&pool, &replay(kind, group)).await.unwrap_or_else(|error| panic!("{kind} {}: {error}", step["name"]));
                    assert_eq!(dump(&pool).await, states[if kind == "undo" { at } else { at + 1 }], "{kind} {}", step["name"]);
                    sound(&pool).await;
                    if kind == "undo" { undone += 1 } else { redone += 1 }
                    // A restart between any two steps changes nothing.
                    if (undone + redone) % 5 == 0 {
                        pool.close().await;
                        pool = connect().await.unwrap();
                    }
                }
                "refused" => {
                    let before = dump(&pool).await;
                    let error = execute_all(&pool, &replay("undo", step["group"].as_i64().unwrap())).await.unwrap_err().to_string();
                    assert!(error.contains("CHECK constraint failed: history_conflict"), "{error}");
                    assert_eq!(dump(&pool).await, before);
                    sound(&pool).await;
                }
                other => panic!("unknown step {other}"),
            }
        }
        assert!(undone > 20 && redone > 20, "{undone} undone, {redone} redone");
        pool.close().await;
    });
    clean();
}
