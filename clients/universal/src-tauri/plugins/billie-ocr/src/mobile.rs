use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{RecognizeRequest, Result};

/// Package of `OcrPlugin.kt` (must match `namespace` in android/build.gradle.kts).
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.billieweather.ocr";

// Symbol exported by `@_cdecl("init_plugin_billie_ocr")` in ios/Sources/OcrPlugin.swift.
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_billie_ocr);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<BillieOcr<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "OcrPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_billie_ocr)?;
    Ok(BillieOcr(handle))
}

pub struct BillieOcr<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Clone for BillieOcr<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> BillieOcr<R> {
    /// Blocks until the native plugin resolves. Returns the contract JSON untouched.
    pub fn recognize(&self, request: RecognizeRequest) -> Result<serde_json::Value> {
        Ok(self.0.run_mobile_plugin::<serde_json::Value>("recognize", request)?)
    }
}
