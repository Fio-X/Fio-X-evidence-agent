// Test helper (macOS): draws text lines onto a white PNG so the page read-back can be tried on a known page.
// usage: page_ocr_fixture_render <out.png> '{"width":W,"height":H,"texts":[{"text":"..","x":0,"y":0,"size":24}]}'   (y from the top)
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3, let data = args[2].data(using: .utf8),
      let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let width = spec["width"] as? Int, let height = spec["height"] as? Int,
      let texts = spec["texts"] as? [[String: Any]] else { FileHandle.standardError.write("bad spec\n".data(using: .utf8)!); exit(2) }
let space = CGColorSpaceCreateDeviceRGB()
let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: width, height: height))
for item in texts {
    let text = item["text"] as? String ?? ""
    let x = (item["x"] as? NSNumber)?.doubleValue ?? 0
    let y = (item["y"] as? NSNumber)?.doubleValue ?? 0
    let size = (item["size"] as? NSNumber)?.doubleValue ?? 24
    let font = CTFontCreateWithName("PingFang SC" as CFString, size, nil)
    let attributes: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1)]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
    context.textPosition = CGPoint(x: x, y: Double(height) - y - size)
    CTLineDraw(line, context)
}
let image = context.makeImage()!
let url = URL(fileURLWithPath: args[1]) as CFURL
let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, image, nil)
if !CGImageDestinationFinalize(destination) { exit(3) }
