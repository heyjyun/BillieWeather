// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--sqlite-version")) {
        use std::io::Write;
        let version = billieweather_lib::sqlite_version() + "\n";
        let _ = std::io::stdout().lock().write_all(version.as_bytes());
        return;
    }
    billieweather_lib::run()
}
