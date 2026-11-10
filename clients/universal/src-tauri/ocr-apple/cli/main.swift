// Test harness: runs the exact BillieVision code used by the app on image files and prints the
// OcrResult JSON (one per line). Built by the integration tests; never shipped.
//   billie-vision-cli <languages comma-separated> <image> [<image> ...]
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write("usage: billie-vision-cli <languages> <image>...\n".data(using: .utf8)!)
    exit(2)
}
let languages = arguments[1].split(separator: ",").map(String.init)
for (index, path) in arguments.dropFirst(2).enumerated() {
    guard let data = FileManager.default.contents(atPath: path) else {
        print(BillieVision.json(["errors": [["page": index + 1, "code": "decode_failed", "message": "unreadable file"]]]))
        continue
    }
    print(BillieVision.json(BillieVision.recognize(data: data, languages: languages, page: index + 1)))
}
