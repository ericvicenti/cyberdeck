import Accelerate

// 1024-point Hann-windowed FFT of a circular mono output buffer. The output is
// 48 logarithmic frequency bands (35 Hz–16 kHz), not transport metadata.
final class AudioBands {
    let count = 1024
    private var window = [Float](repeating: 0, count: 1024)
    private let setup: OpaquePointer?
    init() {
        vDSP_hann_window(&window, 1024, Int32(vDSP_HANN_NORM))
        setup = vDSP_DFT_zop_CreateSetup(nil, 1024, vDSP_DFT_Direction.FORWARD)
    }
    deinit { if let setup { vDSP_DFT_DestroySetup(setup) } }
    func analyze(samples: [Float], writeIndex: Int, sampleRate: Double) -> [Float] {
        guard samples.count == count, sampleRate > 0, let setup else { return Array(repeating: 0, count: 48) }
        var real = [Float](repeating: 0, count: count)
        var imaginary = real, outReal = real, outImaginary = real
        for i in 0..<count { real[i] = samples[(writeIndex + i) % count] * window[i] }
        vDSP_DFT_Execute(setup, &real, &imaginary, &outReal, &outImaginary)
        return (0..<48).map { band in
            let low = 35 * pow(16_000.0 / 35, Double(band) / 48)
            let high = 35 * pow(16_000.0 / 35, Double(band + 1) / 48)
            let start = max(1, min(count / 2 - 1, Int(low / sampleRate * Double(count))))
            let end = max(start + 1, min(count / 2, Int(high / sampleRate * Double(count))))
            var peak: Float = 0
            for bin in start..<end { peak = max(peak, hypotf(outReal[bin], outImaginary[bin]) / Float(count)) }
            return min(1, sqrt(max(0, peak) * 18))
        }
    }
}
