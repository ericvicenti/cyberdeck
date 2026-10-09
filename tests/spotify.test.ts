import { test, expect } from "bun:test";
import { pkceChallenge, spotifyRedirect, spotifyUri } from "../ui/lib/spotify";

test("PKCE matches the RFC 7636 S256 test vector", async () => {
  expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
test("Spotify redirects require HTTPS or literal loopback, with no hash", () => {
  expect(spotifyRedirect("http://127.0.0.1:4777")).toBe("http://127.0.0.1:4777/");
  expect(spotifyRedirect("http://[::1]:4777")).toBe("http://[::1]:4777/");
  expect(spotifyRedirect("https://yacht.example.ts.net")).toBe("https://yacht.example.ts.net/");
  for (const url of ["http://localhost:4777", "http://100.64.1.2:4777", "http://yacht:4777", "ftp://127.0.0.1"]) expect(() => spotifyRedirect(url)).toThrow();
});
test("Spotify links allow only supported content from Spotify", () => {
  expect(spotifyUri("https://open.spotify.com/track/abc123?si=abc")).toBe("spotify:track:abc123");
  expect(spotifyUri("https://open.spotify.com/intl-es/album/abc123")).toBe("spotify:album:abc123");
  expect(spotifyUri("spotify:playlist:abc123")).toBe("spotify:playlist:abc123");
  for (const url of ["https://evil.example/track/abc123", "https://open.spotify.com.evil.example/track/abc", "javascript:alert(1)", "spotify:artist:abc", "search words"]) expect(spotifyUri(url)).toBeNull();
});
