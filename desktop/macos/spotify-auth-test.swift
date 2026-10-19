import Foundation

@main struct SpotifyAuthTests {
    @MainActor static func main() async throws {
        func response(_ status: Int, _ body: String = "{}", headers: [String: String] = [:]) -> (Data, HTTPURLResponse) {
            (Data(body.utf8), HTTPURLResponse(url: URL(string: "https://api.spotify.com/v1/me")!, statusCode: status, httpVersion: nil, headerFields: headers)!)
        }
        var saved: SpotifyTokens? = SpotifyTokens(access: "old", refresh: "refresh-original", expires: .distantPast)
        var renewals = 0, calls = 0
        let auth = SpotifyAuth(read: { saved }, write: { saved = $0 }, transport: { request in
            if request.url!.host == "accounts.spotify.com" {
                renewals += 1
                precondition(String(data: request.httpBody!, encoding: .utf8)!.contains("refresh_token=refresh-original"))
                try await Task.sleep(nanoseconds: 20_000_000)
                return response(200, "{\"access_token\":\"new\",\"expires_in\":3600}")
            }
            calls += 1; precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer new")
            return response(204, "")
        })
        async let first = auth.request("/me/player", method: "GET", body: nil)
        async let second = auth.request("/me/player", method: "GET", body: nil)
        _ = try await (first, second)
        precondition(renewals == 1 && calls == 2 && saved?.refresh == "refresh-original")
        let connected = try auth.connected(); precondition(connected)
        let proof = try SpotifyAuth.proof(); precondition(proof.verifier.count == 43 && proof.challenge.count == 43 && proof.verifier != proof.challenge)
        precondition(String(data: SpotifyAuth.form(["code": "a+b&c=d"]), encoding: .utf8) == "code=a%2Bb%26c%3Dd")
        var retryCalls = 0
        let retry = SpotifyAuth(read: { saved }, write: { saved = $0 }, transport: { request in
            if request.url!.host == "accounts.spotify.com" { return response(200, "{\"access_token\":\"renewed\",\"expires_in\":3600,\"refresh_token\":\"rotated\"}") }
            retryCalls += 1
            return retryCalls == 1 ? response(401) : response(200, "{\"ok\":true}")
        })
        let retried = try await retry.request("/me", method: "GET", body: nil)
        precondition(retried["ok"] as? Bool == true && retryCalls == 2 && saved?.refresh == "rotated")
        var limitCalls = 0
        let limited = SpotifyAuth(read: { saved }, write: { _ in }, transport: { _ in limitCalls += 1; return response(429, headers: ["Retry-After": "60"]) })
        for _ in 0..<2 { do { _ = try await limited.request("/me", method: "GET", body: nil); fatalError("must rate limit") } catch {} }
        precondition(limitCalls == 1)
        do { _ = try await auth.request("//evil.example/", method: "GET", body: nil); fatalError("must reject URL") } catch {}
        saved = SpotifyTokens(access: "expired", refresh: "revoked", expires: .distantPast)
        let revoked = SpotifyAuth(read: { saved }, write: { saved = $0 }, transport: { _ in response(400, "{\"error\":\"invalid_grant\"}") })
        do { _ = try await revoked.request("/me", method: "GET", body: nil); fatalError("must reject revoked grant") } catch {}
        precondition(saved == nil)
        // Never touch the real Casework Keychain item during tests.
        print("PASS: PKCE, form encoding, concurrent renewal, rotation, 401 retry, cooldown, URL guard, revoked login")
    }
}
