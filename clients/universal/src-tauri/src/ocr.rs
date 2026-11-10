//! On-device OCR commands. macOS: Apple Vision (ocr-apple/BillieVisionOCR.swift, linked as a
//! static library by build.rs). Other desktop systems have no native engine here: the app uses
//! the bundled Tesseract (WebAssembly) engine instead, so `ocr_capabilities` reports none.
//! Images arrive as the raw IPC body (no JSON copy) and never leave the process.

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request};

/// Larger inputs are refused before decoding (the Swift side also limits pixel count).
const MAX_IMAGE_BYTES: usize = 40 * 1024 * 1024;

#[tauri::command]
pub fn ocr_capabilities() -> Value {
    if cfg!(target_os = "macos") {
        json!({ "engine": "apple-vision", "location": "device" })
    } else {
        json!({ "engine": null })
    }
}

/// Headers: `x-ocr-languages` (comma-separated BCP 47, e.g. "en-US,zh-Hans,zh-Hant") and `x-ocr-page`.
#[tauri::command]
pub async fn ocr_recognize_image(request: Request<'_>) -> Result<Value, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image as a raw body".into());
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("too_large".into());
    }
    let header = |name: &str| request.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
    let languages = header("x-ocr-languages").unwrap_or_else(|| "en-US".into());
    let page: i32 = header("x-ocr-page").and_then(|value| value.parse().ok()).unwrap_or(1);
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || recognize(&bytes, &languages, page))
        .await
        .map_err(|_| "recognition_failed".to_string())?
}

#[cfg(target_os = "macos")]
pub fn recognize(bytes: &[u8], languages: &str, page: i32) -> Result<Value, String> {
    use std::ffi::{c_char, CStr, CString};
    extern "C" {
        fn billie_vision_recognize(bytes: *const u8, length: isize, languages: *const c_char, page: i32, out: *mut *mut c_char) -> i32;
        fn billie_vision_free(pointer: *mut c_char);
    }
    let languages = CString::new(languages.replace('\0', "")).map_err(|_| "invalid languages")?;
    let mut out: *mut c_char = std::ptr::null_mut();
    // SAFETY: the pointers are valid for the call; the Swift side copies the bytes and returns a
    // malloc'd NUL-terminated string that is freed with billie_vision_free below.
    let status = unsafe { billie_vision_recognize(bytes.as_ptr(), bytes.len() as isize, languages.as_ptr(), page, &mut out) };
    if status != 0 || out.is_null() {
        return Err("recognition_failed".into());
    }
    let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
    unsafe { billie_vision_free(out) };
    serde_json::from_str(&text).map_err(|_| "recognition_failed".into())
}

#[cfg(not(target_os = "macos"))]
pub fn recognize(_bytes: &[u8], _languages: &str, _page: i32) -> Result<Value, String> {
    Err("engine_unavailable".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// The linked Swift library recognizes a synthetic statement through the same FFI the app uses.
    #[test]
    fn recognizes_a_synthetic_statement_through_ffi() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../test/ocr-fixtures/us-debit-credit.png")).unwrap();
        let result = recognize(&bytes, "en-US,zh-Hans,zh-Hant", 1).unwrap();
        assert_eq!(result["engine"]["id"], "apple-vision");
        let lines: Vec<&str> = result["pages"][0]["lines"].as_array().unwrap().iter().map(|line| line["text"].as_str().unwrap()).collect();
        assert!(lines.contains(&"Synthetic Bank"), "{lines:?}");
        assert!(lines.contains(&"1,286.04"), "{lines:?}");
    }

    #[test]
    fn reports_undecodable_input_as_an_error() {
        let result = recognize(b"not an image", "en-US", 1).unwrap();
        assert_eq!(result["errors"][0]["code"], "decode_failed");
        assert_eq!(result["pages"].as_array().unwrap().len(), 0);
    }
}
