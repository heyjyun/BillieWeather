//! The device's human name ("Jyun's MacBook Pro", "DESKTOP-4F2K", "Pixel 8"), offered as
//! the default name of this device's local database. Read-only, never sent anywhere.
//! Returns None when the platform gives nothing useful; the UI then falls back to a
//! generic label ("iPhone", "Android phone", …).

#[cfg(not(any(target_os = "ios", target_os = "android")))]
use std::process::Command;

fn clean(value: impl AsRef<str>) -> Option<String> {
    let text = value.as_ref().trim().trim_end_matches(".local").trim();
    (!text.is_empty() && text != "localhost").then(|| text.to_string())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned()).and_then(clean)
}

#[cfg(target_os = "macos")]
fn read() -> Option<String> {
    // The name shown in System Settings › General › Sharing, with spaces and apostrophes.
    output("/usr/sbin/scutil", &["--get", "ComputerName"]).or_else(|| output("/bin/hostname", &["-s"]))
}

#[cfg(target_os = "windows")]
fn read() -> Option<String> {
    std::env::var("COMPUTERNAME").ok().and_then(clean).or_else(|| output("hostname", &[]))
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios", target_os = "android"))))]
fn read() -> Option<String> {
    std::fs::read_to_string("/etc/hostname").ok().and_then(clean).or_else(|| output("hostname", &[]))
}

#[cfg(target_os = "android")]
fn read() -> Option<String> {
    // Marketing name ("Galaxy S24") where the vendor sets one, else the model ("Pixel 8").
    ["ro.product.marketname", "ro.product.vendor.marketname", "ro.product.model"].iter().find_map(|key| {
        let out = std::process::Command::new("/system/bin/getprop").arg(key).output().ok()?;
        clean(String::from_utf8_lossy(&out.stdout))
    })
}

#[cfg(target_os = "ios")]
fn read() -> Option<String> {
    // iOS 16+ only reveals the user-assigned name with a special entitlement, so the UI
    // uses "iPhone" / "iPad" from the WebView instead.
    None
}

#[tauri::command]
pub fn device_name() -> Option<String> {
    read().map(|name| name.chars().take(60).collect())
}
