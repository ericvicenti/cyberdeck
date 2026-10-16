import AppKit
import SwiftUI
import AVKit

struct NativePlayer: NSViewRepresentable {
    let player: AVPlayer
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView(); view.player = player; view.controlsStyle = .none
        view.showsFullScreenToggleButton = false; view.videoGravity = .resizeAspect
        return view
    }
    func updateNSView(_ view: AVPlayerView, context: Context) { view.player = player }
}
struct WorkspaceView: View {
    @ObservedObject var model: Workspace
    private let accent = Color(red: 0.72, green: 0.94, blue: 0.50)
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.07, green: 0.09, blue: 0.11), Color(red: 0.025, green: 0.035, blue: 0.045)], startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea()
            if let player = model.player {
                NativePlayer(player: player).ignoresSafeArea().onTapGesture { model.noteInput(.pointer); model.activateTransport(2) }
                PlayerControls(model: model)
                VStack {
                    if !model.playbackStatus.isEmpty {
                        Text(model.playbackStatus).font(.title2).padding(20).background(.black.opacity(0.8)).clipShape(RoundedRectangle(cornerRadius: 16)).padding(30)
                    }
                    Spacer()
                    if !model.caption.isEmpty { Text(model.caption).font(.system(size: 28, weight: .medium)).multilineTextAlignment(.center).padding(12).background(.black.opacity(0.75)).clipShape(RoundedRectangle(cornerRadius: 8)).padding(.bottom, model.playerControlsVisible ? 195 : 50) }
                    if !model.message.isEmpty { Text(model.message).padding().background(.black.opacity(0.8)) }
                }
                if model.playerMenu {
                    VStack(spacing: 20) {
                        Text(model.playbackTitle).font(.title2).lineLimit(2)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 16) {
                            ForEach(Array(Workspace.playerActions.enumerated()), id: \.offset) { index, title in
                                Button { model.playerMenuSelection = index; model.input("select") } label: {
                                    Text(title).font(.title3).frame(maxWidth: .infinity, minHeight: 72).padding(10)
                                        .foregroundStyle(index == model.playerMenuSelection && model.inputMode != .pointer ? .black : .white)
                                        .background(index == model.playerMenuSelection && model.inputMode != .pointer ? accent : Color.white.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 12))
                                }.buttonStyle(.plain)
                            }
                        }
                    }.padding(32).frame(maxWidth: 850).background(.black.opacity(0.94)).clipShape(RoundedRectangle(cornerRadius: 24))
                }
            } else if let browser = model.browser {
                VStack(spacing: 0) {
                    HStack {
                        Button("← Casework") { model.home() }.buttonStyle(.plain)
                        Spacer(); Text(model.inputMode == .controller ? "D-pad move · A select · B back · Y/Home Casework" : "Compatibility view").foregroundStyle(.secondary)
                    }.padding(14)
                    CompatibilityView(browser: browser)
                    if !model.message.isEmpty { Text(model.message).padding(12) }
                }
            } else if model.standaloneVisualizer {
                StandaloneVisualizer(model: model)
            } else if model.page.music {
                MusicView(model: model, music: model.music, page: model.page).id(model.page.id)
            } else if model.page.cinema {
                CinemaView(model: model, page: model.page).id(model.page.id)
            } else {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(model.page.title).font(.system(size: 48, weight: .bold, design: .rounded))
                            Text(model.page.subtitle).font(.system(size: 17)).foregroundStyle(.white.opacity(0.6)).lineLimit(3)
                        }
                        Spacer()
                        if model.busy { ProgressView().controlSize(.large).padding(.top, 12) }
                        Button { model.home() } label: { Image(systemName: "house.fill").font(.title2).padding(16) }.buttonStyle(.plain).accessibilityLabel("Home")
                        Button { model.back() } label: { Image(systemName: "arrow.uturn.backward").font(.title2).padding(16) }.buttonStyle(.plain).accessibilityLabel("Back")
                    }.padding(.horizontal, 48).padding(.top, 38)
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 20), count: model.page.columns), spacing: 24) {
                                ForEach(Array(model.page.tiles.enumerated()), id: \.element.id) { index, tile in
                                    card(tile, selected: model.selection == index && model.inputMode != .pointer) { model.selection = index; tile.run() }.id(index)
                                }
                            }.padding(.horizontal, 48).padding(.vertical, 12)
                        }
                        .onChange(of: model.selection) { _, value in withAnimation(.easeOut(duration: 0.13)) { proxy.scrollTo(value, anchor: .center) } }
                        .onChange(of: model.page.title) { _, _ in proxy.scrollTo(0, anchor: .top) }
                    }
                    .id(model.page.id)
                    VStack(alignment: .leading, spacing: 12) {
                        if !model.message.isEmpty { Text(model.message).font(.system(size: 18)).foregroundStyle(accent).lineLimit(4) }
                        HStack(spacing: 24) {
                            if model.inputMode == .controller {
                                Text("✚ Move"); Text("A Select"); Text("B Back"); Text("Y / ⌂ Home"); Text("X Search")
                            }
                            Spacer(); Text("CASEWORK").tracking(4)
                        }.font(.system(size: 14, weight: .medium)).foregroundStyle(.white.opacity(0.5))
                    }.padding(.horizontal, 48).padding(.bottom, 26)
                }
            }
            if let text = model.keyboardText {
                if model.inputMode == .controller { keyboard(text) } else { TextEntry(model: model) }
            }
        }.foregroundStyle(.white).preferredColorScheme(.dark)
    }
    private func card(_ tile: Tile, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 14) {
                if let url = tile.image {
                    AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Rectangle().fill(.white.opacity(0.04)).overlay(Image(systemName: tile.symbol).font(.system(size: 40)).foregroundStyle(accent)) }
                        .frame(height: 190).clipped().clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    Image(systemName: tile.symbol).font(.system(size: 38, weight: .light)).foregroundStyle(selected ? .black : accent).frame(height: 65, alignment: .center)
                }
                Text(tile.title).font(.system(size: 22, weight: .semibold, design: .rounded)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                Text(tile.subtitle).font(.system(size: 14)).opacity(0.65).lineLimit(3).frame(height: 48, alignment: .topLeading)
            }
            .padding(22).frame(maxWidth: .infinity, minHeight: 212, alignment: .topLeading)
            .foregroundStyle(selected && tile.image == nil ? .black : .white)
            .background(selected && tile.image == nil ? accent : Color.white.opacity(selected ? 0.13 : 0.045))
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(selected ? accent : .white.opacity(0.08), lineWidth: selected ? 4 : 1))
            .scaleEffect(selected ? 1.015 : 1)
        }.buttonStyle(.plain).accessibilityLabel(tile.title + ". " + tile.subtitle)
    }
    private func keyboard(_ text: String) -> some View {
        ZStack {
            Color.black.opacity(0.9).ignoresSafeArea()
            VStack(spacing: 24) {
                Text("Search / enter text").font(.largeTitle.bold())
                Text(text.isEmpty ? "Choose letters with your controller" : text).font(.title2).frame(maxWidth: .infinity, minHeight: 60).padding().background(.white.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 16))
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 8), spacing: 12) {
                    ForEach(Array(Workspace.keyboard.enumerated()), id: \.offset) { index, key in
                        Button { model.keyboardSelection = index; model.input("select") } label: {
                            Text(key).font(.title3.bold()).frame(maxWidth: .infinity, minHeight: 58)
                                .foregroundStyle(index == model.keyboardSelection ? .black : .white)
                                .background(index == model.keyboardSelection ? accent : Color.white.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.plain)
                    }
                }
                Text("A Choose · B Cancel · Select Done to submit").foregroundStyle(.secondary)
            }.frame(maxWidth: 900).padding(48)
        }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let workspace = Workspace()
    var window: NSWindow!
    var keys: Any?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu(); let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Toggle Fullscreen", action: #selector(toggleFullscreen), keyEquivalent: "f").target = self
        appMenu.addItem(withTitle: "Home", action: #selector(goHome), keyEquivalent: "h").target = self
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "Quit Casework", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit"); editItem.submenu = editMenu
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Casework"; window.minSize = NSSize(width: 960, height: 620)
        window.collectionBehavior = [.fullScreenPrimary]; window.delegate = self
        window.acceptsMouseMovedEvents = true
        window.contentView = NSHostingView(rootView: WorkspaceView(model: workspace)); window.center()
        workspace.window = window; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        keys = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel]) { [weak self] event in
            guard let self else { return event }
            if event.type != .keyDown {
                if event.type != .mouseMoved || abs(event.deltaX) + abs(event.deltaY) > 2 { self.workspace.noteInput(.pointer) }
                return event
            }
            let wasController = self.workspace.inputMode == .controller
            self.workspace.noteInput(.keyboard)
            if event.modifierFlags.contains(.command) {
                if wasController, self.workspace.keyboardText != nil, event.charactersIgnoringModifiers?.lowercased() == "v", let pasted = NSPasteboard.general.string(forType: .string) {
                    self.workspace.type(pasted); return nil
                }
                return event
            }
            if self.workspace.keyboardText != nil {
                if event.keyCode == 53 { self.workspace.back(); return nil }
                // Preserve the first physical key while SwiftUI swaps the virtual keyboard for a TextField.
                if wasController {
                    if event.keyCode == 36 { self.workspace.submitText() }
                    else if event.keyCode == 51 { self.workspace.deleteCharacter() }
                    else if let chars = event.characters, chars.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) { self.workspace.type(chars) }
                    return nil
                }
                return event
            }
            if self.workspace.browser != nil { return event }
            let actions: [UInt16: String] = [123: "left", 124: "right", 125: "down", 126: "up", 36: "select", 76: "select", 53: "back", 115: "home", 116: "previous", 121: "next"]
            if let action = actions[event.keyCode] { self.workspace.input(action); return nil }
            let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
            if self.workspace.page.music && key == "v" { if !event.isARepeat { self.workspace.input("visualizer") }; return nil }
            if self.workspace.page.music && [" ", "k", "j", "l"].contains(key) {
                if !event.isARepeat { self.workspace.input(["j": "previous", "l": "next"][key] ?? "pause") }; return nil
            }
            if self.workspace.player != nil {
                let shortcuts = [" ": "pause", "k": "pause", "j": "previous", "l": "next", "m": "mute", "c": "captions", "f": "fullscreen", "o": "menu"]
                if let action = shortcuts[key] { if !event.isARepeat || ["j", "l"].contains(key) { self.workspace.input(action) }; return nil }
            }
            if key == "f" { self.workspace.input("fullscreen"); return nil }
            return event
        }
        workspace.start()
        if !CommandLine.arguments.contains("--windowed") { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.window.toggleFullScreen(nil) } }
    }
    @objc func toggleFullscreen() { window.toggleFullScreen(nil) }
    @objc func goHome() { workspace.home() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { workspace.stopPlayback() }
}
@main struct CaseworkMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate(); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
