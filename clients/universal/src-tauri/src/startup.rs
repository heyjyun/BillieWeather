//! A startup that has to stop says why. There is no window yet, so the system shows the message.
#[cfg(target_os = "macos")]
use std::ffi::{c_char, c_void, CString};

/// Ended before anything was opened: the copy that protects a ledger from a schema change failed.
pub const UNPROTECTED: i32 = 79;

/// Ended before anything was opened: another copy of this app has the same databases open.
pub const ALREADY_OPEN: i32 = 80;

/// Held for the whole life of the process; the system releases it when the process ends, however it ends.
pub struct DataDirLock(#[allow(dead_code)] Option<std::fs::File>);

/// Only one process may use the data folder: the copy made before a schema change assumes that nobody
/// else is writing. Waits briefly, because a restart can overlap with the process that is ending.
/// `Err` means another process has it. A file system without locks keeps working as before.
pub fn hold_data_dir(dir: &std::path::Path, patience: std::time::Duration) -> Result<DataDirLock, ()> {
    let Ok(file) = std::fs::create_dir_all(dir).and_then(|_| std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(".in-use"))) else {
        return Ok(DataDirLock(None));
    };
    let start = std::time::Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(DataDirLock(Some(file))),
            Err(std::fs::TryLockError::WouldBlock) if start.elapsed() < patience => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(std::fs::TryLockError::WouldBlock) => return Err(()),
            Err(std::fs::TryLockError::Error(_)) => return Ok(DataDirLock(None)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Reason {
    Unprotected,
    AlreadyOpen,
}

/// Title and message for a system language such as "zh-Hans-CN". No paths, names or data.
fn text(reason: Reason, language: &str) -> (&'static str, &'static str) {
    let language = language.to_ascii_lowercase();
    let traditional = language.contains("hant") || language.ends_with("-tw") || language.ends_with("-hk") || language.ends_with("-mo");
    let (title, unprotected, open) = match language.split('-').next().unwrap_or("") {
        "zh" if traditional => ("BillieWeather 無法開啟", "更新前無法為您的資料庫建立保護副本，因此未開啟或變更任何資料。請檢查磁碟可用空間，然後再次開啟 BillieWeather。", "BillieWeather 已在這部電腦上開啟。請切換到已開啟的視窗，或先將其結束。"),
        "zh" => ("BillieWeather 无法打开", "更新前无法为您的数据库创建保护副本，因此没有打开或更改任何数据。请检查磁盘可用空间，然后再次打开 BillieWeather。", "BillieWeather 已在这台电脑上打开。请切换到已打开的窗口，或先将其退出。"),
        "ja" => ("BillieWeatherを開けません", "更新前にデータベースの保護用コピーを作成できなかったため、データは開かれず、変更もされていません。ディスクの空き容量を確認してから、もう一度開いてください。", "BillieWeatherはこのコンピューターですでに開いています。開いているウインドウに切り替えるか、先に終了してください。"),
        "ko" => ("BillieWeather를 열 수 없습니다", "업데이트 전에 데이터베이스의 보호 사본을 만들지 못해 데이터를 열거나 변경하지 않았습니다. 디스크 여유 공간을 확인한 후 다시 여세요.", "BillieWeather가 이 컴퓨터에서 이미 열려 있습니다. 열려 있는 창으로 전환하거나 먼저 종료하세요."),
        "es" => ("BillieWeather no puede abrirse", "No se pudo crear una copia de protección de tu base de datos antes de actualizarla, así que no se abrió ni se cambió ningún dato. Comprueba el espacio libre en el disco y vuelve a abrir BillieWeather.", "BillieWeather ya está abierto en este equipo. Cambia a la ventana abierta o ciérrala primero."),
        _ => ("BillieWeather can't open", "A protective copy of your database could not be made before updating it, so no data was opened or changed. Check the free space on your disk, then open BillieWeather again.", "BillieWeather is already open on this computer. Switch to the open window, or quit it first."),
    };
    (title, match reason { Reason::Unprotected => unprotected, Reason::AlreadyOpen => open })
}

fn stop(reason: Reason, log: &str, code: i32) -> ! {
    use std::io::Write;
    let _ = writeln!(std::io::stderr().lock(), "BillieWeather did not start: {log}.");
    let (title, message) = text(reason, &language());
    alert(title, message);
    std::process::exit(code);
}

/// Shows the reason and ends the process. Nothing has been opened.
pub fn explain_unprotected() -> ! {
    stop(Reason::Unprotected, "the local database could not be protected before migration", UNPROTECTED)
}

/// Shows the reason and ends the process. Nothing has been opened.
pub fn explain_already_open() -> ! {
    stop(Reason::AlreadyOpen, "another copy is open", ALREADY_OPEN)
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

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(window: *mut std::ffi::c_void, text: *const u16, caption: *const u16, style: u32) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetUserDefaultLocaleName(buffer: *mut u16, length: i32) -> i32;
}

#[cfg(windows)]
fn language() -> String {
    let mut buffer = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    let length = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..usize::try_from(length).unwrap_or(0).saturating_sub(1)])
}

/// A release build has no console on Windows, so without this the app would just not appear.
#[cfg(windows)]
fn alert(title: &str, message: &str) {
    let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (title, message) = (wide(title), wide(message));
    const ERROR_ICON_IN_FRONT: u32 = 0x10 | 0x1_0000; // MB_ICONERROR | MB_SETFOREGROUND
    unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), ERROR_ICON_IN_FRONT) };
}

#[cfg(not(any(target_os = "macos", windows)))]
fn language() -> String {
    String::new()
}

/// Other platforms: the process ends with the reason on stderr, as before.
#[cfg(not(any(target_os = "macos", windows)))]
fn alert(_title: &str, _message: &str) {}

#[cfg(test)]
mod tests {
    use super::{hold_data_dir, text, Reason};
    use std::time::Duration;

    #[test]
    fn every_app_language_explains_that_nothing_changed() {
        for (language, word) in [("en-US", "no data was opened"), ("zh-Hans-CN", "没有打开"), ("zh-Hant-TW", "未開啟"), ("zh-HK", "未開啟"), ("ja-JP", "変更もされていません"), ("ko-KR", "변경하지 않았습니다"), ("es-419", "no se abrió"), ("", "no data was opened"), ("fr", "no data was opened")] {
            let (title, message) = text(Reason::Unprotected, language);
            assert!(message.contains(word), "{language}: {message}");
            assert!(title.contains("BillieWeather") && !message.contains('/'), "{language}");
            let (same, open) = text(Reason::AlreadyOpen, language);
            assert!(same == title && open != message && open.contains("BillieWeather"), "{language}");
        }
    }

    #[test]
    fn a_second_copy_is_refused_until_the_first_one_ends() {
        let dir = std::env::temp_dir().join(format!("bw-in-use-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = hold_data_dir(&dir, Duration::ZERO).unwrap();
        assert!(hold_data_dir(&dir, Duration::from_millis(120)).is_err());
        // A restart overlaps with the process that is ending.
        let ending = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(150)); drop(first); });
        assert!(hold_data_dir(&dir, Duration::from_secs(5)).is_ok());
        ending.join().unwrap();
        assert!(hold_data_dir(&dir, Duration::ZERO).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_the_system_language() {
        assert!(!super::language().is_empty());
    }
}
