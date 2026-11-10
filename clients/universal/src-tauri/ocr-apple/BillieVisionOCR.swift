// On-device text recognition with Apple Vision, shared by macOS (linked into the Tauri app as a
// static library, see build.rs), iOS (the Swift side of the mobile plugin) and the test CLI.
//
// Contract (identical for every BillieWeather OCR adapter, see
// packages/finance-core/src/universal/ocr.ts `OcrResult`):
// - coordinates are pixels with the origin at the top-left of the upright image (EXIF
//   orientation and any detected 90/180/270 rotation already applied);
// - confidence is 0...1 as reported by Vision (per line; words inherit it, which is reported
//   as the unsupported capability "word_confidence");
// - nothing is guessed: unreadable text is simply absent.
//
// Privacy: Vision text recognition runs entirely on the device. Language correction is OFF:
// it can rewrite tokens towards dictionary words, which must never happen to amounts or dates.
import CoreGraphics
import Foundation
import ImageIO
import Vision

public enum BillieVision {
    /// Images larger than this are refused instead of exhausting memory.
    public static let maxPixels = 60_000_000

    public static func recognize(data: Data, languages requested: [String], page: Int) -> [String: Any] {
        var result: [String: Any] = [
            "engine": ["id": "apple-vision", "version": engineVersion()],
            "languages": requested,
            "pages": [],
            "errors": [],
            "unsupported": ["word_confidence"],
        ]
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            result["errors"] = [["page": page, "code": "decode_failed", "message": "The image could not be decoded."]]
            return result
        }
        if image.width * image.height > maxPixels {
            result["errors"] = [["page": page, "code": "too_large", "message": "The image has too many pixels."]]
            return result
        }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let exif = CGImagePropertyOrientation(rawValue: (properties?[kCGImagePropertyOrientation] as? UInt32) ?? 1) ?? .up
        let supported = supportedLanguages(requested)
        // Vision weighs languages by order. Orientation is probed with the requested order
        // (English first): Chinese models read upside-down Latin text almost as confidently as
        // upright text, so they cannot tell 90 from 270 degrees. Chinese goes first in the final
        // pass only when a Chinese-first read of the chosen orientation actually finds CJK text.
        let chineseFirst = supported.filter { $0.hasPrefix("zh") } + supported.filter { !$0.hasPrefix("zh") }
        var languages = supported

        // A photo or scan may be sideways or upside down without EXIF saying so: pick the
        // orientation in which a quick pass reads the most confident text.
        var best: (rotation: Int, orientation: CGImagePropertyOrientation, score: Double) = (0, exif, -1)
        for rotation in [0, 90, 180, 270] {
            let orientation = rotate(exif, by: rotation)
            let observations = (try? run(image: image, orientation: orientation, languages: supported, level: .accurate)) ?? []
            // Vision can read sideways text without rotating it, so a good orientation must also make
            // the lines horizontal (wider than tall in that orientation's pixel space).
            let swapped = [CGImagePropertyOrientation.left, .right, .leftMirrored, .rightMirrored].contains(orientation)
            let width = Double(swapped ? image.height : image.width)
            let height = Double(swapped ? image.width : image.height)
            let score = observations.reduce(0.0) { total, observation in
                guard let candidate = observation.topCandidates(1).first else { return total }
                let horizontal = Double(observation.boundingBox.width) * width >= Double(observation.boundingBox.height) * height
                return total + (horizontal ? 1 : 0) * Double(candidate.confidence) * Double(candidate.string.count)
            }
            if score > best.score { best = (rotation, orientation, score) }
            if rotation == 0 && isConfidentlyUpright(observations, width: width, height: height) { break }
        }

