// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-billie-ocr",
  platforms: [
    // VNRecognizeTextRequest needs iOS 13 / macOS 10.15.
    .macOS(.v10_15),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-billie-ocr",
      type: .static,
      targets: ["tauri-plugin-billie-ocr"])
  ],
  dependencies: [
    // Populated by the tauri-plugin build helper when building the app for iOS.
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-billie-ocr",
      dependencies: [
        .byName(name: "Tauri")
      ],
      // Sources/BillieVisionOCR.swift is a symlink to src-tauri/ocr-apple/BillieVisionOCR.swift,
      // the single Apple Vision implementation shared with the macOS build.
      path: "Sources")
  ]
)
