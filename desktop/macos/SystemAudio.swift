import AppKit
import AVFoundation
import CoreMedia
import ScreenCaptureKit
import SwiftUI

// ScreenCaptureKit captures the Mac's mixed OUTPUT, not Spotify transport metadata.
// Capture is owned by the fullscreen view; leaving it stops the stream.
@MainActor final class SystemAudio: ObservableObject {
    @Published private(set) var bands = Array(repeating: Float.zero, count: 48)
    @Published private(set) var energy: Float = 0
    @Published private(set) var message = "Starting system audio capture…"
    @Published private(set) var running = false
    private var stream: SCStream?
    private var output: AudioSpectrumOutput?
    private var startTask: Task<Void, Never>?
    private var decayTimer: Timer?
    private var lastAudio = ProcessInfo.processInfo.systemUptime
    private var generation = 0

    func start() {
        stop()
        generation += 1
        let current = generation
        message = "Starting system audio capture…"
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                try Task.checkCancellation()
                guard current == self.generation else { return }
                guard let display = content.displays.first else {
                    self.message = "No display available for system audio capture. Connect a display and retry."
                    return
                }
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = false
                config.sampleRate = 48_000
                config.channelCount = 2
                // The stream needs a display filter, but video frames are never consumed.
                config.width = 16; config.height = 16
                config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                let output = AudioSpectrumOutput(owner: self, generation: current)
                let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: output)
                try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "casework.system-audio.fft", qos: .userInteractive))
                self.output = output; self.stream = stream
                try await stream.startCapture()
                guard current == self.generation else { try? await stream.stopCapture(); return }
                self.running = true
                self.message = "Listening to this Mac's audio output"
                self.lastAudio = ProcessInfo.processInfo.systemUptime
                self.decayTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                    Task { @MainActor [weak self] in self?.decayIfSilent() }
                }
            } catch is CancellationError {
                // Normal when the view disappears during startup.
            } catch {
                guard current == self.generation else { return }
                self.running = false
                self.stream = nil; self.output = nil
                self.message = "System audio unavailable: \(error.localizedDescription). Allow Screen Recording for Casework in System Settings → Privacy & Security, then reopen Casework and retry."
            }
        }
    }
    func stop() {
        generation += 1
        startTask?.cancel(); startTask = nil
        decayTimer?.invalidate(); decayTimer = nil
        let old = stream
        stream = nil; output = nil; running = false
        bands = Array(repeating: 0, count: 48); energy = 0
        if let old { Task { try? await old.stopCapture() } }
    }
    fileprivate func receive(_ incoming: [Float], generation: Int) {
        guard generation == self.generation, running else { return }
        lastAudio = ProcessInfo.processInfo.systemUptime
        if energy == 0 && incoming.allSatisfy({ $0 < 0.003 }) { return }
        for i in bands.indices {
            let target = incoming[i]
            bands[i] += (target - bands[i]) * (target > bands[i] ? 0.55 : 0.16)
        }
        energy = bands.reduce(0, +) / Float(bands.count)
    }
    fileprivate func failed(_ error: Error, generation: Int) {
        guard generation == self.generation else { return }
        stop()
        message = "Audio capture stopped: \(error.localizedDescription). Check Screen Recording permission and try again."
    }
    private func decayIfSilent() {
        guard running, energy > 0, ProcessInfo.processInfo.systemUptime - lastAudio > 0.13 else { return }
        bands = bands.map { $0 < 0.003 ? 0 : $0 * 0.7 }
        energy = bands.reduce(0, +) / Float(bands.count)
    }
}

private final class AudioSpectrumOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    weak var owner: SystemAudio?
    let generation: Int
    private let analyzer = AudioBands()
    private var samples = [Float](repeating: 0, count: 1024)
    private var writeIndex = 0
    private var lastUpdate = ProcessInfo.processInfo.systemUptime
    init(owner: SystemAudio, generation: Int) {
        self.owner = owner; self.generation = generation
        super.init()
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor [weak owner, generation] in owner?.failed(error, generation: generation) }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferIsValid(buffer), let description = CMSampleBufferGetFormatDescription(buffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let format = AVAudioFormat(streamDescription: asbd), format.commonFormat == .pcmFormatFloat32 else { return }
        let frames = CMSampleBufferGetNumSamples(buffer)
        guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        pcm.frameLength = AVAudioFrameCount(frames)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(buffer, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList) == noErr,
              let channels = pcm.floatChannelData else { return }
        let channelCount = Int(format.channelCount)
        let stride = format.isInterleaved ? channelCount : 1
        for frame in 0..<frames {
            var mono: Float = 0
            for channel in 0..<channelCount { mono += channels[format.isInterleaved ? 0 : channel][frame * stride + (format.isInterleaved ? channel : 0)] }
            samples[writeIndex] = mono / Float(channelCount)
            writeIndex = (writeIndex + 1) % analyzer.count
        }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastUpdate >= 1.0 / 30 else { return }
        lastUpdate = now
        let spectrum = analyzer.analyze(samples: samples, writeIndex: writeIndex, sampleRate: format.sampleRate)
        Task { @MainActor [weak owner, generation] in owner?.receive(spectrum, generation: generation) }
    }
}
