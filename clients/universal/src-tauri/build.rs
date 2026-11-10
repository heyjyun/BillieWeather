use std::{env, path::PathBuf, process::Command};

fn main() {
    // macOS: compile the shared Apple Vision OCR (Swift) into a static library and link it.
    // iOS uses the same Swift file through the mobile plugin instead.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_apple_vision();
    }
    tauri_build::build()
}

fn build_apple_vision() {
    let source = PathBuf::from("ocr-apple/BillieVisionOCR.swift");
    println!("cargo:rerun-if-changed={}", source.display());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        other => other,
    }
    .to_string();
    // Vision text recognition with Chinese needs macOS 11; older systems are refused at runtime by Vision itself.
    let target = format!("{arch}-apple-macosx11.0");
    let library = out.join("libbillie_vision_ocr.a");
    let status = Command::new("xcrun")
        .args(["swiftc", "-O", "-parse-as-library", "-emit-library", "-static", "-module-name", "BillieVisionOCR", "-target", &target])
        .arg(&source)
        .arg("-o")
        .arg(&library)
        .status()
        .expect("xcrun swiftc is required to build BillieWeather on macOS (install the Xcode Command Line Tools)");
    assert!(status.success(), "compiling ocr-apple/BillieVisionOCR.swift failed");

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=billie_vision_ocr");
    for framework in ["Vision", "CoreGraphics", "ImageIO", "Foundation"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    // Swift runtime: the OS copy in /usr/lib/swift, plus the toolchain's compatibility shims.
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    if let Ok(output) = Command::new("xcrun").args(["--find", "swiftc"]).output() {
        let swiftc = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        if let Some(toolchain) = swiftc.parent().and_then(|bin| bin.parent()) {
            println!("cargo:rustc-link-search=native={}", toolchain.join("lib/swift/macosx").display());
        }
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
