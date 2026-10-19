import SwiftUI
import AppKit

// Circular spectrum ribbons driven by captured Mac output; silence is a still frame.
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
        let center = CGPoint(x: w * 0.5, y: h * 0.5)
        let base = min(w, h) * 0.25
        let drive = Double(energy)
        let bass = Double(bands.prefix(8).reduce(0, +)) / 8
        let turn = reduceMotion ? 0 : time * 0.035
        let colors = (0...12).map { Color(hue: Double($0) / 12, saturation: 0.9, brightness: 1) }
        let spectrum = GraphicsContext.Shading.conicGradient(Gradient(colors: colors), center: center, angle: .radians(turn))
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(red: 0.008, green: 0.012, blue: 0.018)))
        context.blendMode = .plusLighter

        // Broad pools of every hue give the halo color without tinting the whole room purple.
        for hue in 0..<6 {
            let angle = Double(hue) / 6 * .pi * 2 + turn
            let point = CGPoint(x: center.x + cos(angle) * base, y: center.y + sin(angle) * base)
            let color = Color(hue: Double(hue) / 6, saturation: 0.95, brightness: 1)
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .radialGradient(
                Gradient(colors: [color.opacity(0.09 + drive * 0.12), .clear]),
                center: point, startRadius: 0, endRadius: base * 1.6))
        }

        // Mirror the frequency range around the circle, smoothly joining bass at the seam.
        // Continuous ribbons keep peaks organic instead of turning them into radial bars.
        for layer in 0..<5 {
            var ring = Path()
            let depth = Double(layer)
            for step in 0...240 {
                let fraction = Double(step) / 240
                let angle = fraction * .pi * 2
                let position = (1 - cos(angle)) * 0.5 * Double(max(0, bands.count - 1))
                let lower = Int(position)
                let mix = position - Double(lower)
                let eased = mix * mix * (3 - 2 * mix)
                let value: Double
                if bands.isEmpty { value = 0 } else {
                    value = Double(bands[lower]) * (1 - eased) + Double(bands[min(lower + 1, bands.count - 1)]) * eased
                }
                let ripple = sin(angle * 3 + turn * 3 + depth * 0.7) * drive * 0.045
                let radius = base * (0.69 + depth * 0.14 + bass * 0.14 + value * (0.24 + depth * 0.025) + ripple)
                let point = CGPoint(x: center.x + cos(angle + turn) * radius, y: center.y + sin(angle + turn) * radius)
                if step == 0 { ring.move(to: point) } else { ring.addLine(to: point) }
            }
            ring.closeSubpath()
            var glow = context
            glow.opacity = layer == 2 ? 0.42 : 0.22
            glow.addFilter(.blur(radius: base * 0.028))
            glow.stroke(ring, with: spectrum, style: StrokeStyle(lineWidth: base * 0.032, lineCap: .round, lineJoin: .round))
            var line = context
            line.opacity = layer == 2 ? 0.95 : 0.48
            line.stroke(ring, with: spectrum, style: StrokeStyle(lineWidth: layer == 2 ? 3 : 1.5, lineCap: .round, lineJoin: .round))
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
