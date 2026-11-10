//! On-device OCR for BillieWeather's mobile builds.
//!
//! - Android: ML Kit Text Recognition v2 with the *bundled* Chinese-script model
//!   (`android/src/main/java/app/billieweather/ocr/OcrPlugin.kt`).
//! - iOS: Apple Vision, reusing the shared `ocr-apple/BillieVisionOCR.swift`
//!   (`ios/Sources/OcrPlugin.swift`).
//! - Desktop: the command exists so the frontend can call it unconditionally, but it always
//!   fails with `"unsupported_platform"`; desktop builds use their own engines.
//!
//! The command returns the shared OCR contract (see `packages/finance-core/src/universal/ocr.ts`)
//! unchanged from the native side: per-page problems (`decode_failed`, `too_large`,
//! `recognition_failed`) are reported inside `errors`, not as a rejected promise. A rejected
//! promise means the call itself failed (bad arguments, unsupported platform, plugin bridge).

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime, State,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop::BillieOcr;
#[cfg(mobile)]
use mobile::BillieOcr;

/// Arguments of `recognize`, forwarded verbatim to the native plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecognizeRequest {
    /// Base64 (standard alphabet) of the PNG/JPEG bytes of one page.
    pub image: String,
    /// Page number echoed back in `pages[].page` and `errors[].page`.
    pub page: u32,
    /// Requested languages, e.g. `["en", "zh-Hans", "zh-Hant"]`.
    #[serde(default)]
    pub languages: Vec<String>,
}

/// Errors of the call itself. Serialized to the frontend as a plain string code.
#[derive(Debug)]
pub enum Error {
    /// Desktop builds: this plugin has no desktop engine.
    UnsupportedPlatform,
    /// The native plugin rejected the call or could not be reached.
    Native(String),
    /// Plugin setup failed.
    Tauri(tauri::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::UnsupportedPlatform => f.write_str("unsupported_platform"),
            Error::Native(message) => write!(f, "native_error: {message}"),
            Error::Tauri(error) => write!(f, "tauri_error: {error}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<tauri::Error> for Error {
    fn from(error: tauri::Error) -> Self {
        Error::Tauri(error)
    }
}

#[cfg(mobile)]
impl From<tauri::plugin::mobile::PluginInvokeError> for Error {
    fn from(error: tauri::plugin::mobile::PluginInvokeError) -> Self {
        Error::Native(error.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Access from Rust: `app.billie_ocr().recognize(request)`.
pub trait BillieOcrExt<R: Runtime> {
    fn billie_ocr(&self) -> &BillieOcr<R>;
}

impl<R: Runtime, T: Manager<R>> BillieOcrExt<R> for T {
    fn billie_ocr(&self) -> &BillieOcr<R> {
        self.state::<BillieOcr<R>>().inner()
    }
}

/// `invoke('plugin:billie-ocr|recognize', { image, page, languages })`
#[tauri::command]
async fn recognize<R: Runtime>(
    // Unused, but it lets the command macro infer `R`.
    _app: AppHandle<R>,
    ocr: State<'_, BillieOcr<R>>,
    image: String,
    page: u32,
    languages: Option<Vec<String>>,
) -> Result<serde_json::Value> {
    let request = RecognizeRequest { image, page, languages: languages.unwrap_or_default() };
    let ocr = ocr.inner().clone();
    // The mobile bridge blocks until the native side resolves; keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(move || ocr.recognize(request))
        .await
        .map_err(|error| Error::Native(format!("worker failed: {error}")))?
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("billie-ocr")
        .invoke_handler(tauri::generate_handler![recognize])
        .setup(|app, api| {
            #[cfg(mobile)]
            let ocr = mobile::init(app, api)?;
            #[cfg(desktop)]
            let ocr = desktop::init(app, api)?;
            app.manage(ocr);
            Ok(())
        })
        .build()
}
