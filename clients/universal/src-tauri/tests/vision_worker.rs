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

#[test]
fn recognizes_a_synthetic_statement_through_ffi_and_recovers_after_bad_input() {
    tauri::async_runtime::block_on(async {
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
