#![cfg(target_os = "macos")]

use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

async fn real_vision(bytes: &[u8]) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_billieweather"))
        .args(["--billie-vision-worker", "en-US,zh-Hans,zh-Hant", "1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let output = tokio::time::timeout(Duration::from_secs(18), async {
        stdin.write_all(bytes).await.unwrap();
        drop(stdin);
        child.wait_with_output().await.unwrap()
    })
    .await
    .expect("Apple Vision worker exceeded the application deadline");
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

/// The app prepares the models first (src/ocr/preparation.rs): the first read under a process
/// identity compiles the models, which takes longer than one recognition may.
async fn prepare() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_billieweather"))
        .arg("--billie-vision-prepare")
        .stdin(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let _open = child.stdin.take();
    let status = tokio::time::timeout(Duration::from_secs(185), child.wait())
        .await
        .expect("preparation exceeded its own limit")
        .unwrap();
    assert!(status.success());
}

#[test]
fn preparation_stops_when_the_app_is_gone() {
    tauri::async_runtime::block_on(async {
        let mut child = Command::new(env!("CARGO_BIN_EXE_billieweather"))
            .arg("--billie-vision-prepare")
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        drop(child.stdin.take());
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait()).await.expect("orphan kept running");
        assert!(!status.unwrap().success());
    });
}

#[test]
fn recognizes_a_synthetic_statement_through_ffi_and_recovers_after_bad_input() {
    tauri::async_runtime::block_on(async {
        prepare().await;
        let bad = real_vision(b"not an image").await;
        assert_eq!(bad["errors"][0]["code"], "decode_failed");

        let image = include_bytes!("../../test/ocr-fixtures/us-debit-credit.png");
        let result = real_vision(image).await;
        assert_eq!(result["engine"]["id"], "apple-vision");
        let lines: Vec<&str> = result["pages"][0]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line["text"].as_str().unwrap())
            .collect();
        assert!(lines.contains(&"Synthetic Bank"), "{lines:?}");
        assert!(lines.contains(&"1,286.04"), "{lines:?}");
    });
}

#[test]
fn an_unknown_worker_argument_never_opens_the_app() {
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_billieweather"))
        .arg("--billie-not-a-worker")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));
}
