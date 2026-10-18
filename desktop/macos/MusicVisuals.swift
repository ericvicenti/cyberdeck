import SwiftUI
import AppKit

// A spectrum/tunnel driven exclusively by captured Mac output; silence is a still frame.
struct ElectricStorm: View {
    @StateObject private var audio = SystemAudio()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appActive = true
    var body: some View {
        ZStack(alignment: .top) {
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || !appActive || !audio.running || audio.energy < 0.008)) { timeline in
                Canvas(opaque: true, rendersAsynchronously: true) { context, size in
                    let time = reduceMotion || audio.energy < 0.008 ? 0 : timeline.date.timeIntervalSinceReferenceDate
                    Self.draw(&context, size: size, bands: audio.bands, energy: audio.energy, time: time, reduceMotion: reduceMotion)
                }
            }.allowsHitTesting(false).accessibilityHidden(true)
            HStack(spacing: 12) {
                Image(systemName: audio.running ? "waveform" : "exclamationmark.triangle")
                Text(audio.message).lineLimit(3)
                if !audio.running { Button("Retry") { audio.start() }.buttonStyle(.bordered) }
            }
            .font(.system(size: 13, weight: .medium)).foregroundStyle(.white)
            .padding(12).background(.black.opacity(0.78)).clipShape(RoundedRectangle(cornerRadius: 12))
            .frame(maxWidth: 650).padding(.top, 155)
        }
        .onAppear { appActive = NSApp.isActive; audio.start() }
        .onDisappear { audio.stop() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in appActive = true }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification)) { _ in appActive = false }
    }
    private static func draw(_ context: inout GraphicsContext, size: CGSize, bands: [Float], energy: Float, time: Double, reduceMotion: Bool) {
        let w = size.width, h = size.height
        let center = CGPoint(x: w * 0.5, y: h * 0.44)
        let cyan = Color(red: 0.08, green: 0.9, blue: 1)
        let magenta = Color(red: 0.95, green: 0.15, blue: 0.78)
        let base = min(w, h) * 0.26
        let drive = Double(energy)
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(red: 0.008, green: 0.012, blue: 0.035)))
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .radialGradient(
            Gradient(colors: [Color(red: 0.12 + min(drive * 0.18, 0.12), green: 0.025, blue: 0.26), .clear]),
            center: center, startRadius: 0, endRadius: max(w, h) * 0.76))
        context.blendMode = .plusLighter
        // Classic receding neon tunnel: its geometry follows low-end energy, not a fake beat.
        let bass = Double(bands.prefix(8).reduce(0, +)) / 8
        for depth in 0..<11 {
            let fraction = Double(depth + 1) / 11
            let radius = base * (0.17 + fraction * 1.75) * (1 + bass * 0.21)
            let twist = reduceMotion ? 0 : time * 0.045 + fraction * 0.5
            var ring = Path()
            for corner in 0...8 {
                let angle = Double(corner) * .pi / 4 + twist
                let point = CGPoint(x: center.x + cos(angle) * radius * 1.5, y: center.y + sin(angle) * radius * 0.88)
                if corner == 0 { ring.move(to: point) } else { ring.addLine(to: point) }
            }
            context.stroke(ring, with: .color((depth % 3 == 0 ? magenta : cyan).opacity(0.06 + fraction * 0.26)), lineWidth: fraction * 3)
        }
        for spoke in 0..<8 {
            let angle = Double(spoke) * .pi / 4 + (reduceMotion ? 0 : time * 0.045)
            var path = Path()
            path.move(to: CGPoint(x: center.x + cos(angle) * base * 0.17 * 1.5, y: center.y + sin(angle) * base * 0.17 * 0.88))
            path.addLine(to: CGPoint(x: center.x + cos(angle) * base * 1.92 * 1.5, y: center.y + sin(angle) * base * 1.92 * 0.88))
            context.stroke(path, with: .color(cyan.opacity(0.12)), lineWidth: 1)
        }
        let count = bands.count
        let gap: CGFloat = 3
        let width = min(19, (w * 0.83 / CGFloat(count)) - gap)
        let left = (w - CGFloat(count) * (width + gap)) / 2
        let floor = h * 0.79
        for i in 0..<count {
            let value = Double(bands[i])
            let height = max(2, h * 0.39 * value)
            let x = left + CGFloat(i) * (width + gap)
            let bar = CGRect(x: x, y: floor - height, width: width, height: height)
            let color = i % 7 < 2 ? magenta : cyan
            context.fill(Path(roundedRect: bar, cornerRadius: 2), with: .linearGradient(
                Gradient(colors: [color.opacity(0.92), color.opacity(0.27)]), startPoint: bar.origin, endPoint: CGPoint(x: x, y: floor)))
            if height > 4 {
                context.fill(Path(CGRect(x: x, y: floor + 5, width: width, height: height * 0.26)), with: .color(color.opacity(0.10)))
            }
        }
    }
}

struct StandaloneVisualizer: View {
    @ObservedObject var model: Workspace
    var body: some View {
        ZStack(alignment: .topLeading) {
            ElectricStorm().ignoresSafeArea()
            VStack(alignment: .leading, spacing: 6) {
                Button { model.back() } label: { Label("Back to Casework", systemImage: "arrow.left").padding(12).background(.black.opacity(0.65)).clipShape(Capsule()) }
                    .buttonStyle(.plain)
                Text("SYSTEM AUDIO / VISUALIZER").font(.system(size: 12, weight: .bold)).tracking(2)
                Text("Play audio from this Mac in any app. No Spotify connection needed.").font(.callout)
            }.foregroundStyle(.white).padding(40)
        }
    }
}
