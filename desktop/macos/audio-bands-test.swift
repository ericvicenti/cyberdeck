// Run: swiftc desktop/macos/AudioBands.swift desktop/macos/audio-bands-test.swift -o /tmp/audio-bands-test && /tmp/audio-bands-test
import Foundation
@main struct AudioBandsTest {
    static func main() {
        let analyzer = AudioBands()
        let silence = analyzer.analyze(samples: Array(repeating: 0, count: 1024), writeIndex: 0, sampleRate: 48_000)
        precondition(silence.count == 48 && silence.allSatisfy { $0 == 0 })
        let sine = (0..<1024).map { Float(sin(2 * Double.pi * 1000 * Double($0) / 48_000) * 0.18) }
        let result = analyzer.analyze(samples: sine, writeIndex: 0, sampleRate: 48_000)
        let strongest = result.enumerated().max(by: { $0.element < $1.element })!.offset
        let expected = Int(log(1000 / 35.0) / log(16_000 / 35.0) * 48)
        precondition(abs(strongest - expected) <= 2 && result[strongest] > 0.1, "1 kHz energy must land near the 1 kHz band")
        print("PASS silence is zero; 1 kHz sine peaks at band \(strongest) (expected \(expected))")
    }
}
