//! A startup that has to stop says why. There is no window yet, so the system shows the message.
#[cfg(target_os = "macos")]
use std::ffi::{c_char, c_void, CString};

/// Ended before anything was opened: the copy that protects a ledger from a schema change failed.
pub const UNPROTECTED: i32 = 79;

/// Title and message for a system language such as "zh-Hans-CN". No paths, names or data.
fn unprotected_text(language: &str) -> (&'static str, &'static str) {
    let language = language.to_ascii_lowercase();
    match language.split('-').next().unwrap_or("") {
        "zh" if language.contains("hant") || language.ends_with("-tw") || language.ends_with("-hk") || language.ends_with("-mo") => ("BillieWeather 無法開啟", "更新前無法為您的資料庫建立保護副本，因此未開啟或變更任何資料。請檢查磁碟可用空間，然後再次開啟 BillieWeather。"),
        "zh" => ("BillieWeather 无法打开", "更新前无法为您的数据库创建保护副本，因此没有打开或更改任何数据。请检查磁盘可用空间，然后再次打开 BillieWeather。"),
        "ja" => ("BillieWeatherを開けません", "更新前にデータベースの保護用コピーを作成できなかったため、データは開かれず、変更もされていません。ディスクの空き容量を確認してから、もう一度開いてください。"),
        "ko" => ("BillieWeather를 열 수 없습니다", "업데이트 전에 데이터베이스의 보호 사본을 만들지 못해 데이터를 열거나 변경하지 않았습니다. 디스크 여유 공간을 확인한 후 다시 여세요."),
        "es" => ("BillieWeather no puede abrirse", "No se pudo crear una copia de protección de tu base de datos antes de actualizarla, así que no se abrió ni se cambió ningún dato. Comprueba el espacio libre en el disco y vuelve a abrir BillieWeather."),
        _ => ("BillieWeather can't open", "A protective copy of your database could not be made before updating it, so no data was opened or changed. Check the free space on your disk, then open BillieWeather again."),
    }
}

/// Shows the reason and ends the process. Nothing has been opened.
pub fn explain_unprotected() -> ! {
    let (title, message) = unprotected_text(&language());
    use std::io::Write;
    let _ = std::io::stderr().lock().write_all(b"BillieWeather did not start: the local database could not be protected before migration.\n");
    alert(title, message);
    std::process::exit(UNPROTECTED);
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(allocator: *const c_void, text: *const c_char, encoding: u32) -> *const c_void;
    fn CFStringGetCString(text: *const c_void, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFLocaleCopyPreferredLanguages() -> *const c_void;
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    fn CFUserNotificationDisplayAlert(timeout: f64, flags: usize, icon: *const c_void, sound: *const c_void, localization: *const c_void, header: *const c_void, message: *const c_void, default: *const c_void, alternate: *const c_void, other: *const c_void, response: *mut usize) -> i32;
}

#[cfg(target_os = "macos")]
const UTF8: u32 = 0x0800_0100;

#[cfg(target_os = "macos")]
fn language() -> String {
    let mut buffer = [0 as c_char; 64];
    // The array and its strings stay alive for the rest of this (ending) process.
    unsafe {
        let list = CFLocaleCopyPreferredLanguages();
        if list.is_null() || CFArrayGetCount(list) == 0 || CFStringGetCString(CFArrayGetValueAtIndex(list, 0), buffer.as_mut_ptr(), buffer.len() as isize, UTF8) == 0 {
            return String::new();
        }
        std::ffi::CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into_owned()
    }
}

/// A system alert that needs no event loop of ours.
#[cfg(target_os = "macos")]
fn alert(title: &str, message: &str) {
    let (Ok(title), Ok(message)) = (CString::new(title), CString::new(message)) else { return };
    unsafe {
        let title = CFStringCreateWithCString(std::ptr::null(), title.as_ptr(), UTF8);
        let message = CFStringCreateWithCString(std::ptr::null(), message.as_ptr(), UTF8);
        let none = std::ptr::null();
        let mut response = 0;
        CFUserNotificationDisplayAlert(0.0, 0, none, none, none, title, message, none, none, none, &mut response);
    }
}

#[cfg(not(target_os = "macos"))]
fn language() -> String {
    String::new()
}

/// Other platforms: the process ends with the reason on stderr, as before.
#[cfg(not(target_os = "macos"))]
fn alert(_title: &str, _message: &str) {}

#[cfg(test)]
mod tests {
    use super::unprotected_text;

    #[test]
    fn every_app_language_explains_that_nothing_changed() {
        for (language, word) in [("en-US", "no data was opened"), ("zh-Hans-CN", "没有打开"), ("zh-Hant-TW", "未開啟"), ("zh-HK", "未開啟"), ("ja-JP", "変更もされていません"), ("ko-KR", "변경하지 않았습니다"), ("es-419", "no se abrió"), ("", "no data was opened"), ("fr", "no data was opened")] {
            let (title, message) = unprotected_text(language);
            assert!(message.contains(word), "{language}: {message}");
            assert!(title.contains("BillieWeather") && !message.contains('/'), "{language}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_the_system_language() {
        assert!(!super::language().is_empty());
    }
}
