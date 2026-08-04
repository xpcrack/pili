import Vision
import CoreImage
import Foundation

struct Output: Encodable {
  let texts: [String]
}

var texts: [String] = []
var seen = Set<String>()

func add(_ value: String) {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty || seen.contains(trimmed) { return }
  seen.insert(trimmed)
  texts.append(trimmed)
}

func makeRequest(languages: [String], minimumTextHeight: Float = 0.003) -> VNRecognizeTextRequest {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  request.recognitionLanguages = languages
  if VNRecognizeTextRequest.supportedRevisions.contains(3) {
    request.revision = 3
  }
  request.minimumTextHeight = minimumTextHeight
  return request
}

func runOcr(_ image: CIImage, languages: [String], minimumTextHeight: Float = 0.003) {
  let request = makeRequest(languages: languages, minimumTextHeight: minimumTextHeight)
  let handler = VNImageRequestHandler(ciImage: image, orientation: .up)
  do {
    try handler.perform([request])
    for observation in request.results ?? [] {
      for candidate in observation.topCandidates(3) {
        add(candidate.string)
      }
    }
  } catch {
    // Keep stdout JSON-only for the caller; failures just mean no OCR text.
  }
}

func scaledCrop(_ image: CIImage, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, scale: CGFloat) -> CIImage {
  let extent = image.extent
  let rect = CGRect(
    x: extent.minX + extent.width * x,
    y: extent.minY + extent.height * y,
    width: extent.width * width,
    height: extent.height * height
  ).intersection(extent)
  return image.cropped(to: rect).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
}

for imagePath in CommandLine.arguments.dropFirst() {
  guard let data = FileManager.default.contents(atPath: imagePath),
        let image = CIImage(data: data) else {
    continue
  }

  runOcr(image, languages: ["en-US", "zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant"])

  // Tiny chart headers are where ticker/name live. Crop+scale beats asking Vision
  // to read a full social screenshot at once, especially for Chinese token names.
  let headerCrops = [
    scaledCrop(image, x: 0.10, y: 0.64, width: 0.70, height: 0.18, scale: 6),
    scaledCrop(image, x: 0.13, y: 0.66, width: 0.55, height: 0.10, scale: 10),
    scaledCrop(image, x: 0.15, y: 0.67, width: 0.35, height: 0.08, scale: 12),
  ]
  for crop in headerCrops {
    runOcr(crop, languages: ["zh-Hans", "zh-Hant", "yue-Hans", "yue-Hant"], minimumTextHeight: 0.001)
    runOcr(crop, languages: ["en-US"], minimumTextHeight: 0.001)
  }
}

let data = try JSONEncoder().encode(Output(texts: texts))
FileHandle.standardOutput.write(data)
