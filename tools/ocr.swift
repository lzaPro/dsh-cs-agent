// macOS Vision OCR: reads one image, prints recognized text as JSON.
// Usage: ocr <image-path> [lang...]
import Foundation
import Vision
import ImageIO
import CoreGraphics

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: ocr <image-path> [lang]\n".utf8))
    exit(64)
}
let path = args[1]
let languages = args.count >= 3 ? Array(args[2...]) : ["zh-Hans", "en-US"]

let url = URL(fileURLWithPath: path)
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write(Data("cannot read image: \(path)\n".utf8))
    exit(66)
}

// 统一到 sRGB RGBA8：带 alpha 或非 sRGB 的 PNG 会让 Vision 直接返回空结果。
let width = image.width
let height = image.height
guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(
        data: nil, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    FileHandle.standardError.write(Data("cannot create context\n".utf8))
    exit(66)
}
// 透明背景先铺白：截图常见 alpha=0，直接 OCR 会得到空结果。
context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: width, height: height))
context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
guard let normalized = context.makeImage() else {
    FileHandle.standardError.write(Data("cannot normalize image\n".utf8))
    exit(66)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = languages

do {
    try VNImageRequestHandler(cgImage: normalized, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write(Data("ocr failed: \(error)\n".utf8))
    exit(70)
}

var lines: [String] = []
var confidence = 0.0
var count = 0
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    lines.append(candidate.string)
    confidence += Double(candidate.confidence)
    count += 1
}

let payload: [String: Any] = [
    "text": lines.joined(separator: "\n"),
    "lines": lines.count,
    "confidence": count == 0 ? 0 : confidence / Double(count),
]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
