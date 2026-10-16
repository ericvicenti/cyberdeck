// Used by visual-smoke.py to assert rendered content, independently of the app model.
import Foundation
import Vision
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
for observation in request.results ?? [] {
    if let text = observation.topCandidates(1).first?.string { print(text) }
}
