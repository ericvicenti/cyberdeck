import Foundation
import AppKit
import Security
import CryptoKit

struct SpotifyTokens: Codable {
    let access: String
    let refresh: String
    let expires: Date
}

// The native app owns its own login. Never inspect or copy browser credentials.
struct SpotifyVault {
    let service: String
    init(service: String = "com.casework.cyberdeck.native.spotify") { self.service = service }
    private var key: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "spotify"] }
    func read() throws -> SpotifyTokens? {
        var q = key; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw Failure(message: "Allow Casework to access its Spotify login in Keychain, then try again.") }
        return try JSONDecoder().decode(SpotifyTokens.self, from: data)
    }
    func write(_ tokens: SpotifyTokens?) throws {
        guard let tokens else {
            let status = SecItemDelete(key as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(message: "Could not remove the Spotify login from Keychain.") }
            return
        }
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(tokens)]
        var status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var q = key; q.merge(attributes) { _, new in new }; q[kSecAttrLabel as String] = "Casework Spotify"
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure(message: "Could not save the Spotify login in Keychain. Please allow Keychain access and reconnect.") }
    }
}

@MainActor final class SpotifyAuth {
    static let clientID = "6dc6300fa4364a81acb8a5f5e920f809"
    static let scopes = "user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read user-follow-read"
    typealias Transport = (URLRequest) async throws -> (Data, HTTPURLResponse)
    private let readVault: () throws -> SpotifyTokens?
    private let writeVault: (SpotifyTokens?) throws -> Void
    private let transport: Transport
    private var loaded = false
    private var tokens: SpotifyTokens?
    private var renewal: Task<String, Error>?
    private var cooldown = Date.distantPast
    private var generation = 0
    // API refuses cross-origin redirects; ephemeral sessions avoid persistent cookies/cache.
    private static func privateAPI(_ origin: String) -> API {
        let api = API(origin); api.session = URLSession(configuration: .ephemeral, delegate: api, delegateQueue: nil); return api
    }
    private static let accounts = privateAPI("https://accounts.spotify.com")
    private static let web = privateAPI("https://api.spotify.com")
    init(read: @escaping () throws -> SpotifyTokens? = { try SpotifyVault().read() },
         write: @escaping (SpotifyTokens?) throws -> Void = { try SpotifyVault().write($0) },
         transport: Transport? = nil) {
        self.readVault = read; self.writeVault = write
        self.transport = transport ?? { request in
            let api = request.url?.host == "accounts.spotify.com" ? Self.accounts : Self.web
            let (data, response) = try await api.session.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw Failure(message: "Spotify returned an invalid response.") }
            return (data, response)
        }
    }
    func connected() throws -> Bool {
        if !loaded { tokens = try readVault(); loaded = true }
        return tokens != nil
    }
    static func form(_ fields: [String: String]) -> Data {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return Data(fields.sorted { $0.key < $1.key }.map { "\($0.key.addingPercentEncoding(withAllowedCharacters: allowed)!)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&").utf8)
    }
    static func proof() throws -> (verifier: String, challenge: String) {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure(message: "Could not securely start Spotify sign-in.") }
        func url64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
        let verifier = url64(Data(bytes))
        return (verifier, url64(Data(SHA256.hash(data: Data(verifier.utf8)))))
    }
    private func exchange(_ fields: [String: String], previous: String = "", generation expected: Int) async throws -> String {
        var r = URLRequest(url: URL(string: "https://accounts.spotify.com/api/token")!); r.httpMethod = "POST"; r.timeoutInterval = 30
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        r.httpBody = Self.form(fields.merging(["client_id": Self.clientID]) { old, _ in old })
        let (data, response) = try await transport(r)
        let result = (try? JSONSerialization.jsonObject(with: data)) as? Object ?? [:]
        guard expected == generation else { throw CancellationError() }
        if response.statusCode == 400 && string(result["error"]) == "invalid_grant" {
            try disconnect(); throw Failure(message: "Your Spotify sign-in has expired. Choose Connect Spotify again.")
        }
        guard response.statusCode == 200, !string(result["access_token"]).isEmpty else { throw Failure(message: "Spotify could not complete sign-in (\(response.statusCode)). Please try again.") }
        let refresh = string(result["refresh_token"]).isEmpty ? previous : string(result["refresh_token"])
        guard !refresh.isEmpty else { throw Failure(message: "Spotify did not provide a renewable login. Please reconnect.") }
        let next = SpotifyTokens(access: string(result["access_token"]), refresh: refresh, expires: Date().addingTimeInterval(max(0, number(result["expires_in"]) - 60)))
        try Task.checkCancellation()
        try writeVault(next); tokens = next; loaded = true
        return next.access
    }
    private func access() async throws -> String {
        guard try connected(), let tokens else { throw Failure(message: "Choose Connect Spotify to sign in.") }
        if tokens.expires > Date() { return tokens.access }
        if let renewal { return try await renewal.value }
        let task = Task { try await self.exchange(["grant_type": "refresh_token", "refresh_token": tokens.refresh], previous: tokens.refresh, generation: self.generation) }
        renewal = task; defer { renewal = nil }; return try await task.value
    }
    func disconnect() throws {
        try writeVault(nil); generation += 1; renewal?.cancel(); renewal = nil; tokens = nil; loaded = true
    }
    func connect(deck: API) async throws {
        let proof = try Self.proof()
        let pending = try await deck.json("/api/spotify/native/start", body: [:])
        let id = string(pending["id"]), state = string(pending["state"]), redirect = string(pending["redirect"])
        guard UUID(uuidString: id) != nil, state.hasPrefix("casework-spotify-"), redirect == "http://127.0.0.1:4777/" else { throw Failure(message: "Update the local Cyberdeck service before connecting Spotify.") }
        let path = "/api/spotify/native/" + id
        defer { Task { _ = try? await deck.json(path + "/cancel", body: [:]) } }
        let url = URL(string: "https://accounts.spotify.com/authorize?" + query(["client_id": Self.clientID, "response_type": "code", "redirect_uri": redirect, "state": state, "scope": Self.scopes, "code_challenge_method": "S256", "code_challenge": proof.challenge]))!
        guard NSWorkspace.shared.open(url) else { throw Failure(message: "Could not open your browser for Spotify sign-in.") }
        for _ in 0..<600 {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            let result = try await deck.json(path)
            if result["pending"] as? Bool == true { continue }
            if !string(result["error"]).isEmpty { throw Failure(message: string(result["error"])) }
            let code = string(result["code"])
            guard !code.isEmpty else { throw Failure(message: "Spotify did not complete sign-in. Please try again.") }
            generation += 1; renewal?.cancel(); renewal = nil
            _ = try await exchange(["grant_type": "authorization_code", "code": code, "redirect_uri": redirect, "code_verifier": proof.verifier], generation: generation)
            NSApp.activate(ignoringOtherApps: true); return
        }
        throw Failure(message: "Spotify sign-in timed out. Choose Connect Spotify again.")
    }
    func request(_ path: String, method: String, body: Object?) async throws -> Object {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: "https://api.spotify.com/v1" + path), url.host == "api.spotify.com", url.scheme == "https", url.path.hasPrefix("/v1/") else { throw Failure(message: "Invalid Spotify request.") }
        guard Date() >= cooldown else { throw Failure(message: "Spotify is busy. Please wait a moment before trying again.") }
        for attempt in 0..<2 {
            let token = try await access()
            var r = URLRequest(url: url); r.httpMethod = method; r.timeoutInterval = 30
            r.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            if let body { r.httpBody = try JSONSerialization.data(withJSONObject: body); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            let (data, response) = try await transport(r)
            if response.statusCode == 401 && attempt == 0 {
                if let current = tokens, current.access == token { tokens = SpotifyTokens(access: current.access, refresh: current.refresh, expires: .distantPast) }
                continue
            }
            if response.statusCode == 429 { cooldown = Date().addingTimeInterval(max(1, Double(response.value(forHTTPHeaderField: "Retry-After") ?? "5") ?? 5)) }
            guard (200..<300).contains(response.statusCode) else {
                let message: String
                switch response.statusCode {
                case 401: message = "Spotify needs a fresh sign-in. Choose Connect Spotify again."
                case 403: message = "Spotify did not allow this action. Playback control requires Spotify Premium and an available device."
                case 404: message = "Open Spotify on your playback device, then choose Devices in Afterglow."
                case 429: message = "Spotify is busy. Please wait a moment before trying again."
                default: message = "Spotify could not complete this request (\(response.statusCode))."
                }
                throw Failure(message: message)
            }
            return (try? JSONSerialization.jsonObject(with: data)) as? Object ?? [:]
        }
        throw Failure(message: "Spotify needs a fresh sign-in.")
    }
}
