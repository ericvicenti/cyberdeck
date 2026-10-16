import SwiftUI
import AppKit

// Ambient, playback-aware visuals. Spotify Connect exposes transport metadata,
// not PCM samples: this deliberately does not pretend to be an audio spectrum.
struct ElectricStorm: View {
    let playing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appActive = true
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !playing || reduceMotion || !appActive)) { timeline in
            Canvas(opaque: true, rendersAsynchronously: true) { context, size in
                let time = reduceMotion || !playing ? 12.0 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10000)
                Self.draw(&context, size: size, time: time)
            }
        }.allowsHitTesting(false).accessibilityHidden(true)
            .onAppear { appActive = NSApp.isActive }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in appActive = true }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification)) { _ in appActive = false }
    }
    private static func draw(_ context: inout GraphicsContext, size: CGSize, time t: Double) {
        let w = size.width, h = size.height
        let center = CGPoint(x: w * 0.56, y: h * 0.42)
        let radius = min(w * 0.36, h * 0.38)
        let cyan = Color(red: 0.18, green: 0.86, blue: 1)
        let violet = Color(red: 0.57, green: 0.25, blue: 1)
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(red: 0.008, green: 0.015, blue: 0.045)))
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .radialGradient(Gradient(colors: [Color(red: 0.06, green: 0.13, blue: 0.26), .clear]), center: center, startRadius: 0, endRadius: radius * 2.6))
        context.blendMode = .plusLighter
        // A gently revolving plasma halo, broken into filaments rather than a flat ring.
        for ring in 0..<5 {
            var path = Path()
            for step in 0...180 {
                let a = Double(step) / 180 * .pi * 2
                let ripple = sin(a * 7 + t * 0.6 + Double(ring)) * 0.055 + sin(a * 13 - t * 0.4) * 0.025
                let r = radius * (0.69 + Double(ring) * 0.075 + ripple)
                let point = CGPoint(x: center.x + cos(a + t * 0.045) * r * 1.38, y: center.y + sin(a + t * 0.045) * r * 0.72)
                if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            let color = ring % 2 == 0 ? cyan : violet
            context.stroke(path, with: .color(color.opacity(0.055)), lineWidth: 16)
            context.stroke(path, with: .color(color.opacity(0.38)), lineWidth: 1.1)
        }
        // Smoothly evolving electric arcs: no random flashes, strobes, or full-screen pulses.
        for arc in 0..<6 {
            var path = Path()
            let phase = Double(arc) * 1.73
            for step in 0...150 {
                let x = Double(step) / 150
                let envelope = pow(max(0, sin(x * .pi)), 0.7)
                let wave = sin(x * 9 + t * 0.35 + phase) * 0.17 + cos(x * 17 - t * 0.25 + phase) * 0.065
                let fine = sin(x * 127 + t * 1.1 + phase) * sin(x * 43 - t * 0.8) * 0.022
                let point = CGPoint(x: x * w, y: center.y + (wave + fine) * h * envelope + sin(phase + t * 0.12) * radius * 0.25)
                if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
                if step > 25 && step < 130 && step % 37 == arc % 9 {
                    var branch = Path(); branch.move(to: point)
                    for twig in 1...8 {
                        let f = Double(twig) / 8
                        branch.addLine(to: CGPoint(x: point.x + f * radius * 0.20, y: point.y + f * radius * (arc % 2 == 0 ? 0.22 : -0.22) + sin(f * 28 + t * 0.7) * 4))
                    }
                    context.stroke(branch, with: .color(cyan.opacity(0.32)), lineWidth: 0.8)
                }
            }
            let color = arc % 3 == 0 ? violet : cyan
            context.stroke(path, with: .color(color.opacity(0.06)), lineWidth: 20)
            context.stroke(path, with: .color(color.opacity(0.16)), lineWidth: 6)
            context.stroke(path, with: .color(color.opacity(0.8)), lineWidth: 1.3)
            context.stroke(path, with: .color(.white.opacity(0.5)), lineWidth: 0.45)
        }
        for index in 0..<70 {
            let seed = Double(index)
            let x = (seed * 0.61803398875 + t * 0.003).truncatingRemainder(dividingBy: 1) * w
            let y = (seed * 0.41421356237).truncatingRemainder(dividingBy: 1) * h
            let r = index % 5 == 0 ? 1.8 : 0.8
            let alpha = 0.2 + 0.2 * (sin(t * 0.6 + seed) + 1) * 0.5
            context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: r * 2, height: r * 2)), with: .color(cyan.opacity(alpha)))
        }
    }
}
