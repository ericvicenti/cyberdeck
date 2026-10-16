import Foundation
import AppKit
import GameController
import Network

// Tokens are read locally and are only attached to the configured Cyberdeck origin.
typealias Object = [String: Any]
func string(_ value: Any?) -> String { value as? String ?? "" }
func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? 0 }
func objects(_ value: Any?) -> [Object] { value as? [Object] ?? [] }
func object(_ value: Any?) -> Object { value as? Object ?? [:] }
func query(_ fields: [String: String]) -> String {
    var c = URLComponents(); c.queryItems = fields.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    return c.percentEncodedQuery ?? ""
}
struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }
final class API: NSObject, URLSessionTaskDelegate {
    let origin: URL
    private let token: String
    lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    init(_ origin: String, token: String = "") { self.origin = URL(string: origin)!; self.token = token }
    func url(_ path: String) throws -> URL {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else {
            throw Failure(message: "The server returned an unexpected address.")
        }
        return url
    }
    func request(_ path: String, body: Object? = nil) throws -> URLRequest {
        var r = URLRequest(url: try url(path)); r.timeoutInterval = 90
        if !token.isEmpty { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { r.httpMethod = "POST"; r.httpBody = try JSONSerialization.data(withJSONObject: body); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return r
    }
    func json(_ path: String, body: Object? = nil) async throws -> Object {
        let (data, response) = try await session.data(for: request(path, body: body))
        let result = (try? JSONSerialization.jsonObject(with: data)) as? Object ?? [:]
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Failure(message: string(result["error"]).isEmpty ? "The service could not complete this request (\((response as? HTTPURLResponse)?.statusCode ?? 0))." : string(result["error"]))
        }
        return result
    }
    func download(_ path: String, body: Object? = nil, to directory: URL, fallback: String) async throws -> URL {
        let (temp, response) = try await session.download(for: request(path, body: body))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let error = (try? JSONSerialization.jsonObject(with: Data(contentsOf: temp))) as? Object ?? [:]
            throw Failure(message: string(error["error"]).isEmpty ? "Game download failed." : string(error["error"]))
        }
        let size = (try temp.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
        guard size > 0, size <= 128 * 1024 * 1024 else { throw Failure(message: "Game files must be between 1 byte and 128 MiB.") }
        let name = response.suggestedFilename ?? fallback
        let allowed = ["zip", "7z", "nes", "sfc", "smc", "z64", "n64", "v64", "gb", "gbc", "gba", "md", "gen", "bin", "sms", "gg"]
        let ext = (name as NSString).pathExtension.lowercased()
        let safe = allowed.contains(ext) ? name : fallback
        guard allowed.contains((safe as NSString).pathExtension.lowercased()) else { throw Failure(message: "The server did not return a supported game file.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let dest = directory.appendingPathComponent(UUID().uuidString + "-" + URL(fileURLWithPath: safe).lastPathComponent)
        try FileManager.default.moveItem(at: temp, to: dest)
        return dest
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Prevent a redirect from forwarding the node credential or leaving the private service.
        let u = request.url
        completionHandler(u?.host == origin.host && u?.port == origin.port && u?.scheme == origin.scheme ? request : nil)
    }
}

@MainActor final class ControllerInput {
    var action: (String) -> Void = { _ in }
    var ownedGameRunning: () -> Bool = { false }
    private var timer: Timer?
    private var held: Set<String> = []
    private var direction = ""
    private var nextRepeat: TimeInterval = 0
    var names: [String] { GCController.controllers().map { $0.vendorName ?? "Game controller" } }
    func start() {
        GCController.shouldMonitorBackgroundEvents = true
        GCController.startWirelessControllerDiscovery(completionHandler: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.poll() } }
    }
    private func poll() {
        var nowHeld = Set<String>()
        for controller in GCController.controllers() {
            guard let pad = controller.extendedGamepad else {
                if let pad = controller.microGamepad {
                    if pad.buttonA.isPressed { nowHeld.insert("select") }; if pad.buttonX.isPressed { nowHeld.insert("back") }
                    read(pad.dpad, into: &nowHeld)
                }
                continue
            }
            if pad.buttonA.isPressed { nowHeld.insert("select") }; if pad.buttonB.isPressed { nowHeld.insert("back") }
            if pad.buttonX.isPressed { nowHeld.insert("search") }; if pad.buttonY.isPressed { nowHeld.insert("home") }
            if pad.buttonMenu.isPressed { nowHeld.insert("menu") }
            if pad.buttonHome?.isPressed == true || (pad.buttonOptions?.isPressed == true && pad.buttonMenu.isPressed) { nowHeld.insert("game-home") }
            if pad.leftShoulder.isPressed { nowHeld.insert("previous") }; if pad.rightShoulder.isPressed { nowHeld.insert("next") }
            read(pad.dpad, into: &nowHeld); read(pad.leftThumbstick, into: &nowHeld)
        }
        // While a game owns focus, only its Home/Back+Start return chord belongs to us.
        if !NSApp.isActive {
            if ownedGameRunning(), nowHeld.contains("game-home"), !held.contains("game-home") { action("home") }
            held = nowHeld; direction = ""; return
        }
        if nowHeld.contains("game-home") && !held.contains("game-home") {
            action("home"); held = nowHeld; direction = ""; return
        }
        if nowHeld.contains("home") && !held.contains("home") {
            action("home"); held = nowHeld; direction = ""; return
        }
        for key in nowHeld.subtracting(held) where !["left", "right", "up", "down"].contains(key) { action(key == "game-home" ? "home" : key) }
        let d = ["up", "down", "left", "right"].first(where: { nowHeld.contains($0) }) ?? ""
        let now = ProcessInfo.processInfo.systemUptime
        if d != direction { direction = d; nextRepeat = now + 0.38; if !d.isEmpty { action(d) } }
        else if !d.isEmpty && now >= nextRepeat { nextRepeat = now + 0.11; action(d) }
        held = nowHeld
    }
    private func read(_ pad: GCControllerDirectionPad, into keys: inout Set<String>) {
        if pad.xAxis.value < -0.55 { keys.insert("left") }; if pad.xAxis.value > 0.55 { keys.insert("right") }
        if pad.yAxis.value < -0.55 { keys.insert("down") }; if pad.yAxis.value > 0.55 { keys.insert("up") }
    }
}

// Private loopback automation uses the very same input reducer as physical controllers.
// It renders only this application's view; no system screen capture/Accessibility privileges.
final class LocalControl {
    private var listener: NWListener?
    private let token: String
    var handle: @MainActor (String, Object) -> (Data, String) = { _, _ in (Data(), "application/json") }
    init(token: String) { self.token = token }
    func start() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 4778)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] connection in
            connection.start(queue: .global()); self?.read(connection, Data())
        }
        l.start(queue: .global()); listener = l
    }
    private func read(_ c: NWConnection, _ previous: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { c.cancel(); return }
            let buffer = previous + (data ?? Data())
            guard buffer.count <= 65536, error == nil else { c.cancel(); return }
            guard let split = buffer.range(of: Data("\r\n\r\n".utf8)), let headers = String(data: buffer[..<split.lowerBound], encoding: .utf8) else {
                if !complete { self.read(c, buffer) } else { c.cancel() }; return
            }
            let lines = headers.components(separatedBy: "\r\n")
            var fields: [String: String] = [:]
            for line in lines.dropFirst() { let parts = line.split(separator: ":", maxSplits: 1); if parts.count == 2 { fields[String(parts[0]).lowercased()] = parts[1].trimmingCharacters(in: .whitespaces) } }
            let length = Int(fields["content-length"] ?? "0") ?? 0
            guard length >= 0, length <= 32768 else { c.cancel(); return }
            if buffer.count - split.upperBound < length { if !complete { self.read(c, buffer) } else { c.cancel() }; return }
            guard !self.token.isEmpty, fields["authorization"] == "Bearer \(self.token)" else { self.respond(c, Data("{}".utf8), "application/json", status: "401 Unauthorized"); return }
            let first = (lines.first ?? "").split(separator: " ")
            guard first.count >= 2 else { c.cancel(); return }
            let route = String(first[0]) + " " + String(first[1])
            let body = (try? JSONSerialization.jsonObject(with: buffer.subdata(in: split.upperBound..<(split.upperBound + length)))) as? Object ?? [:]
            Task { @MainActor in let (data, type) = self.handle(route, body); self.respond(c, data, type) }
        }
    }
    private func respond(_ c: NWConnection, _ data: Data, _ type: String, status: String = "200 OK") {
        let header = Data("HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(data.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n".utf8)
        c.send(content: header + data, completion: .contentProcessed { _ in c.cancel() })
    }
}