        if chineseFirst.first?.hasPrefix("zh") == true {
            let probe = (try? run(image: image, orientation: best.orientation, languages: chineseFirst, level: .accurate)) ?? []
            let text = probe.compactMap { $0.topCandidates(1).first?.string }.joined()
            let cjk = text.unicodeScalars.filter { (0x3400...0x9FFF).contains($0.value) || (0xF900...0xFAFF).contains($0.value) }.count
            if cjk > 0 { languages = chineseFirst }
        }
        do {
            let observations = try run(image: image, orientation: best.orientation, languages: languages, level: .accurate)
            let swapped = [CGImagePropertyOrientation.left, .right, .leftMirrored, .rightMirrored].contains(best.orientation)
            let width = Double(swapped ? image.height : image.width)
            let height = Double(swapped ? image.width : image.height)
            var lines: [[String: Any]] = []
            for observation in observations {
                guard let candidate = observation.topCandidates(1).first else { continue }
                let text = candidate.string
                var words: [[String: Any]] = []
                var index = text.startIndex
                while index < text.endIndex {
                    while index < text.endIndex, text[index].isWhitespace { index = text.index(after: index) }
                    guard index < text.endIndex else { break }
                    var end = index
                    while end < text.endIndex, !text[end].isWhitespace { end = text.index(after: end) }
                    let range = index..<end
                    let box = (try? candidate.boundingBox(for: range))?.boundingBox ?? observation.boundingBox
                    words.append(element(String(text[range]), Double(candidate.confidence), box, width, height))
                    index = end
                }
                var line = element(text, Double(candidate.confidence), observation.boundingBox, width, height)
                line["words"] = words
                lines.append(line)
            }
            result["pages"] = [["page": page, "width": width, "height": height, "rotation": best.rotation, "lines": lines]]
        } catch {
            result["errors"] = [["page": page, "code": "recognition_failed", "message": "Text recognition failed."]]
        }
        if languages.count < requested.count {
            result["unsupported"] = ["word_confidence"] + requested.filter { !languages.contains($0) }.map { "language:\($0)" }
        }
        return result
    }

    /// JSON for the C entry point and the CLI.
    public static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "{\"errors\":[{\"code\":\"recognition_failed\"}]}" }
        return text
    }

    private static func run(image: CGImage, orientation: CGImagePropertyOrientation, languages: [String], level: VNRequestTextRecognitionLevel) throws -> [VNRecognizedTextObservation] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = level
        request.usesLanguageCorrection = false
        if !languages.isEmpty { request.recognitionLanguages = languages }
        let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
        try handler.perform([request])
        return request.results ?? []
    }

    private static func isConfidentlyUpright(_ observations: [VNRecognizedTextObservation], width: Double, height: Double) -> Bool {
        let confidences = observations.compactMap { $0.topCandidates(1).first?.confidence }
        guard confidences.count >= 3 else { return false }
        let horizontal = observations.filter { Double($0.boundingBox.width) * width >= Double($0.boundingBox.height) * height }.count
        return Double(horizontal) >= Double(observations.count) * 0.9 && confidences.reduce(0, +) / Float(confidences.count) >= 0.8
    }

    /// Vision's normalized boxes have a bottom-left origin; the contract uses top-left pixels.
    private static func element(_ text: String, _ confidence: Double, _ box: CGRect, _ width: Double, _ height: Double) -> [String: Any] {
        [
            "text": text, "confidence": confidence,
            "x": Double(box.minX) * width, "y": (1 - Double(box.maxY)) * height,
            "width": Double(box.width) * width, "height": Double(box.height) * height,
        ]
    }

    /// Languages this OS version can recognize, in the requested order.
    private static func supportedLanguages(_ requested: [String]) -> [String] {
        var available = ["en-US"]
        if #available(macOS 12.0, iOS 15.0, *) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            available = (try? request.supportedRecognitionLanguages()) ?? available
        } else if #available(macOS 11.0, iOS 14.0, *) {
            available = (try? VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: VNRecognizeTextRequestRevision2)) ?? available
        }
        return requested.compactMap { wanted in
            available.first { $0 == wanted || $0.hasPrefix(wanted + "-") || wanted.hasPrefix($0) }
        }
    }

    private static func rotate(_ orientation: CGImagePropertyOrientation, by degrees: Int) -> CGImagePropertyOrientation {
        // Clockwise quarter turns applied on top of the EXIF orientation (mirroring is kept).
        let cycle: [CGImagePropertyOrientation] = [.up, .right, .down, .left]
        let mirrored: [CGImagePropertyOrientation] = [.upMirrored, .rightMirrored, .downMirrored, .leftMirrored]
        let steps = degrees / 90
        if let index = cycle.firstIndex(of: orientation) { return cycle[(index + steps) % 4] }
        if let index = mirrored.firstIndex(of: orientation) { return mirrored[(index + steps) % 4] }
        return orientation
    }

    private static func engineVersion() -> String {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        var revision = VNRecognizeTextRequestRevision1
        if #available(macOS 11.0, iOS 14.0, *) { revision = VNRecognizeTextRequestRevision2 }
        if #available(macOS 13.0, iOS 16.0, *) { revision = VNRecognizeTextRequestRevision3 }
        return "VNRecognizeTextRequest rev \(revision); OS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
    }
}

/// C entry point for Rust. Returns 0 and a malloc'd UTF-8 JSON string in `out` (free it with
/// billie_vision_free), or non-zero on invalid arguments.
@_cdecl("billie_vision_recognize")
public func billie_vision_recognize(_ bytes: UnsafePointer<UInt8>?, _ length: Int, _ languages: UnsafePointer<CChar>?, _ page: Int32,
                                    _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) -> Int32 {
    guard let bytes, let out, length > 0 else { return 1 }
    let data = Data(bytes: bytes, count: length)
    let list = languages.map { String(cString: $0) }?.split(separator: ",").map(String.init).filter { !$0.isEmpty } ?? []
    let text = BillieVision.json(BillieVision.recognize(data: data, languages: list, page: Int(page)))
    out.pointee = strdup(text)
    return out.pointee == nil ? 2 : 0
}

@_cdecl("billie_vision_free")
public func billie_vision_free(_ pointer: UnsafeMutablePointer<CChar>?) {
    free(pointer)
}
