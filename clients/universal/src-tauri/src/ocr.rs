//! On-device OCR commands. macOS: Apple Vision (ocr-apple/BillieVisionOCR.swift, linked as a
//! static library by build.rs). Other desktop systems have no native engine here: the app uses
//! the bundled Tesseract (WebAssembly) engine instead, so `ocr_capabilities` reports none.
//! Images arrive as raw IPC bytes and the isolated macOS worker receives them on stdin.

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request};

#[cfg(target_os = "macos")]
mod vision_process;
#[cfg(target_os = "macos")]
pub use vision_process::{run_worker, VisionJobs};
#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct VisionJobs;

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
pub async fn ocr_recognize_image(request: Request<'_>, jobs: tauri::State<'_, VisionJobs>) -> Result<Value, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image as a raw body".into());
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("too_large".into());
    }
    #[cfg(target_os = "macos")]
    {
        let header = |name: &str| request.headers().get(name).and_then(|value| value.to_str().ok());
        let languages = header("x-ocr-languages").unwrap_or("en-US");
        let page = header("x-ocr-page").and_then(|value| value.parse().ok()).unwrap_or(1);
        let job = header("x-ocr-job-id").ok_or("recognition_failed")?;
        if languages.len() > 128 || !languages.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b',') || page < 1 {
            return Err("recognition_failed".into());
        }
        jobs.recognize(job, bytes, languages, page).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = jobs;
        Err("engine_unavailable".into())
    }
}

#[tauri::command]
pub fn ocr_cancel_image(job: &str, jobs: tauri::State<'_, VisionJobs>) {
    #[cfg(target_os = "macos")]
    jobs.cancel(job);
    #[cfg(not(target_os = "macos"))]
    let _ = (job, jobs);
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn reports_undecodable_input_as_an_error() {
        let result = recognize(b"not an image", "en-US", 1).unwrap();
        assert_eq!(result["errors"][0]["code"], "decode_failed");
        assert_eq!(result["pages"].as_array().unwrap().len(), 0);
    }
}
