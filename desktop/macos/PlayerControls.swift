import SwiftUI
import AppKit

struct PlayerControls: View {
    @ObservedObject var model: Workspace
    @State private var scrubbing = false
    @State private var draftPosition = 0.0
    private let accent = Color(red: 0.98, green: 0.33, blue: 0.25)
    private let symbols = ["arrow.backward", "gobackward.10", "play.fill", "goforward.10", "captions.bubble", "speaker.wave.2", "arrow.up.left.and.arrow.down.right", "ellipsis"]
    private func timestamp(_ value: Double) -> String {
        let seconds = Int(max(0, value))
        return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60) : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
    var body: some View {
        VStack {
            if model.playerControlsVisible || model.playbackPaused {
                HStack { Text(model.playbackTitle).font(.system(size: 24, weight: .semibold)).lineLimit(1); Spacer() }.padding(36)
                    .background(LinearGradient(colors: [.black.opacity(0.85), .clear], startPoint: .top, endPoint: .bottom))
            }
            Spacer()
            if model.playerControlsVisible || model.playbackPaused {
                VStack(spacing: 16) {
                    HStack(spacing: 16) {
                        Text(timestamp(scrubbing ? draftPosition : model.playbackPosition)).monospacedDigit().frame(width: 80)
                        Slider(value: Binding(get: { scrubbing ? draftPosition : model.playbackPosition }, set: { draftPosition = $0; model.wakePlayerControls() }), in: 0...max(1, model.playbackDuration)) { editing in
                            if editing { draftPosition = model.playbackPosition; scrubbing = true; model.wakePlayerControls() }
                            else { scrubbing = false; model.seekTo(draftPosition) }
                        }.tint(accent).accessibilityLabel("Playback position")
                        Text(timestamp(model.playbackDuration)).monospacedDigit().frame(width: 80)
                    }
                    HStack(spacing: 18) {
                        ForEach(Workspace.transport.indices, id: \.self) { index in
                            let selected = model.inputMode == .controller && model.playerControlSelection == index
                            Button { model.activateTransport(index) } label: {
                                VStack(spacing: 7) {
                                    Image(systemName: symbol(index)).font(.system(size: index == 2 ? 30 : 24, weight: .semibold)).frame(width: 62, height: 52)
                                        .background(selected ? accent : Color.white.opacity(0.1)).clipShape(RoundedRectangle(cornerRadius: 12))
                                    Text(label(index)).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                }.foregroundStyle(.white)
                            }.buttonStyle(.plain).accessibilityLabel(label(index)).help(label(index))
                        }
                        Spacer()
                        if model.inputMode != .controller {
                            Image(systemName: model.playbackMuted ? "speaker.slash" : "speaker.wave.2")
                            Slider(value: Binding(get: { Double(model.playbackVolume) }, set: { model.setVolume(Float($0)) }), in: 0...1).frame(width: 100).tint(accent).accessibilityLabel("Volume")
                        }
                    }
                    if model.inputMode == .controller {
                        Text("✚ Choose control    A Select    B Back    X Mute    LB / RB Seek    Start More    Y Home")
                            .font(.system(size: 14)).foregroundStyle(.white.opacity(0.65))
                    }
                }.padding(.horizontal, 40).padding(.top, 36).padding(.bottom, 28)
                    .background(LinearGradient(colors: [.clear, .black.opacity(0.92)], startPoint: .top, endPoint: .bottom))
            }
        }.animation(.easeOut(duration: 0.18), value: model.playerControlsVisible)
    }
    private func symbol(_ index: Int) -> String {
        if index == 2 { return model.playbackPaused ? "play.fill" : "pause.fill" }
        if index == 4 { return model.captionsEnabled ? "captions.bubble.fill" : "captions.bubble" }
        if index == 5 { return model.playbackMuted ? "speaker.slash.fill" : "speaker.wave.2" }
        return symbols[index]
    }
    private func label(_ index: Int) -> String {
        ["Back", "−10 seconds", model.playbackPaused ? "Play" : "Pause", "+10 seconds", model.captionsEnabled ? "Captions on" : "Captions", model.playbackMuted ? "Unmute" : "Mute", "Fullscreen", "More"][index]
    }
}

struct TextEntry: View {
    @ObservedObject var model: Workspace
    var body: some View {
        ZStack {
            Color.black.opacity(0.85).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 24) {
                Text("Search / enter text").font(.title.bold())
                NativeTextEntry(model: model).frame(height: 42)
                HStack {
                    Button("Cancel") { model.back() }.keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Done") { model.submitText() }.keyboardShortcut(.defaultAction)
                }.controlSize(.large)
            }.padding(36).frame(maxWidth: 700).background(Color(white: 0.1)).clipShape(RoundedRectangle(cornerRadius: 20))
        }
    }
}

struct NativeTextEntry: NSViewRepresentable {
    let model: Workspace
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(string: model.keyboardText ?? "")
        field.placeholderString = "Type here"; field.font = .systemFont(ofSize: 24)
        field.isEditable = true; field.isSelectable = true; field.usesSingleLineMode = true
        field.delegate = context.coordinator; field.target = context.coordinator; field.action = #selector(Coordinator.submit)
        DispatchQueue.main.async {
            field.window?.makeFirstResponder(field)
            field.currentEditor()?.selectedRange = NSRange(location: field.stringValue.utf16.count, length: 0)
        }
        return field
    }
    func updateNSView(_ field: NSTextField, context: Context) {
        if field.stringValue != model.keyboardText ?? "" { field.stringValue = model.keyboardText ?? "" }
    }
    @MainActor final class Coordinator: NSObject, NSTextFieldDelegate {
        let model: Workspace
        init(_ model: Workspace) { self.model = model }
        func controlTextDidChange(_ notification: Notification) { model.keyboardText = (notification.object as? NSTextField)?.stringValue ?? "" }
        @objc func submit() { model.submitText() }
    }
}
