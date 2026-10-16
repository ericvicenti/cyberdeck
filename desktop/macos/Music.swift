import SwiftUI
import AppKit

// Catalog and Connect commands reuse a signed-in Cyberdeck tab. The native client
// never receives Spotify OAuth tokens and renders no Spotify webview.
@MainActor final class SpotifyConnection: ObservableObject {
    @Published var playback: Object = [:]
    @Published var error = ""
    @Published var deviceID = UserDefaults.standard.string(forKey: "spotify-device") ?? ""
    @Published var deviceName = UserDefaults.standard.string(forKey: "spotify-device-name") ?? ""
    private let deck: API
    private var endpoint: (String, String)?
    private var polling = false
    private var timer: Timer?
    var ownsPlayback = false
    init(deck: API) { self.deck = deck }
    var track: Object { object(playback["item"]) }
    var duration: Double { max(1, number(track["duration_ms"])) }
    var playing: Bool { playback["is_playing"] as? Bool == true }
    var title: String { string(track["name"]) }
    var artist: String { objects(track["artists"]).map { string($0["name"]) }.joined(separator: ", ") }
    var image: URL? { URL(string: string(objects(object(track["album"])["images"]).first?["url"])) }
    func discover() async throws -> (String, String) {
        if let endpoint { return endpoint }
        var prefixes = ["/api/"]
        if let fleet = try? await deck.json("/api/fleet/nodes") {
            prefixes += objects(fleet["nodes"]).filter { $0["online"] as? Bool == true }.sorted { string($0["name"]).lowercased() == "enuc" && string($1["name"]).lowercased() != "enuc" }.map { "/api/nodes/\(string($0["id"]))/proxy/" }
        }
        for prefix in prefixes {
            try Task.checkCancellation()
            if let state = try? await deck.json(prefix + "casework/devices"), let device = objects(state["devices"]).first(where: { number(object($0["info"])["spotifyBridge"]) == 1 }) {
                let result = (prefix, string(device["id"])); endpoint = result; return result
            }
        }
        throw Failure(message: "Open Spotify in Cyberdeck on Enuc or another paired machine, connect your existing account, and reload that tab. Then choose Refresh here.")
    }
    func request(_ path: String, method: String = "GET", body: Object? = nil) async throws -> Object {
        let (prefix, device) = try await discover()
        var args: Object = ["path": path, "method": method]; if let body { args["body"] = body }
        let command: Object
        do { command = try await deck.json(prefix + "command", body: ["deviceId": device, "action": ["name": "spotify.request", "args": args]]) }
        catch { endpoint = nil; throw error }
        let id = string(command["id"])
        for _ in 0..<60 {
            try await Task.sleep(nanoseconds: 250_000_000)
            let events = try await deck.json(prefix + "casework/devices")
            if let reply = objects(events["events"]).first(where: { string($0["id"]) == id && string($0["deviceId"]) == device }) {
                let result = object(reply["result"])
                guard reply["ok"] as? Bool == true else { throw Failure(message: string(result["error"])) }
                return object(result["data"])
            }
        }
        endpoint = nil; throw Failure(message: "Spotify did not respond. Keep your signed-in Cyberdeck tab open and try Refresh.")
    }
    func refresh(force: Bool = false) async {
        if force { while polling { do { try await Task.sleep(nanoseconds: 50_000_000) } catch { return } } }
        guard !polling else { return }; polling = true; defer { polling = false }
        do {
            let latest = try await request("/me/player")
            if !deviceID.isEmpty && !latest.isEmpty && string(object(latest["device"])["id"]) != deviceID {
                playback = [:]; ownsPlayback = false; error = "Music is active on another Spotify device. Choose Devices to control it."
            } else { playback = latest; error = "" }
        }
        catch { self.error = error.localizedDescription }
    }
    func startPolling() {
        if timer != nil { return }
        timer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in Task { @MainActor in await self?.refresh() } }
        RunLoop.main.add(timer!, forMode: .common)
    }
    func selectDevice(_ device: Object) {
        deviceID = string(device["id"]); deviceName = string(device["name"])
        UserDefaults.standard.set(deviceID, forKey: "spotify-device"); UserDefaults.standard.set(deviceName, forKey: "spotify-device-name")
    }
    func target() async throws -> String {
        let data = try await request("/me/player/devices")
        let devices = objects(data["devices"]).filter { $0["is_restricted"] as? Bool != true && !string($0["id"]).isEmpty }
        if let device = devices.first(where: { string($0["id"]) == deviceID }) { selectDevice(device); return deviceID }
        if let device = devices.first(where: { string($0["name"]).lowercased().contains("clipper") }) { selectDevice(device); return deviceID }
        throw Failure(message: "Choose a playback device with Devices. For sound here, open the Spotify app on Clipper and sign in once.")
    }
    func play(_ item: Object) async throws {
        let id = try await target(), uri = string(item["uri"])
        guard uri.hasPrefix("spotify:") else { throw Failure(message: "This selection cannot be played.") }
        let body: Object = uri.hasPrefix("spotify:track:") || uri.hasPrefix("spotify:episode:") ? ["uris": [uri]] : ["context_uri": uri]
        _ = try await request("/me/player/play?" + query(["device_id": id]), method: "PUT", body: body)
        ownsPlayback = true; startPolling(); await refresh(force: true)
    }
    func control(_ action: String) async throws {
        let id = try await target(); var params = ["device_id": id], path = action, method = "PUT"
        switch action {
        case "toggle": path = playing ? "pause" : "play"
        case "next", "previous": method = "POST"
        case "shuffle": params["state"] = playback["shuffle_state"] as? Bool == true ? "false" : "true"
        case "repeat": params["state"] = string(playback["repeat_state"]) == "off" ? "context" : "off"
        case "quieter", "louder":
            path = "volume"; params["volume_percent"] = String(Int(max(0, min(100, number(object(playback["device"])["volume_percent"]) + (action == "louder" ? 10 : -10)))))
        case "rewind", "forward": path = "seek"; params["position_ms"] = String(Int(max(0, min(number(track["duration_ms"]), number(playback["progress_ms"]) + (action == "forward" ? 10000 : -10000)))))
        default: break
        }
        _ = try await request("/me/player/" + path + "?" + query(params), method: method)
        ownsPlayback = true; startPolling(); await refresh(force: true)
    }
    func seek(_ milliseconds: Double) async throws {
        let id = try await target()
        _ = try await request("/me/player/seek?" + query(["device_id": id, "position_ms": String(Int(max(0, min(duration, milliseconds))))]), method: "PUT")
        await refresh(force: true)
    }
    func pauseForVideo() async throws {
        guard ownsPlayback else { return }
        _ = try await request("/me/player/pause?" + query(["device_id": deviceID]), method: "PUT")
        ownsPlayback = false; playback["is_playing"] = false
    }
}

