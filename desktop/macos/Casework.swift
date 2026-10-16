import AppKit
import SwiftUI
import AVKit
import MediaPlayer
import CoreImage

struct Tile: Identifiable {
    let id = UUID()
    var title: String
    var subtitle = ""
    var symbol = "square.grid.2x2"
    var image: URL? = nil
    var backdrop: URL? = nil
    var run: () -> Void
}
struct Shelf {
    var title: String
    var start: Int
    var count: Int
}
struct Page {
    let id = UUID()
    var title: String
    var subtitle: String
    var tiles: [Tile]
    var columns = 4
    var selection = 0
    var cinema = false
    var music = false
    var shelves: [Shelf] = []
    var feature: Tile? = nil
}

enum InputMode: String { case controller, keyboard, pointer }

@MainActor final class Workspace: ObservableObject {
    @Published var inputMode: InputMode = .pointer
    @Published var playerControlsVisible = true
    @Published var playerControlSelection = 2
    @Published var playbackPosition = 0.0
    @Published var playbackDuration = 0.0
    @Published var playbackPaused = true
    @Published var playbackMuted = false
    @Published var playbackVolume: Float = 1
    @Published var captionsEnabled = false
    private var controlsLastUsed = ProcessInfo.processInfo.systemUptime
    static let transport = ["Back", "Rewind 10 seconds", "Play / pause", "Forward 10 seconds", "Captions", "Mute", "Fullscreen", "More"]
    @Published var page = Page(title: "Casework", subtitle: "Your Cyberdeck", tiles: [])
    @Published var selection = 0
    @Published var busy = false
    @Published var message = ""
    @Published var browser: CompatibilityBrowser?
    @Published var player: AVPlayer?
    @Published var playbackTitle = ""
    @Published var playbackStatus = ""
    @Published var playerMenu = false
    @Published var playerMenuSelection = 0
    @Published var caption = ""
    private var captionsOn = false
    private var captions: [CaptionCue] = []
    static let playerActions = ["Resume", "Rewind 30 seconds", "Forward 30 seconds", "Captions", "Mute / unmute", "Stop playback"]
    @Published var keyboardText: String? = nil
    @Published var keyboardSelection = 0
    @Published var controllerNames: [String] = []
    var window: NSWindow?
    let deck: API
    lazy var music = SpotifyConnection(deck: deck)
    @Published var musicVisualizer = false
    let controllers = ControllerInput()
    let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Casework")
    private var afterglow: API?
    private var gamesPrefix: String?
    private var stack: [Page] = []
    private var task: Task<Void, Never>?
    private var keyboardSubmit: ((String) -> Void)?
    private var playback: Object = [:]
    private var playbackHash = ""
    private var playbackFile = 0
    private var playbackTimer: Timer?
    private var playerObservation: NSKeyValueObservation?
    private var timeObservation: Any?
    private var gameProcess: Process?
    private var externalGame = false
    private var gameLog: FileHandle?
    private var gameInput: Pipe?
    private var socket: URLSessionWebSocketTask?
    private var controlConnected = false
    private var localControl: LocalControl?
    private var generation = UUID()
    private var mediaHasPlayed = false
    private var videoOutput: AVPlayerItemVideoOutput?
    private var videoFrame: Data?
    private var decodedFrames = 0
    private let verification = CommandLine.arguments.contains("--verify")
    private var nextEpisode: (() -> Void)?
    static let keyboard = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").map(String.init) + ["Space", "Delete", "Clear", "Done"]
    static let systems = ["NES", "SNES", "N64", "GB", "GBC", "GBA", "Genesis", "SMS", "GG"]
    static let cores = ["NES": "fceumm", "SNES": "snes9x", "N64": "parallel_n64", "GB": "gambatte", "GBC": "gambatte", "GBA": "mgba", "Genesis": "genesis_plus_gx", "SMS": "genesis_plus_gx", "GG": "genesis_plus_gx"]
    private let token: String
    init() {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cyberdeck/token")
        token = (try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) ?? ""
        deck = API(CommandLine.arguments.contains("--music-fixture") && CommandLine.arguments.contains("--verify") ? "http://127.0.0.1:4779" : "http://127.0.0.1:4777", token: token)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    func start() {
        home(); controllers.action = { [weak self] in self?.noteInput(.controller); self?.input($0) }
        controllers.ownedGameRunning = { [weak self] in self?.gameProcess?.isRunning == true || self?.externalGame == true }
        controllers.start(); connectControl()
        let remote = LocalControl(token: token)
        remote.handle = { [weak self] route, body in
            guard let self else { return (Data(), "application/json") }
            if route == "POST /test-key", self.verification, let window = self.window {
                let key = string(body["key"])
                if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: UInt16(number(body["code"]))) { NSApp.postEvent(event, atStart: false) }
            }
            if route == "POST /input" { self.noteInput(InputMode(rawValue: string(body["source"])) ?? .controller); self.input(string(body["action"])) }
            if route == "GET /video-frame", self.verification { return (self.videoFrame ?? Data(), "image/png") }
            if route == "POST /text", self.keyboardText != nil { self.keyboardText = String(string(body["text"]).prefix(120)) }
            if route == "GET /snapshot", let view = self.window?.contentView,
               let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: rep)
                return (rep.representation(using: .png, properties: [:]) ?? Data(), "image/png")
            }
            return ((try? JSONSerialization.data(withJSONObject: self.state(), options: [.sortedKeys])) ?? Data(), "application/json")
        }
        do { try remote.start(); localControl = remote } catch { message = "Local remote control unavailable: \(error.localizedDescription)" }
        MPRemoteCommandCenter.shared().playCommand.addTarget { [weak self] _ in Task { @MainActor in self?.player?.play() }; return .success }
        MPRemoteCommandCenter.shared().pauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.player?.pause() }; return .success }
        MPRemoteCommandCenter.shared().togglePlayPauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.input("pause") }; return .success }
    }
    func state() -> Object {
        var result: Object = ["inputMode": inputMode.rawValue, "onscreenKeyboard": keyboardText != nil && inputMode == .controller, "title": page.title, "tiles": page.tiles.map(\.title), "selection": selection,
            "focused": page.tiles.indices.contains(selection) ? page.tiles[selection].title : "", "busy": busy,
            "message": message, "controllers": controllers.names, "fullscreen": window?.styleMask.contains(.fullScreen) ?? false,
            "shelves": page.shelves.map { ["start": $0.start, "count": $0.count] }, "cinema": page.cinema, "music": page.music, "musicVisualizer": musicVisualizer, "spotify": music.playback, "spotifyError": music.error, "spotifyDevice": music.deviceName, "controllerInput": controllers.diagnostics, "active": NSApp.isActive, "controlConnected": controlConnected, "gameRunning": gameProcess?.isRunning == true, "native": true, "verification": verification, "compatibility": browser?.web.url?.absoluteString as Any? ?? NSNull(),
            "keyboard": keyboardText as Any? ?? NSNull(), "keyboardSelection": keyboardSelection]
        if let player {
            result["player"] = ["title": playbackTitle, "status": player.currentItem?.status.rawValue ?? 0,
                "rate": player.rate, "time": finite(player.currentTime().seconds), "originalTime": position(),
                "duration": number(playback["duration"]), "buffer": playbackStatus, "decodedFrames": decodedFrames, "menu": playerMenu, "caption": caption,
                "controlsVisible": playerControlsVisible, "controlSelection": playerControlSelection, "error": player.currentItem?.error?.localizedDescription ?? ""] as Object
        }
        return result
    }
    func noteInput(_ mode: InputMode) {
        if inputMode != mode { inputMode = mode; browser?.setInputMode(mode.rawValue) }
        if player != nil && mode != .controller { wakePlayerControls() }
    }
    func wakePlayerControls() { controlsLastUsed = ProcessInfo.processInfo.systemUptime; playerControlsVisible = true }
    func submitText() {
        guard let text = keyboardText else { return }
        let submit = keyboardSubmit; keyboardText = nil; keyboardSubmit = nil; submit?(text)
    }
    func seekTo(_ target: Double) { seek(target - position()); wakePlayerControls() }
    func setVolume(_ value: Float) { player?.volume = value; playbackVolume = value; wakePlayerControls() }
    func activateTransport(_ index: Int) {
        wakePlayerControls()
        switch index {
        case 0: cancel(); stopPlayback()
        case 1: seek(-10)
        case 2: if player?.rate ?? 0 > 0 { player?.pause() } else { player?.play() }
        case 3: seek(10)
        case 4: toggleCaptions()
        case 5: player?.isMuted.toggle()
        case 6: window?.toggleFullScreen(nil)
        default: playerMenu.toggle(); playerMenuSelection = 0
        }
    }
    private func finite(_ x: Double) -> Double { x.isFinite ? x : 0 }
    func show(_ title: String, _ subtitle: String = "", _ tiles: [Tile], columns: Int = 4, push: Bool = true) {
        if push { var old = page; old.selection = selection; stack.append(old) }
        page = Page(title: title, subtitle: subtitle, tiles: tiles, columns: columns); selection = 0; message = ""
    }
    func work(_ operation: @escaping () async throws -> Void) {
        task?.cancel(); generation = UUID(); let current = generation
        busy = true; message = ""
        task = Task { [weak self] in
            do { try await operation() }
            catch is CancellationError { }
            catch { if !Task.isCancelled, self?.generation == current { self?.message = error.localizedDescription } }
            if self?.generation == current { self?.busy = false }
        }
    }
    private func cancel() { task?.cancel(); generation = UUID(); busy = false }
    func home() {
        cancel(); musicVisualizer = false; keyboardText = nil; stopPlayback(); browser?.close(); browser = nil
        if let process = gameProcess, process.isRunning {
            try? gameInput?.fileHandleForWriting.write(contentsOf: Data("QUIT\n".utf8))
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { if process.isRunning { process.interrupt() } }
        }
        externalGame = false
        stack = []
        show("Casework", "CLIPPER  /  CYBERDECK", [
            Tile(title: "Afterglow", subtitle: "Films, series & your library", symbol: "play.rectangle.fill", run: { [weak self] in self?.mediaHome() }),
            Tile(title: "Games", subtitle: "The Vault · native play", symbol: "gamecontroller.fill", run: { [weak self] in self?.gamesHome() }),
            Tile(title: "Cyberdeck", subtitle: "Your machines & workspace", symbol: "rectangle.connected.to.line.below", run: { [weak self] in self?.deckHome() }),
            Tile(title: "Applications", subtitle: "Everything on your deck", symbol: "square.grid.2x2.fill", run: { [weak self] in self?.applications() }),
            Tile(title: "Settings", subtitle: "Display & controllers", symbol: "gearshape.fill", run: { [weak self] in self?.settings() })
        ], push: false)
        NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil)
    }
    func back() {
        if keyboardText != nil { keyboardText = nil; keyboardSubmit = nil; return }
        if page.music && musicVisualizer { musicVisualizer = false; return }
        if player != nil { if playerMenu { playerMenu = false } else { cancel(); stopPlayback() }; return }
        if let browser {
            if browser.web.canGoBack { browser.web.goBack() } else { browser.close(); self.browser = nil; message = "" }; return
        }
        cancel()
        if let old = stack.popLast() { page = old; selection = old.selection; message = "" } else { home() }
    }
    func input(_ action: String) {
        if action == "game-screenshot", verification, gameProcess?.isRunning == true {
            try? gameInput?.fileHandleForWriting.write(contentsOf: Data("SCREENSHOT\n".utf8)); return
        }
        if action == "fullscreen" { window?.toggleFullScreen(nil); return }
        if action == "home" { home(); return }
        if action == "back" { back(); return }
        if let text = keyboardText {
            let count = Self.keyboard.count
            switch action {
            case "left": keyboardSelection = max(0, keyboardSelection - 1)
            case "right": keyboardSelection = min(count - 1, keyboardSelection + 1)
            case "up": keyboardSelection = max(0, keyboardSelection - 8)
            case "down": keyboardSelection = min(count - 1, keyboardSelection + 8)
            case "select":
                let key = Self.keyboard[keyboardSelection]
                if key == "Done" { let submit = keyboardSubmit; keyboardText = nil; keyboardSubmit = nil; submit?(text) }
                else if key == "Delete" { keyboardText = String(text.dropLast()) }
                else if key == "Clear" { keyboardText = "" }
                else if text.count < 120 { keyboardText = text + (key == "Space" ? " " : key) }
            default: break
            }; return
        }
        if let browser { browser.input(action); return }
        if let player {
            let controlsWereVisible = playerControlsVisible
            wakePlayerControls()
            if action == "captions" { toggleCaptions(); return }
            if action == "mute" { player.isMuted.toggle(); return }
            if action == "menu" { playerMenu.toggle(); playerMenuSelection = 0; return }
            if playerMenu {
                switch action {
                case "left": playerMenuSelection = max(0, playerMenuSelection - 1)
                case "right": playerMenuSelection = min(Self.playerActions.count - 1, playerMenuSelection + 1)
                case "up": playerMenuSelection = max(0, playerMenuSelection - 3)
                case "down": playerMenuSelection = min(Self.playerActions.count - 1, playerMenuSelection + 3)
                case "select":
                    switch playerMenuSelection {
                    case 0: playerMenu = false; player.play()
                    case 1: seek(-30)
                    case 2: seek(30)
                    case 3: toggleCaptions()
                    case 4: player.isMuted.toggle()
                    default: cancel(); stopPlayback()
                    }
                default: break
                }; return
            }
            if inputMode == .controller {
                if action == "up" || action == "down" { playerControlSelection = 2; return }
                if action == "left" || action == "right" {
                    if controlsWereVisible { playerControlSelection = max(0, min(Self.transport.count - 1, playerControlSelection + (action == "left" ? -1 : 1))) }
                    else { seek(action == "left" ? -10 : 10) }
                    return
                }
                if action == "select" { if controlsWereVisible { activateTransport(playerControlSelection) } else { activateTransport(2) }; return }
            }
            switch action {
            case "select", "pause": if player.rate > 0 { player.pause() } else { player.play() }
            case "left", "previous": seek(-10)
            case "right", "next": seek(10)
            case "up": player.volume = min(1, player.volume + 0.1)
            case "down": player.volume = max(0, player.volume - 0.1)
            case "search": player.isMuted.toggle()
            default: break
            }; return
        }
        if page.music {
            if action == "visualizer" { toggleMusicVisualizer(); return }
            if musicVisualizer && ["left", "right", "up", "down"].contains(action), page.shelves.count > 1 {
                let controls = page.shelves[1]
                selection = max(controls.start, min(controls.start + controls.count - 1, selection + (["left", "up"].contains(action) ? -1 : 1))); return
            }
            if ["pause", "menu"].contains(action) { musicControl("toggle"); return }
            if ["previous", "next"].contains(action) { musicControl(action); return }
            if action == "search" { musicVisualizer = false; enterText { [weak self] in self?.musicSearch($0) }; return }
        }
        if page.cinema, let rowIndex = page.shelves.firstIndex(where: { selection >= $0.start && selection < $0.start + $0.count }) {
            let row = page.shelves[rowIndex], column = selection - page.shelves[rowIndex].start
            switch action {
            case "left": selection = max(row.start, selection - 1); return
            case "right": selection = min(row.start + row.count - 1, selection + 1); return
            case "up", "down":
                let target = max(0, min(page.shelves.count - 1, rowIndex + (action == "up" ? -1 : 1)))
                let other = page.shelves[target]; selection = other.start + min(column, other.count - 1); return
            case "previous": selection = max(row.start, selection - 5); return
            case "next": selection = min(row.start + row.count - 1, selection + 5); return
            case "search": enterText { [weak self] in self?.catalog("all", search: $0) }; return
            default: break
            }
        }
        switch action {
        case "left": selection = max(0, selection - 1)
        case "right": selection = min(max(0, page.tiles.count - 1), selection + 1)
        case "up": selection = max(0, selection - page.columns)
        case "down": selection = min(max(0, page.tiles.count - 1), selection + page.columns)
        case "previous": selection = max(0, selection - page.columns * 3)
        case "next": selection = min(max(0, page.tiles.count - 1), selection + page.columns * 3)
        case "select", "pause", "menu": if page.tiles.indices.contains(selection) { page.tiles[selection].run() }
        case "search": if let tile = page.tiles.first(where: { $0.title == "Search" }) { tile.run() }
        default: break
        }
    }
    func enterText(_ title: String = "Search", submit: @escaping (String) -> Void) {
        keyboardText = ""; keyboardSelection = 0; keyboardSubmit = submit
    }
    func type(_ value: String) { if keyboardText != nil { keyboardText = String((keyboardText! + value).prefix(120)) } }
    func deleteCharacter() { if let text = keyboardText { keyboardText = String(text.dropLast()) } }
    func settings() {
        controllerNames = controllers.names
        show("Settings", controllers.names.isEmpty ? "Connect a controller in macOS Bluetooth settings." : controllers.names.joined(separator: " · "), [
            Tile(title: "Toggle fullscreen", subtitle: "Launches fullscreen by default", symbol: "arrow.up.left.and.arrow.down.right", run: { [weak self] in self?.window?.toggleFullScreen(nil) }),
            Tile(title: "Controller guide", subtitle: "A select · B back · Y/Home home · X search", symbol: "gamecontroller", run: { [weak self] in self?.message = "D-pad / left stick: move. A: select / pause. B: back. Y/Home: Casework. X: search / mute. Shoulders: page / seek. In games: Home or Back + Start returns and saves." }),
            Tile(title: "Reconnect", subtitle: "Reconnect to Cyberdeck", symbol: "arrow.clockwise", run: { [weak self] in self?.afterglow = nil; self?.gamesPrefix = nil; self?.connectControl(); self?.message = "Reconnecting…" }),
            Tile(title: "Back to macOS", subtitle: "Close Casework", symbol: "desktopcomputer", run: { NSApp.terminate(nil) })
        ])
    }

    // MARK: Afterglow. Reads never start downloads. Only explicit Watch submits a job.
    func mediaAPI() async throws -> API {
        if let afterglow { return afterglow }
        let data = try await deck.json("/api/applications")
        guard let app = objects(data["applications"]).first(where: { string($0["id"]) == "afterglow" }),
              let url = URL(string: string(app["url"])), ["https", "http"].contains(url.scheme ?? "") else {
            throw Failure(message: "Afterglow is not registered on this Cyberdeck.")
        }
        let api = API(url.absoluteString); afterglow = api; return api
    }
    private func mediaNavigation() -> [Tile] {
        [Tile(title: "Library", symbol: "rectangle.stack", run: { [weak self] in self?.library() }),
         Tile(title: "Films", symbol: "film", run: { [weak self] in self?.catalog("movie") }),
         Tile(title: "Series", symbol: "tv", run: { [weak self] in self?.catalog("series") }),
         Tile(title: "Search", symbol: "magnifyingglass", run: { [weak self] in self?.enterText { self?.catalog("all", search: $0) } }),
         Tile(title: "Music", symbol: "music.note", run: { [weak self] in self?.musicHome() }),
         Tile(title: "My list", symbol: "bookmark", run: { [weak self] in self?.saved() }),
         Tile(title: "Full Afterglow", symbol: "square.on.square", run: { [weak self] in self?.work {
             guard let self else { return }; let api = try await self.mediaAPI(); self.openCompatibility(api.origin)
         } })]
    }
    private func showCinema(_ title: String, rows: [(String, [Tile])], feature: Tile? = nil, push: Bool = true) {
        var tiles = mediaNavigation()
        var shelves = [Shelf(title: "", start: 0, count: tiles.count)]
        for (name, row) in rows where !row.isEmpty {
            shelves.append(Shelf(title: name, start: tiles.count, count: row.count)); tiles += row
        }
        show(title, "AFTERGLOW", tiles, push: push)
        page.cinema = true; page.shelves = shelves; page.feature = feature
        selection = shelves.count > 1 ? shelves[1].start : 0
    }
    func mediaHome() {
        showCinema("Afterglow", rows: [])
        work { [self] in
            let api = try await mediaAPI()
            async let downloads = api.json("/api/library")
            async let films = api.json("/api/catalog?type=movie")
            async let series = api.json("/api/catalog?type=series")
            let library = try await downloads
            try Task.checkCancellation()
            let ready = libraryTiles(objects(library["items"]))
            showCinema("Afterglow", rows: [("Ready to watch", ready)], push: false)
            let movies = (try? await films) ?? [:], shows = (try? await series) ?? [:]
            try Task.checkCancellation()
            let focused = selection
            showCinema("Afterglow", rows: [("Ready to watch", ready),
                ("Discover films", objects(movies["items"]).map(mediaTile)),
                ("Discover series", objects(shows["items"]).map(mediaTile))], push: false)
            selection = min(focused, max(0, page.tiles.count - 1))
        }
    }
    private func mediaTile(_ media: Object) -> Tile {
        Tile(title: string(media["name"]), subtitle: [string(media["year"]), string(media["runtime"]), string(media["rating"])].filter { !$0.isEmpty }.joined(separator: " · "), symbol: "film", image: URL(string: string(media["poster"])), backdrop: URL(string: string(media["background"])), run: { [weak self] in self?.title(media) })
    }
    func catalog(_ type: String, search: String = "") {
        work { [self] in
            let api = try await mediaAPI()
            let types = type == "all" ? ["movie", "series"] : [type]
            var items: [Object] = []
            for t in types { items += objects(try await api.json("/api/catalog?" + query(["type": t, "q": search]))["items"]) }
            try Task.checkCancellation()
            showCinema(search.isEmpty ? (type == "series" ? "Series" : "Films") : "Results for “\(search)”", rows: [(search.isEmpty ? "Choose something to watch" : "Search results", items.map(mediaTile))])
        }
    }
    func saved() {
        work { [self] in let api = try await mediaAPI(); let result = try await api.json("/api/state"); try Task.checkCancellation(); showCinema("My list", rows: [("Saved for later", objects(result["saved"]).map(mediaTile))]) }
    }
    func title(_ media: Object) {
        if string(media["type"]) == "series", objects(media["episodes"]).isEmpty {
            work { [self] in
                let api = try await mediaAPI()
                let full = try await api.json("/api/meta/series/" + string(media["id"]))
                try Task.checkCancellation(); titleDetails(full)
            }
        } else { titleDetails(media) }
    }
    private func titleDetails(_ media: Object) {
        var tiles: [Tile] = []
        if string(media["type"]) == "series" {
            let episodes = objects(media["episodes"])
            let seasons = Set(episodes.map { Int(number($0["season"])) }).sorted()
            tiles = seasons.map { season in Tile(title: "Season \(season)", symbol: "rectangle.stack", run: { [weak self] in self?.episodes(media, season: season) }) }
        } else {
            tiles.append(Tile(title: "Watch", subtitle: "Play or find a release", symbol: "play.fill", run: { [weak self] in self?.watch(media) }))
        }
        tiles.append(Tile(title: "Save to my list", symbol: "bookmark", run: { [weak self] in self?.work {
            guard let self else { return }; let api = try await self.mediaAPI(); _ = try await api.json("/api/saved", body: ["type": string(media["type"]), "id": string(media["id"])]); self.message = "Saved to your list."
        } }))
        showCinema(string(media["name"]), rows: [("Watch", tiles)], feature: Tile(title: string(media["name"]), subtitle: string(media["description"]), image: URL(string: string(media["poster"])), backdrop: URL(string: string(media["background"])), run: {}))
    }
    func episodes(_ media: Object, season: Int) {
        let episodes = objects(media["episodes"]).filter { Int(number($0["season"])) == season }
        let tiles = episodes.map { episode in
            let code = String(format: "S%02dE%02d", season, Int(number(episode["episode"])))
            return Tile(title: "\(code) · \(string(episode["name"]))", subtitle: string(episode["description"]), symbol: "play.fill", image: URL(string: string(episode["image"])), run: { [weak self] in self?.episodeDetail(media, episode: episode, code: code) })
        }
        showCinema(string(media["name"]), rows: [("Season \(season)", tiles)])
    }
    private func episodeDetail(_ media: Object, episode: Object, code: String) {
        showCinema("\(code) · \(string(episode["name"]))", rows: [("Watch episode", [Tile(title: "Watch episode", symbol: "play.fill", run: { [weak self] in self?.watch(media, episode: code) })])], feature: Tile(title: string(episode["name"]), subtitle: string(episode["description"]), image: URL(string: string(media["poster"])), backdrop: URL(string: string(episode["image"])), run: {}))
    }
    func library() {
        work { [self] in
            let api = try await mediaAPI(); let result = try await api.json("/api/library"); try Task.checkCancellation()
            guard result["items"] is [Object] else { throw Failure(message: string(result["error"])) }
            showCinema("Library", rows: [("Ready to watch", libraryTiles(objects(result["items"])))])
        }
    }
    private func libraryTiles(_ items: [Object]) -> [Tile] {
        var tiles: [Tile] = []; var seen = Set<String>()
        for item in items {
            let media = object(item["media"])
            if string(media["type"]) == "series" {
                let id = string(media["id"])
                guard !seen.contains(id) else { continue }; seen.insert(id)
                let group = items.filter { string(object($0["media"])["id"]) == id }
                tiles.append(Tile(title: string(media["name"]), subtitle: "\(group.count) downloaded episodes", symbol: "tv", image: URL(string: string(media["poster"])), backdrop: URL(string: string(media["background"])), run: { [weak self] in self?.downloadedSeries(media, items: group) }))
            } else { tiles.append(libraryTile(item)) }
        }
        return tiles
    }
    private func libraryTile(_ item: Object) -> Tile {
        let media = object(item["media"])
        return Tile(title: string(item["episode"]).isEmpty ? (string(media["name"]).isEmpty ? string(item["name"]) : string(media["name"])) : string(item["episode"]), subtitle: "Ready to play · A to watch", symbol: "play.rectangle", image: URL(string: string(media["poster"])), backdrop: URL(string: string(media["background"])), run: { [weak self] in self?.downloadDetail(item) })
    }
    private func downloadedSeries(_ media: Object, items: [Object]) {
        var tiles = items.sorted { string($0["episode"]) < string($1["episode"]) }.map(libraryTile)
        tiles.append(Tile(title: "All seasons", symbol: "rectangle.stack", run: { [weak self] in self?.title(media) }))
        showCinema(string(media["name"]), rows: [("Downloaded episodes", tiles)])
    }
    private func downloadDetail(_ item: Object) {
        let files = objects(item["files"]).filter { $0["video"] as? Bool == true }
        let choices = files.map { file in
            let index = Int(number(file["index"])); let hash = string(item["hash"])
            let progress = object(object(item["progress"])["\(hash):\(index)"])
            let position = number(progress["position"]), duration = number(progress["duration"])
            let resume = duration > 0 && position / duration < 0.95 ? position : 0
            return Tile(title: resume > 0 ? "Resume · \(Int(resume / 60)) min" : "Play", subtitle: string(file["name"]), symbol: "play.fill", run: { [weak self] in self?.play(hash: hash, file: index, position: resume, title: string(object(item["media"])["name"]).isEmpty ? string(item["name"]) : string(object(item["media"])["name"])) })
        }
        if choices.count == 1 { choices[0].run() }
        else if choices.isEmpty { message = "No playable video files are available in this download yet." }
        else { showCinema(string(object(item["media"])["name"]), rows: [("Choose a video", choices)]) }
    }
    private func watch(_ media: Object, episode: String = "") {
        work { [self] in
            let api = try await mediaAPI()
            let data = try await api.json("/api/watch", body: ["mediaId": string(media["id"]), "type": string(media["type"]), "episode": episode])
            let id = string(object(data["request"])["id"])
            guard !id.isEmpty else { throw Failure(message: "Afterglow did not return a watch request.") }
            for _ in 0..<180 {
                try Task.checkCancellation()
                let result = try await api.json("/api/library")
                if let job = objects(result["requests"]).first(where: { string($0["id"]) == id }) {
                    message = string(job["message"])
                    let status = string(job["status"])
                    if status == "ready" {
                        let info = object(job["playback"])
                        guard !string(info["url"]).isEmpty else { throw Failure(message: "Download is ready. Open it from Library.") }
                        try await beginPlayback(info, hash: string(job["hash"]), file: Int(number(job["file"])), title: string(media["name"]) + (episode.isEmpty ? "" : " · " + episode))
                        return
                    }
                    if ["failed", "cancelled", "interrupted"].contains(status) { throw Failure(message: string(job["message"])) }
                }
                try await Task.sleep(nanoseconds: 2_000_000_000)
            }
            throw Failure(message: "This download is still preparing. Check Library for its status.")
        }
    }
    func play(hash: String, file: Int, position: Double, title: String, autoplay: Bool = true) {
        work { [self] in
            message = "Starting playback… B to cancel"
            let api = try await mediaAPI(); let info = try await api.json("/api/playback", body: ["hash": hash, "file": file, "position": position])
            try Task.checkCancellation(); message = ""; try await beginPlayback(info, hash: hash, file: file, title: title, autoplay: autoplay)
        }
    }
    private func beginPlayback(_ info: Object, hash: String, file: Int, title: String, autoplay: Bool = true) async throws {
        try await music.pauseForVideo()
        let api = try await mediaAPI(); let url = try api.url(string(info["url"]))
        let replacing = player != nil && playbackHash == hash && playbackFile == file
        let controlSelection = playerControlSelection
        let keepCaptions = playbackHash == hash && playbackFile == file && captionsOn
        let priorCaptions = keepCaptions ? captions : []
        let priorVolume = player?.volume ?? playbackVolume, priorMute = player?.isMuted ?? playbackMuted
        stopPlayback(); captionsOn = keepCaptions; captions = priorCaptions; playback = info; playbackHash = hash; playbackFile = file; playbackTitle = title; playbackStatus = "Preparing playback…"; mediaHasPlayed = false
        let item = AVPlayerItem(url: url)
        decodedFrames = 0; videoFrame = nil
        if verification {
            let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            item.add(output); videoOutput = output
        }
        let newPlayer = AVPlayer(playerItem: item); newPlayer.volume = priorVolume; newPlayer.isMuted = priorMute; player = newPlayer
        playbackDuration = number(info["duration"]); playbackPosition = number(info["offset"])
        playerControlSelection = replacing ? controlSelection : 2; wakePlayerControls()
        playerObservation = item.observe(\.status, options: [.new, .initial]) { [weak self, weak newPlayer] item, _ in
            Task { @MainActor in
                guard let self, let newPlayer, self.player === newPlayer else { return }
                if item.status == .failed { self.playbackStatus = item.error?.localizedDescription ?? "Playback failed. Use Back to return." }
                if item.status == .readyToPlay {
                    let start = number(info["startPosition"])
                    if start > 0 { await newPlayer.seek(to: CMTime(seconds: start, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) }
                    if autoplay { newPlayer.play() }; self.playbackStatus = autoplay ? "" : "Paused"
                }
            }
        }
        timeObservation = newPlayer.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self, weak newPlayer] _ in
            MainActor.assumeIsolated {
                guard let self, let newPlayer, self.player === newPlayer else { return }
                self.playbackPosition = self.position(); self.playbackPaused = newPlayer.rate == 0
                self.playbackMuted = newPlayer.isMuted; self.playbackVolume = newPlayer.volume; self.captionsEnabled = self.captionsOn
                if newPlayer.rate > 0 && !self.playerMenu && ProcessInfo.processInfo.systemUptime - self.controlsLastUsed > 4 { self.playerControlsVisible = false }
                if newPlayer.rate > 0, newPlayer.currentTime().seconds > 0 { self.mediaHasPlayed = true }
                if let output = self.videoOutput, output.hasNewPixelBuffer(forItemTime: newPlayer.currentTime()),
                   let buffer = output.copyPixelBuffer(forItemTime: newPlayer.currentTime(), itemTimeForDisplay: nil) {
                    self.decodedFrames += 1
                    if self.decodedFrames % 4 == 1 {
                        let image = CIImage(cvPixelBuffer: buffer)
                        if let cg = CIContext().createCGImage(image, from: image.extent) {
                            self.videoFrame = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
                        }
                    }
                }
                if self.captionsOn {
                    let time = self.position()
                    self.caption = self.captions.filter { $0.start <= time && $0.end > time }.map(\.text).joined(separator: "\n")
                }
                if newPlayer.currentItem?.status == .readyToPlay {
                    self.playbackStatus = newPlayer.timeControlStatus == .waitingToPlayAtSpecifiedRate ? "Buffering…" : (newPlayer.rate == 0 ? "Paused" : "")
                }
            }
        }
        playbackTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.saveProgress() } }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: title]
    }
    private func position() -> Double { finite(player?.currentTime().seconds ?? 0) + number(playback["offset"]) }
    private func saveProgress() {
        guard player != nil, let api = afterglow else { return }
        let hash = playbackHash, file = playbackFile, position = position(), duration = number(playback["duration"]), session = string(playback["session"]), played = mediaHasPlayed
        Task {
            if !session.isEmpty { _ = try? await api.json("/api/playback/\(session)/heartbeat", body: [:]) }
            if played, !verification, !hash.isEmpty, duration > 0 { _ = try? await api.json("/api/progress", body: ["hash": hash, "file": file, "position": position, "duration": duration]) }
        }
    }
    func stopPlayback() {
        guard let player else { return }; saveProgress(); player.pause()
        if let timeObservation { player.removeTimeObserver(timeObservation) }; timeObservation = nil
        playerObservation = nil; videoOutput = nil; playbackTimer?.invalidate(); playbackTimer = nil; self.player = nil
        // Do not stop Afterglow's shared converter: another client may be using its window.
        playback = [:]; playerMenu = false; captionsOn = false; captions = []; caption = ""; MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
    private func toggleCaptions() {
        if captionsOn { captionsOn = false; caption = ""; return }
        if !captions.isEmpty { captionsOn = true; playerMenu = false; return }
        let hash = playbackHash, file = playbackFile
        let tracks = objects(playback["subtitles"])
        guard let track = tracks.first(where: { string($0["language"]).hasPrefix("en") }) ?? tracks.first else { message = "No embedded text captions were found."; return }
        let stream = Int(number(track["index"]))
        guard let api = afterglow, !hash.isEmpty else { message = "No captions available."; return }
        work { [self] in
            let request = try api.request("/api/subtitles?" + query(["hash": hash, "file": String(file), "stream": String(stream)]))
            let (data, response) = try await api.session.data(for: request)
            try Task.checkCancellation()
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure(message: "No text subtitles were found in this download.") }
            guard playbackHash == hash, playbackFile == file else { return }
            captions = parseCaptions(String(data: data, encoding: .utf8) ?? "")
            captionsOn = true; playerMenu = false
        }
    }
    private func seek(_ delta: Double) {
        guard let player else { return }
        let target = max(0, min(max(0, number(playback["duration"]) - 1), position() + delta))
        let relative = target - number(playback["offset"])
        if string(playback["session"]).isEmpty || (relative >= 0 && target < number(playback["availableEnd"]) - 1) {
            player.seek(to: CMTime(seconds: relative, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        } else { play(hash: playbackHash, file: playbackFile, position: target, title: playbackTitle, autoplay: player.rate > 0) }
    }

    // MARK: Games. Catalog/data come from the paired fleet; gameplay runs on this Mac.
    private func gameRoute(_ suffix: String) async throws -> String {
        if let gamesPrefix { return gamesPrefix + suffix }
        if (try? await deck.json("/api/vimm/roms")) != nil { gamesPrefix = "/api/vimm/"; return gamesPrefix! + suffix }
        let fleet = try await deck.json("/api/fleet/nodes")
        let nodes = objects(fleet["nodes"]).filter { $0["online"] as? Bool == true }.sorted { string($0["name"]).lowercased() == "enuc" && string($1["name"]).lowercased() != "enuc" }
        for node in nodes {
            let prefix = "/api/nodes/\(string(node["id"]))/proxy/vimm/"
            if (try? await deck.json(prefix + "roms")) != nil { gamesPrefix = prefix; return prefix + suffix }
        }
        throw Failure(message: "No paired Games service is reachable. Local games still work; reconnect the fleet to browse The Vault.")
    }
    func gamesHome() {
        show("Games", "THE VAULT · NATIVE ON CLIPPER", [
            Tile(title: "Ready to play", subtitle: "Games saved on this Mac", symbol: "gamecontroller.fill", run: { [weak self] in self?.localGames() }),
            Tile(title: "Fleet library", subtitle: "Play your existing game files here", symbol: "externaldrive.connected.to.line.below", run: { [weak self] in self?.fleetGames() }),
            Tile(title: "Browse consoles", subtitle: "Nine classic systems", symbol: "square.grid.3x3", run: { [weak self] in self?.gameSystems() }),
            Tile(title: "Search", subtitle: "Search The Vault", symbol: "magnifyingglass", run: { [weak self] in self?.enterText { self?.gameCatalog(search: $0) } }),
            Tile(title: "2048", subtitle: "Built-in native game", symbol: "square.grid.2x2", run: { [weak self] in
                do { try self?.launchGame(nil, system: "2048") } catch { self?.message = error.localizedDescription }
            }),
            Tile(title: "Steam", subtitle: "Open controller-friendly Big Picture", symbol: "desktopcomputer", run: { [weak self] in self?.openSteam() })
        ])
    }
    private func gameSystems() {
        show("Consoles", "THE VAULT", Self.systems.map { system in Tile(title: system, symbol: "gamecontroller", run: { [weak self] in self?.gameCatalog(system: system) }) })
    }
    private func gameCatalog(system: String = "", search: String = "", pageNumber: Int = 1) {
        work { [self] in
            if !search.isEmpty && search.count < 3 { throw Failure(message: "Enter at least three characters.") }
            let route = try await gameRoute("catalog?") + query(["system": system, "q": search, "page": String(pageNumber)])
            let data = try await deck.json(route); try Task.checkCancellation()
            let games = objects(data["games"]) + objects(data["shelves"]).flatMap { objects($0["games"]) }
            var seen = Set<String>()
            var tiles = games.filter { seen.insert(string($0["id"])).inserted }.map { game in
                Tile(title: string(game["title"]), subtitle: string(game["system"]), symbol: "gamecontroller", run: { [weak self] in self?.gameDetail(game) })
            }
            if Int(number(data["pages"])) > pageNumber { tiles.append(Tile(title: "Next page", symbol: "arrow.right", run: { [weak self] in self?.gameCatalog(system: system, search: search, pageNumber: pageNumber + 1) })) }
            show(search.isEmpty ? system : "Results for “\(search)”", "THE VAULT", tiles)
        }
    }
    private func gameDetail(_ game: Object) {
        let system = string(game["system"])
        guard Self.cores[system] != nil else { message = "Native play supports \(Self.systems.joined(separator: ", "))."; return }
        show(string(game["title"]), "\(system) · Downloads only after selecting Play", [Tile(title: "Play", subtitle: "Download & run locally", symbol: "play.fill", run: { [weak self] in self?.downloadGame(game) })])
    }
    private func downloadGame(_ game: Object) {
        work { [self] in
            let system = string(game["system"]), title = string(game["title"])
            let route = try await gameRoute("download/\(string(game["id"]))?") + query(["system": system, "title": title, "region": (game["regions"] as? [String])?.first ?? ""])
            message = "Downloading \(title)… B cancels."
            let file = try await deck.download(route, body: [:], to: root.appendingPathComponent("Games/\(system)"), fallback: "game.zip")
            try Task.checkCancellation(); try rememberGame(file, title: title, system: system); try launchGame(file, system: system)
        }
    }
    private func fleetGames() {
        work { [self] in
            let route = try await gameRoute("roms"); let data = try await deck.json(route); try Task.checkCancellation()
            show("Fleet library", "Selecting a game copies it to Clipper and plays locally. Source files and saves stay intact.", objects(data["games"]).map { game in
                Tile(title: string(game["name"]), subtitle: string(game["system"]), symbol: "gamecontroller", run: { [weak self] in self?.copyGame(game) })
            })
        }
    }
    private func copyGame(_ game: Object) {
        work { [self] in
            let system = string(game["system"]), title = string(game["name"])
            let id = string(game["id"])
            if let old = savedGames().first(where: { string($0["sourceId"]) == id }), FileManager.default.fileExists(atPath: string(old["file"])) {
                try launchGame(URL(fileURLWithPath: string(old["file"])), system: system); return
            }
            let route = try await gameRoute("roms/\(id)"); message = "Copying \(title)… B cancels."
            let file = try await deck.download(route, to: root.appendingPathComponent("Games/\(system)"), fallback: title)
            try Task.checkCancellation(); try rememberGame(file, title: title, system: system, sourceId: id); try launchGame(file, system: system)
        }
    }
    private func savedGames() -> [Object] { (try? JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("games.json")))) as? [Object] ?? [] }
    private func rememberGame(_ file: URL, title: String, system: String, sourceId: String = "") throws {
        var displayTitle = title
        if system == "N64", title.hasPrefix("vault-"), let handle = try? FileHandle(forReadingFrom: file) {
            defer { try? handle.close() }
            if let header = try? handle.read(upToCount: 64), header.count >= 52,
               let name = String(data: header.subdata(in: 32..<52), encoding: .ascii)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                displayTitle = name.localizedCapitalized
            }
        }
        var games = savedGames(); games.append(["file": file.path, "title": displayTitle, "system": system, "sourceId": sourceId])
        try JSONSerialization.data(withJSONObject: games, options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent("games.json"), options: .atomic)
    }
    private func localGames() {
        var games = savedGames().filter { FileManager.default.fileExists(atPath: string($0["file"])) }
        let base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Games")
        let folders = ["NES": "nes", "SNES": "snes", "N64": "n64", "GB": "gb", "GBC": "gbc", "GBA": "gba", "Genesis": "genesis", "SMS": "sms", "GG": "gg"]
        let extensions = Set(["nes", "sfc", "smc", "z64", "v64", "n64", "gb", "gbc", "gba", "md", "gen", "bin", "sms", "gg", "zip", "7z"])
        for (system, folder) in folders {
            let files = (try? FileManager.default.contentsOfDirectory(at: base.appendingPathComponent(folder), includingPropertiesForKeys: nil)) ?? []
            for file in files where extensions.contains(file.pathExtension.lowercased()) { games.append(["file": file.path, "title": file.deletingPathExtension().lastPathComponent, "system": system]) }
        }
        show("Ready to play", games.isEmpty ? "Use Fleet library or browse a console to add a game." : "LOCAL GAMES", games.map { game in
            Tile(title: string(game["title"]), subtitle: string(game["system"]), symbol: "gamecontroller.fill", run: { [weak self] in
                do { try self?.launchGame(URL(fileURLWithPath: string(game["file"])), system: string(game["system"])) } catch { self?.message = error.localizedDescription }
            })
        })
    }
    private func launchGame(_ file: URL?, system: String) throws {
        guard gameProcess?.isRunning != true else { throw Failure(message: "A game is already running. Press Home to return first.") }
        let executable = URL(fileURLWithPath: "/Applications/RetroArch.app/Contents/MacOS/RetroArch")
        let core = root.appendingPathComponent("cores/\(Self.cores[system] ?? (system == "2048" ? "2048" : "unknown"))_libretro.dylib")
        guard FileManager.default.isExecutableFile(atPath: executable.path), FileManager.default.fileExists(atPath: core.path) else { throw Failure(message: "The native \(system) runtime is not installed. Run desktop/macos/install-games.sh.") }
        let config = root.appendingPathComponent("retroarch.cfg")
        let saves = root.appendingPathComponent("Saves"), states = root.appendingPathComponent("States")
        try FileManager.default.createDirectory(at: saves, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: states, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: config.path) {
            let contents = """
            video_fullscreen = "true"
            video_driver = "gl"
            menu_driver = "ozone"
            audio_driver = "coreaudio"
            input_joypad_driver = "mfi"
            input_autodetect_enable = "true"
            config_save_on_exit = "false"
            savestate_auto_save = "true"
            savestate_auto_load = "true"
            quit_press_twice = "false"
            input_exit_emulator = "escape"
            input_menu_toggle_gamepad_combo = "2"
            savefile_directory = "\(saves.path)"
            savestate_directory = "\(states.path)"
            """
            try contents.write(to: config, atomically: true, encoding: .utf8)
        }
        let process = Process(); process.executableURL = executable
        let bridge = root.appendingPathComponent("retroarch-casework.cfg")
        let captures = root.appendingPathComponent("GameCaptures")
        try FileManager.default.createDirectory(at: captures, withIntermediateDirectories: true)
        let coreOptions = root.appendingPathComponent("core-options.cfg")
        let coreConfig = root.appendingPathComponent("Config")
        try FileManager.default.createDirectory(at: coreConfig, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: coreOptions.path) {
            try "parallel-n64-cpucore = \"dynamic_recompiler\"\nparallel-n64-gfxplugin = \"glide64\"\nparallel-n64-rspplugin = \"hle\"\n".write(to: coreOptions, atomically: true, encoding: .utf8)
        }
        let bridgeConfig = """
        stdin_cmd_enable = "true"
        network_cmd_enable = "false"
        video_driver = "gl"
        video_gpu_screenshot = "true"
        savestate_auto_load = "true"
        screenshot_directory = "\(captures.path)"
        core_options_path = "\(coreOptions.path)"
        rgui_config_directory = "\(coreConfig.path)"
        """
        try bridgeConfig.write(to: bridge, atomically: true, encoding: .utf8)
        gameInput = Pipe(); process.standardInput = gameInput
        process.arguments = ["--verbose", "--config", config.path, "--appendconfig", bridge.path, "--fullscreen", "-L", core.path] + (file.map { [$0.path] } ?? [])
        let log = root.appendingPathComponent("game.log"); FileManager.default.createFile(atPath: log.path, contents: nil)
        gameLog = try FileHandle(forWritingTo: log); process.standardOutput = gameLog; process.standardError = gameLog
        process.terminationHandler = { [weak self] p in Task { @MainActor in
            guard let self else { return }; self.gameProcess = nil; self.gameInput = nil; try? self.gameLog?.close(); self.gameLog = nil
            NSApp.activate(ignoringOtherApps: true); self.window?.makeKeyAndOrderFront(nil)
            if p.terminationStatus != 0 && p.terminationReason == .exit { self.message = "The emulator exited (\(p.terminationStatus)). See Casework/game.log." }
        } }
        try process.run(); gameProcess = process
        var attempts = 0
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { timer in
            attempts += 1
            guard process.isRunning, attempts < 32 else { timer.invalidate(); return }
            if let app = NSRunningApplication(processIdentifier: process.processIdentifier), app.isFinishedLaunching {
                if app.isActive { timer.invalidate() } else { app.activate(options: [.activateAllWindows]) }
            }
        }
        message = "Playing locally."
    }
    private func openSteam() {
        guard let url = URL(string: "steam://open/bigpicture") else { return }; externalGame = true; NSWorkspace.shared.open(url)
        message = "Steam is running."
    }

    // MARK: Cyberdeck API surfaces, all rendered as native controls.
    private func deckHome() {
        show("Cyberdeck", "YOUR FLEET", [
            Tile(title: "Full workspace", subtitle: "All Cyberdeck features · compatibility view", symbol: "rectangle.on.rectangle", run: { [weak self] in self?.openCompatibility(URL(string: "http://127.0.0.1:4777/")!) }),
            Tile(title: "Machines", symbol: "desktopcomputer", run: { [weak self] in self?.machines() }),
            Tile(title: "Dashboard", symbol: "gauge.with.dots.needle.50percent", run: { [weak self] in self?.resource("Dashboard", path: "/api/dashboard") }),
            Tile(title: "Projects", symbol: "folder.fill", run: { [weak self] in self?.resource("Projects", path: "/api/control/overview", key: "projects") }),
            Tile(title: "Sessions", symbol: "text.bubble.fill", run: { [weak self] in self?.sessions() }),
            Tile(title: "Files", symbol: "doc.fill", run: { [weak self] in self?.files("~") }),
            Tile(title: "Repositories", symbol: "point.3.connected.trianglepath.dotted", run: { [weak self] in self?.resource("Repositories", path: "/api/repos") }),
            Tile(title: "Services", symbol: "server.rack", run: { [weak self] in self?.resource("Services", path: "/api/control/services", key: "rows") }),
            Tile(title: "New session", subtitle: "Send a prompt or command", symbol: "plus.bubble", run: { [weak self] in self?.newSession() })
        ])
    }
    private func machines() {
        work { [self] in let data = try await deck.json("/api/fleet/nodes"); try Task.checkCancellation()
            var tiles = [Tile(title: "Clipper", subtitle: "This Mac", symbol: "desktopcomputer", run: { [weak self] in self?.resource("Clipper", path: "/api/dashboard") })]
            tiles += objects(data["nodes"]).map { node in Tile(title: string(node["name"]), subtitle: node["online"] as? Bool == true ? "Online" : "Offline", symbol: "desktopcomputer", run: { [weak self] in self?.resource(string(node["name"]), path: "/api/nodes/\(string(node["id"]))/proxy/dashboard") }) }
            show("Machines", "PAIRED FLEET", tiles)
        }
    }
    private func resource(_ title: String, path: String, key: String? = nil) {
        work { [self] in let data = try await deck.json(path); try Task.checkCancellation(); inspect(title, key.flatMap { data[$0] } ?? data) }
    }
    private func inspect(_ title: String, _ data: Any) {
        var tiles: [Tile] = []
        if let rows = data as? [Any] {
            tiles = rows.enumerated().map { index, value in
                let row = object(value)
                let label = ["name", "title", "path", "id"].map { string(row[$0]) }.first { !$0.isEmpty } ?? "Item \(index + 1)"
                return Tile(title: label, subtitle: scalarSummary(value), symbol: "doc.text", run: { [weak self] in self?.inspect(label, value) })
            }
        } else if let row = data as? Object {
            tiles = row.keys.sorted().filter { !["token", "key", "secret", "password"].contains($0.lowercased()) }.map { key in
                let value = row[key]!
                return Tile(title: key, subtitle: scalarSummary(value), symbol: "doc.text", run: { [weak self] in
                    if value is Object || value is [Any] { self?.inspect(key, value) } else { self?.message = "\(key): \(value)" }
                })
            }
        }
        show(title, tiles.isEmpty ? scalarSummary(data) : "CYBERDECK", tiles)
    }
    private func scalarSummary(_ value: Any) -> String {
        if let row = value as? Object { return "\(row.count) fields" }
        if let list = value as? [Any] { return "\(list.count) items" }
        return String(describing: value)
    }
    private func files(_ path: String) {
        work { [self] in
            let data = try await deck.json("/api/fs/list?" + query(["path": path])); try Task.checkCancellation()
            let entries = objects(data["entries"])
            show(path, "FILES", entries.map { entry in
                let name = string(entry["name"]), full = string(entry["path"])
                let directory = entry["isDir"] as? Bool == true || string(entry["type"]) == "directory" || string(entry["type"]) == "dir"
                return Tile(title: name, subtitle: directory ? "Folder" : "File", symbol: directory ? "folder.fill" : "doc.text", run: { [weak self] in
                    guard let self else { return }; let target = full.isEmpty ? path + "/" + name : full
                    if directory { self.files(target) } else { self.resource(name, path: "/api/fs/text?" + query(["path": target])) }
                })
            })
        }
    }
    private func sessions() {
        work { [self] in let data = try await deck.json("/api/sessions"); try Task.checkCancellation()
            show("Sessions", "CYBERDECK", objects(data["sessions"]).map { session in
                Tile(title: string(session["title"]).isEmpty ? string(session["id"]) : string(session["title"]), subtitle: string(session["tool"]), symbol: "terminal", run: { [weak self] in self?.sessionDetail(session) })
            })
        }
    }
    private func sessionDetail(_ session: Object) {
        let id = string(session["id"])
        show(string(session["title"]), "SESSION", [
            Tile(title: "Read session", symbol: "text.alignleft", run: { [weak self] in self?.resource("Session", path: "/api/sessions/\(id)" + (id.hasPrefix("seed-") ? "/transcript" : "")) }),
            Tile(title: "Send message", symbol: "paperplane", run: { [weak self] in self?.enterText { text in self?.work {
                guard let self else { return }
                let seed = id.hasPrefix("seed-"); _ = try await self.deck.json("/api/sessions/\(id)/" + (seed ? "message" : "input"), body: seed ? ["text": text] : ["data": text + "\r"])
                self.message = "Sent."
            } } })
        ])
    }
    private func newSession() {
        enterText { [weak self] prompt in self?.work {
            guard let self, !prompt.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            let data = try await self.deck.json("/api/sessions", body: ["prompt": prompt, "tool": "cx"]); self.inspect("New session", data)
        } }
    }
    private func applications() {
        work { [self] in let data = try await deck.json("/api/applications"); try Task.checkCancellation()
            var tiles = [Tile(title: "Afterglow", symbol: "play.rectangle.fill", run: { [weak self] in self?.mediaHome() }), Tile(title: "Games", symbol: "gamecontroller.fill", run: { [weak self] in self?.gamesHome() })]
            tiles += objects(data["applications"]).filter { string($0["id"]) != "afterglow" }.map { app in
                Tile(title: string(app["name"]), subtitle: "Web app · controller navigation", symbol: "globe", run: { [weak self] in
                    if let url = URL(string: string(app["url"])), ["http", "https"].contains(url.scheme ?? "") { self?.openCompatibility(url) }
                })
            }
            show("Applications", "YOUR CYBERDECK", tiles)
        }
    }

    private func openCompatibility(_ url: URL) {
        let native = url.scheme == "http" && url.host == "127.0.0.1" && url.port == 4777
        let view = CompatibilityBrowser(url: url, token: native ? token : "")
        view.edit = { [weak self] value, submit in self?.enterText(submit: submit); self?.keyboardText = value }
        view.error = { [weak self] error in self?.message = error }
        browser = view
    }

    // Existing Casework console can send casework.input / casework.status to this device.
    private func connectControl() {
        socket?.cancel(with: .goingAway, reason: nil)
        let ws = deck.session.webSocketTask(with: URL(string: "ws://127.0.0.1:4777/control")!)
        socket = ws; ws.resume(); controlConnected = false
        let hello: Object = ["type": "hello", "role": "device", "token": token, "info": ["name": "Clipper · Casework Native", "platform": "macos", "native": true, "actions": ["casework.input", "casework.status"]]]
        send(hello, to: ws)
        Task { [weak self] in await self?.receiveControl(ws) }
        Task<Void, Never> { [weak self, weak ws] in
            while let self, let ws, self.socket === ws {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if self.socket === ws { self.send(["type": "ping", "at": Date().timeIntervalSince1970 * 1000], to: ws) }
            }
        }
    }
    private func receiveControl(_ ws: URLSessionWebSocketTask) async {
        do {
            while socket === ws {
                let frame = try await ws.receive()
                guard socket === ws else { return }
                let data: Data
                switch frame {
                case .string(let text): data = Data(text.utf8)
                case .data(let bytes): data = bytes
                @unknown default: continue
                }
                let message = (try? JSONSerialization.jsonObject(with: data)) as? Object ?? [:]
                if string(message["type"]) == "welcome" { controlConnected = true }
                if string(message["type"]) == "command" {
                    let action = object(message["action"])
                    let name = string(action["name"])
                    let supported = ["casework.input", "casework.status", "device.capabilities"].contains(name)
                    if name == "casework.input" { noteInput(.controller); input(string(object(action["args"])["action"])) }
                    let result: Object = supported ? state() : ["error": "Unsupported native action"]
                    let reply: Object = ["type": "result", "id": string(message["id"]), "ok": supported, "result": result]
                    send(reply, to: ws)
                }
            }
        } catch {
            guard socket === ws else { return }
            controlConnected = false
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if socket === ws { connectControl() }
        }
    }
    private func send(_ message: Object, to ws: URLSessionWebSocketTask) {
        guard let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
        Task { try? await ws.send(.string(text)) }
    }
}
