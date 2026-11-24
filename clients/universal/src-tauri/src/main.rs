// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--sqlite-version")) {
        use std::io::Write;
        let version = billieweather_lib::sqlite_version() + "\n";
        let _ = std::io::stdout().lock().write_all(version.as_bytes());
        return;
    }
    #[cfg(target_os = "macos")]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--billie-vision-worker")) {
        if billieweather_lib::run_vision_worker().is_err() {
            std::process::exit(1);
        }
        return;
    }
    #[cfg(target_os = "macos")]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--billie-vision-prepare")) {
        if billieweather_lib::run_vision_prepare().is_err() {
            std::process::exit(1);
        }
        return;
    }
    // A worker argument this build does not know must never open the app (and its data) instead.
    if std::env::args_os().nth(1).is_some_and(|arg| arg.to_string_lossy().starts_with("--billie-")) {
        std::process::exit(2);
    }
    billieweather_lib::run()
}
