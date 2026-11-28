use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    // The exact commit a build was made from, shown by --billie-identity.
    println!("cargo:rerun-if-env-changed=BILLIE_SOURCE_REVISION");
    println!("cargo:rustc-env=BILLIE_SOURCE_REVISION={}", env::var("BILLIE_SOURCE_REVISION").unwrap_or_else(|_| "unrecorded".into()));
    // macOS: compile the shared Apple Vision OCR (Swift) into a static library and link it.
    // iOS uses the same Swift file through the mobile plugin instead.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_apple_vision();
    }
    generate_migrations();
    tauri_build::build()
}

/// Writes OUT_DIR/migrations.rs: one `Migration` per migrations/NNNN_name.sql, in version order, which
/// src/lib.rs includes. Adding a migration file is the whole change (the TypeScript side derives its
/// schema version from the same folder: src/services/migrations.ts). The files must be numbered 1..n
/// without gaps or duplicates; anything else stops the build. sqlx compares only the version and the
/// SQL checksum of applied migrations, so the description (taken from the file name) is informational.
fn generate_migrations() {
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<(u32, String)> = fs::read_dir(&dir)
        .expect("src-tauri/migrations is missing")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.len() > 9 && name.ends_with(".sql") && name.as_bytes()[4] == b'_' && name[..4].bytes().all(|b| b.is_ascii_digit()))
        .map(|name| (name[..4].parse().unwrap(), name))
        .collect();
    files.sort();
    let versions: Vec<u32> = files.iter().map(|(version, _)| *version).collect();
    assert!(
        !versions.is_empty() && versions.iter().enumerate().all(|(index, version)| *version == index as u32 + 1),
        "src-tauri/migrations must be numbered 1, 2, 3 … without gaps or duplicates; found {versions:?}"
    );
    let mut code = String::from("vec![\n");
    for (version, name) in &files {
        println!("cargo:rerun-if-changed={}", dir.join(name).display());
        let description = name[5..name.len() - 4].replace('_', " ");
        let path = dir.join(name).display().to_string();
        code += &format!("    Migration {{ version: {version}, description: {description:?}, sql: include_str!({path:?}), kind: MigrationKind::Up }},\n");
    }
    code += "]\n";
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("migrations.rs"), code).unwrap();
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
