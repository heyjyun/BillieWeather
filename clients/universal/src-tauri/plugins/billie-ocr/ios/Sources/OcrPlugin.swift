// iOS side of the billie-ocr Tauri plugin. The recognition itself is the shared Apple Vision
// implementation in BillieVisionOCR.swift (a symlink to src-tauri/ocr-apple/BillieVisionOCR.swift),
// which already produces the BillieWeather OCR contract; this file only bridges it to Tauri.
// Everything runs on-device; nothing is sent anywhere.
import Foundation
import SwiftRs
import Tauri

struct RecognizeArgs: Decodable {
  /// Base64 of the PNG/JPEG bytes.
  let image: String
  var page: Int?
  var languages: [String]?
}

class OcrPlugin: Plugin {
  private let queue = DispatchQueue(label: "app.billieweather.ocr", qos: .userInitiated)

  @objc public func recognize(_ invoke: Invoke) throws {
    // A decoding failure throws, and Tauri rejects the call (invalid arguments).
    let args = try invoke.parseArgs(RecognizeArgs.self)
    queue.async {
      // Invalid base64 becomes empty data, which BillieVision reports as "decode_failed" in the
      // contract's `errors` (same shape as every other per-page failure).
      let data = Data(base64Encoded: args.image, options: .ignoreUnknownCharacters) ?? Data()
      let result = BillieVision.recognize(data: data, languages: args.languages ?? [], page: args.page ?? 0)
      let payload: JsonObject = result.mapValues { Optional($0) }
      invoke.resolve(payload)
    }
  }
}

@_cdecl("init_plugin_billie_ocr")
public func initPlugin() -> Plugin {
  return OcrPlugin()
}
