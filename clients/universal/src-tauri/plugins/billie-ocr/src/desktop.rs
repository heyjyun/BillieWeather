use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{Error, RecognizeRequest, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<BillieOcr<R>> {
    Ok(BillieOcr(app.clone()))
}

/// Desktop stub: desktop builds use other OCR engines, so this always refuses.
pub struct BillieOcr<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Clone for BillieOcr<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> BillieOcr<R> {
    pub fn recognize(&self, _request: RecognizeRequest) -> Result<serde_json::Value> {
        Err(Error::UnsupportedPlatform)
    }
}