extension Workspace {
    func toggleMusicVisualizer() {
        musicVisualizer.toggle()
        if musicVisualizer, page.shelves.count > 1 { selection = page.shelves[1].start }
    }
    func showMusic(_ title: String, rows: [(String, [Tile])], push: Bool = true) {
        let navigation = [
            Tile(title: "Your music", symbol: "music.note.house", run: { [weak self] in self?.musicHome() }),
            Tile(title: "Search", symbol: "magnifyingglass", run: { [weak self] in self?.enterText { self?.musicSearch($0) } }),
            Tile(title: "Devices", symbol: "hifispeaker", run: { [weak self] in self?.musicDevices() }),
            Tile(title: "Refresh", symbol: "arrow.clockwise", run: { [weak self] in self?.musicHome() }),
            Tile(title: "Films & series", symbol: "film", run: { [weak self] in self?.mediaHome() })]
        var transport = [("Play / pause", "playpause.fill", "toggle"), ("Previous", "backward.end.fill", "previous"), ("Next", "forward.end.fill", "next"), ("Shuffle", "shuffle", "shuffle"), ("Repeat", "repeat", "repeat"), ("Volume −", "speaker.fill", "quieter"), ("Volume +", "speaker.wave.3.fill", "louder")].map { name, symbol, action in
            Tile(title: name, symbol: symbol, run: { [weak self] in self?.musicControl(action) })
        }
        transport.append(Tile(title: "Visualizer", symbol: "sparkles", run: { [weak self] in self?.toggleMusicVisualizer() }))
        var tiles = navigation + transport
        var shelves = [Shelf(title: "", start: 0, count: navigation.count), Shelf(title: "Player", start: navigation.count, count: transport.count)]
        for (name, row) in rows where !row.isEmpty { shelves.append(Shelf(title: name, start: tiles.count, count: row.count)); tiles += row }
        show(title, "SPOTIFY IN AFTERGLOW", tiles, push: push); page.cinema = true; page.music = true; page.shelves = shelves
        selection = shelves.count > 2 ? shelves[2].start : navigation.count
    }
    func musicHome() {
        showMusic("Your listening room", rows: [])
        work { [self] in
            var rows: [(String, [Tile])] = []
            if let api = try? await mediaAPI(), let shelf = try? await api.json("/api/spotify") {
                rows.append(("Saved in Afterglow", objects(shelf["items"]).map { musicTile($0, shelf: true) }))
            }
            showMusic("Your listening room", rows: rows, push: false)
            do {
                let playlists = try await music.request("/me/playlists?limit=50")
                rows.append(("Your playlists", objects(playlists["items"]).map { musicTile($0) }))
                let albums = try? await music.request("/me/albums?limit=30")
                rows.append(("Your albums", objects(albums?["items"]).map { musicTile(object($0["album"])) }))
                let liked = Tile(title: "Liked songs", subtitle: "Your saved songs", symbol: "heart.fill", run: { [weak self] in self?.musicCollection("Liked songs", path: "/me/tracks?limit=50") })
                let queue = Tile(title: "Up next", subtitle: "Your Spotify queue", symbol: "list.bullet", run: { [weak self] in self?.musicQueue() })
                let save = Tile(title: "Save this song", subtitle: "Pin the current song in Afterglow", symbol: "bookmark", run: { [weak self] in self?.musicSave() })
                rows.insert(("Made for your evenings", [liked, queue, save]), at: 0)
                try Task.checkCancellation(); showMusic("Your listening room", rows: rows, push: false)
                await music.refresh(); music.startPolling()
            } catch {
                try Task.checkCancellation()
                rows.append(("Connect your music", [
                    Tile(title: "Connect Spotify", subtitle: "Use your existing Cyberdeck Spotify sign-in", symbol: "person.crop.circle", run: { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:4777/?afterglowSpotify=connect#/spotify")!) }),
                    Tile(title: "Open Spotify app", subtitle: "Sign in once for playback on Clipper", symbol: "hifispeaker", run: { NSWorkspace.shared.open(URL(string: "spotify:")!) })]))
                showMusic("Your listening room", rows: rows, push: false); message = error.localizedDescription
            }
        }
    }
    func musicTile(_ item: Object, shelf: Bool = false) -> Tile {
        let type = string(item["type"]), uri = string(item["uri"])
        let title = shelf ? string(item["title"]) : string(item["name"])
        let artists = objects(item["artists"]).map { string($0["name"]) }.joined(separator: ", ")
        let images = objects(item["images"]).isEmpty ? objects(object(item["album"])["images"]) : objects(item["images"])
        return Tile(title: title, subtitle: artists.isEmpty ? type.capitalized : artists, symbol: "music.note", image: URL(string: shelf ? string(item["image"]) : string(images.first?["url"])), run: { [weak self] in
            guard let self else { return }
            if type == "track" || type == "episode" { self.musicPlay(item); return }
            let parts = uri.split(separator: ":").map(String.init)
            if parts.count == 3 && ["playlist", "album"].contains(parts[1]) {
                self.musicCollection(title, path: "/\(parts[1])s/\(parts[2])/\(parts[1] == "playlist" ? "items" : "tracks")?limit=50", context: item)
            } else { self.showMusic(title, rows: [("Listen", [Tile(title: "Play", subtitle: title, symbol: "play.fill", image: URL(string: string(images.first?["url"])), run: { [weak self] in self?.musicPlay(item) })])]) }
        })
    }
    func musicCollection(_ title: String, path: String, context: Object? = nil) {
        work { [self] in
            let data: Object
            do { data = try await music.request(path) }
            catch {
                if let context {
                    showMusic(title, rows: [("Listen", [Tile(title: "Play all", subtitle: title, symbol: "play.fill", run: { [weak self] in self?.musicPlay(context) })])])
                    message = error.localizedDescription; return
                }
                throw error
            }
            var tiles = objects(data["items"]).compactMap { row -> Tile? in
                let track = row["item"] != nil ? object(row["item"]) : (row["track"] == nil ? row : object(row["track"]))
                guard !string(track["uri"]).isEmpty else { return nil }; return musicTile(track.merging(["type": "track"]) { a,_ in a })
            }
            if let context { tiles.insert(Tile(title: "Play all", subtitle: title, symbol: "play.fill", run: { [weak self] in self?.musicPlay(context) }), at: 0) }
            if let next = URL(string: string(data["next"])), next.scheme == "https", next.host == "api.spotify.com", next.path.hasPrefix("/v1/") {
                let more = String(next.path.dropFirst(3)) + (next.query.map { "?" + $0 } ?? "")
                tiles.append(Tile(title: "More songs", symbol: "arrow.right", run: { [weak self] in self?.musicCollection(title, path: more, context: context) }))
            }
            try Task.checkCancellation(); showMusic(title, rows: [("Songs", tiles)])
        }
    }
    func musicSearch(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        work { [self] in
            let data = try await music.request("/search?" + query(["q": text, "type": "track,album,playlist,artist", "limit": "10"]))
            let rows = ["tracks", "albums", "playlists", "artists"].map { name in (name.capitalized, objects(object(data[name])["items"]).map { musicTile($0) }) }
            try Task.checkCancellation(); showMusic("Search · \(text)", rows: rows)
        }
    }
    func musicQueue() {
        work { [self] in let data = try await music.request("/me/player/queue"); try Task.checkCancellation(); showMusic("Up next", rows: [("Spotify queue", objects(data["queue"]).map { musicTile($0) })]) }
    }
    func musicSave() {
        let uri = string(music.track["uri"])
        guard uri.hasPrefix("spotify:track:") else { message = "Play a song first, then save it here."; return }
        work { [self] in let api = try await mediaAPI(); _ = try await api.json("/api/spotify/add", body: ["url": uri]); message = "Saved in Afterglow." }
    }
    func musicSeek(_ position: Double) { work { [self] in try await music.seek(position) } }
    func musicDevices() {
        work { [self] in
            let data = try await music.request("/me/player/devices")
            let tiles = objects(data["devices"]).filter { $0["is_restricted"] as? Bool != true }.map { device in
                Tile(title: string(device["name"]), subtitle: string(device["id"]) == music.deviceID ? "Selected" : "Play music here", symbol: "hifispeaker.fill", run: { [weak self] in
                    self?.music.selectDevice(device); self?.message = "Selected \(string(device["name"])). Choose a song to play."
                })
            }
            showMusic("Where to listen", rows: [("Spotify Connect", tiles)])
            if tiles.isEmpty { message = "Open Spotify on Clipper and sign in, then choose Devices again." }
        }
    }
    func musicPlay(_ item: Object) { work { [self] in stopPlayback(); try await music.play(item) } }
    func musicControl(_ action: String) { work { [self] in try await music.control(action) } }
}

struct MusicView: View {
    @ObservedObject var model: Workspace
    @ObservedObject var music: SpotifyConnection
    let page: Page
    let green = Color(red: 0.4, green: 0.9, blue: 0.6)
    private func button(_ index: Int, compact: Bool = false) -> some View {
        let tile = page.tiles[index], focused = index == model.selection && model.inputMode != .pointer
        return Button { guard model.page.id == page.id else { return }; model.selection = index; model.input("select") } label: {
            VStack(alignment: .leading, spacing: 12) {
                if !compact {
                    ZStack {
                        RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.07))
                        if let url = tile.image { AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Image(systemName: tile.symbol).font(.largeTitle) } }
                        else { Image(systemName: tile.symbol).font(.system(size: 44)).foregroundStyle(green) }
                    }.frame(width: 180, height: 180).clipped().clipShape(RoundedRectangle(cornerRadius: 14))
                }
                if compact { Label(tile.title, systemImage: tile.symbol).font(.system(size: 15, weight: .semibold)) }
                else { Text(tile.title).font(.system(size: 17, weight: .semibold)).lineLimit(2).frame(width: 180, height: 44, alignment: .topLeading); Text(tile.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(width: 180, alignment: .leading) }
            }.padding(compact ? 12 : 8).background(focused ? green.opacity(0.18) : .clear).clipShape(RoundedRectangle(cornerRadius: 14)).overlay(RoundedRectangle(cornerRadius: 14).stroke(focused ? green : .clear, lineWidth: 3))
        }.buttonStyle(.plain).id(index)
    }
    var body: some View {
        ZStack {
            if model.musicVisualizer {
                ElectricStorm().ignoresSafeArea()
                immersive
            } else { library }
        }.foregroundStyle(.white)
    }
    private var transport: some View {
        let row = page.shelves[1]
        return ScrollViewReader { scroll in
            ScrollView(.horizontal) {
                HStack(spacing: 12) { ForEach(row.start..<(row.start + row.count), id: \.self) { button($0, compact: true) } }.padding(.horizontal, 40).padding(.vertical, 5)
            }.scrollIndicators(.hidden).onChange(of: model.selection) { _, value in
                if value >= row.start && value < row.start + row.count { withAnimation { scroll.scrollTo(value, anchor: .center) } }
            }
        }
    }
    private var immersive: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("AFTERGLOW / SYSTEM AUDIO").font(.system(size: 13, weight: .bold)).tracking(3).foregroundStyle(.white.opacity(0.65))
                Spacer()
                Button { model.musicVisualizer = false } label: { Label("Back to music", systemImage: "arrow.down.right.and.arrow.up.left").padding(12).background(.black.opacity(0.35)).clipShape(Capsule()) }.buttonStyle(.plain)
            }.padding(40)
            Spacer()
            VStack(alignment: .leading, spacing: 12) {
                Text(music.title.isEmpty ? "Electric sky" : music.title).font(.system(size: 38, weight: .bold)).lineLimit(2)
                Text(music.artist.isEmpty ? "A little room to drift." : music.artist).font(.title3).foregroundStyle(.white.opacity(0.7))
            }.padding(.horizontal, 48)
            transport
            if model.inputMode == .controller { Text("✚ Controls   A Select   B Back   Start Pause   LB / RB Track").font(.system(size: 13)).foregroundStyle(.white.opacity(0.55)).padding(.horizontal, 48) }
            if !model.message.isEmpty { Text(model.message).font(.callout).padding(.horizontal, 48) }
        }.padding(.bottom, 30).background(LinearGradient(stops: [.init(color: .black.opacity(0.25), location: 0), .init(color: .clear, location: 0.35), .init(color: .black.opacity(0.85), location: 1)], startPoint: .top, endPoint: .bottom))
    }
    private var library: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("AFTERGLOW").font(.system(size: 23, weight: .black, design: .rounded)).tracking(4).foregroundStyle(green)
                Spacer()
                ForEach(0..<page.shelves[0].count, id: \.self) { button($0, compact: true) }
            }.padding(.horizontal, 40).padding(.vertical, 22)
            HStack(spacing: 36) {
                AsyncImage(url: music.image) { image in image.resizable().scaledToFit() } placeholder: { ZStack { green.opacity(0.1); Image(systemName: "waveform").font(.system(size: 64)).foregroundStyle(green) } }.frame(width: 225, height: 225).clipShape(RoundedRectangle(cornerRadius: 20))
                VStack(alignment: .leading, spacing: 14) {
                    Text("SPOTIFY · \(music.deviceName.isEmpty ? "CHOOSE A DEVICE" : music.deviceName.uppercased())").font(.system(size: 12, weight: .bold)).tracking(2).foregroundStyle(green)
                    Text(music.title.isEmpty ? "Set the mood." : music.title).font(.system(size: 38, weight: .bold)).lineLimit(2)
                    Text(music.artist.isEmpty ? "Your playlists. Your albums. Room to listen." : music.artist).font(.title3).foregroundStyle(.secondary)
                    Slider(value: Binding(get: { min(number(music.playback["progress_ms"]), music.duration) }, set: { music.playback["progress_ms"] = $0 }), in: 0...music.duration, onEditingChanged: { editing in if !editing { model.musicSeek(number(music.playback["progress_ms"])) } }).tint(green).disabled(music.track.isEmpty).accessibilityLabel("Song position")
                    HStack { Text(music.playing ? "Playing" : "Paused"); Spacer(); Text("Shuffle \(music.playback["shuffle_state"] as? Bool == true ? "on" : "off") · Repeat \(string(music.playback["repeat_state"]).isEmpty ? "off" : string(music.playback["repeat_state"]))") }.font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.horizontal, 48).padding(.bottom, 24)
            transport.padding(.bottom, 22)
            ScrollViewReader { vertical in
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Text(page.title).font(.title2.bold()).padding(.horizontal, 48)
                        ForEach(Array(page.shelves.dropFirst(2).enumerated()), id: \.offset) { _, row in
                            VStack(alignment: .leading, spacing: 12) {
                                Text(row.title).font(.title3.bold()).padding(.horizontal, 48)
                                ScrollViewReader { horizontal in
                                    ScrollView(.horizontal) { HStack(spacing: 18) { ForEach(row.start..<(row.start + row.count), id: \.self) { button($0) } }.padding(.horizontal, 40).padding(.vertical, 5) }.scrollIndicators(.hidden)
                                        .onChange(of: model.selection) { _, value in if value >= row.start && value < row.start + row.count { withAnimation { horizontal.scrollTo(value, anchor: .center) } } }
                                }
                            }.id(row.start)
                        }
                    }.padding(.bottom, 20)
                }.scrollIndicators(.hidden).onChange(of: model.selection) { _, value in if let row = page.shelves.first(where: { value >= $0.start && value < $0.start + $0.count }) { withAnimation { vertical.scrollTo(row.start, anchor: .top) } } }
            }
            HStack {
                if model.inputMode == .controller { Text("✚ Browse   A Select   B Back   X Search   Start Pause   LB / RB Track") }
                Spacer(); if model.busy { ProgressView().controlSize(.small) }
            }.font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 48).padding(.top, 12)
            Text(model.message.isEmpty ? music.error : model.message).font(.system(size: 15)).lineLimit(3).padding(.horizontal, 48).padding(.vertical, 14)
        }.background(LinearGradient(colors: [Color.black.opacity(0.72), Color.black.opacity(0.92)], startPoint: .topLeading, endPoint: .bottomTrailing)).foregroundStyle(.white)
    }
}
