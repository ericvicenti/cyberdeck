import Foundation
struct CaptionCue {
    let start: Double
    let end: Double
    let text: String
}
func captionTime(_ text: Substring) -> Double? {
    let pieces = text.replacingOccurrences(of: ",", with: ".").split(separator: ":")
    guard pieces.count == 2 || pieces.count == 3 else { return nil }
    let numbers = pieces.compactMap { Double($0) }; guard numbers.count == pieces.count else { return nil }
    return numbers.reduce(0) { $0 * 60 + $1 }
}
func parseCaptions(_ text: String) -> [CaptionCue] {
    text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n").compactMap { block in
        let lines = block.components(separatedBy: "\n")
        guard let index = lines.firstIndex(where: { $0.contains(" --> ") }) else { return nil }
        let range = lines[index].components(separatedBy: " --> ")
        guard range.count == 2, let start = captionTime(Substring(range[0])),
              let endText = range[1].split(separator: " ").first, let end = captionTime(endText), end > start else { return nil }
        let content = lines.dropFirst(index + 1).joined(separator: "\n")
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
        return CaptionCue(start: start, end: end, text: content)
    }.sorted { $0.start < $1.start }
}
