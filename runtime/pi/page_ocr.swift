// Reads the text a rendered page actually shows, with the macOS Vision framework.
// usage: page_ocr <png> '<[{"y":0,"h":1000},...]>'
// Prints {"lines":[{"text","x","y","w","h","tile"}]} on stdout, in page pixels
// (origin top-left). It reads the image and writes nothing else.
import Foundation
import CoreGraphics
import ImageIO
import Vision

struct Line: Encodable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let tile: Int
}

struct Output: Encodable {
    let lines: [Line]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
if args.count != 3 { fail("usage: page_ocr <png> <tiles-json>") }
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("cannot read image") }
guard let tileData = args[2].data(using: .utf8),
      let tiles = try? JSONSerialization.jsonObject(with: tileData) as? [[String: Any]] else { fail("bad tiles") }

let width = image.width
var lines: [Line] = []
for (index, tile) in tiles.enumerated() {
    guard let y = (tile["y"] as? NSNumber)?.intValue, let h = (tile["h"] as? NSNumber)?.intValue,
          y >= 0, h > 0, y + h <= image.height else { fail("tile out of range") }
    guard let crop = image.cropping(to: CGRect(x: 0, y: y, width: width, height: h)) else { fail("cannot crop") }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: crop, options: [:])
    do { try handler.perform([request]) } catch { fail("vision failed: \(error.localizedDescription)") }
    for observation in request.results ?? [] {
        guard let best = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        lines.append(Line(
            text: best.string,
            x: box.origin.x * Double(width),
            y: Double(y) + (1.0 - box.origin.y - box.size.height) * Double(h),
            w: box.size.width * Double(width),
            h: box.size.height * Double(h),
            tile: index))
    }
}
let encoder = JSONEncoder()
FileHandle.standardOutput.write(try! encoder.encode(Output(lines: lines)))
