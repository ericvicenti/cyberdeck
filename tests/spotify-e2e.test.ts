// Built UI + isolated browser. No user account, real Spotify calls, or live daemon mutations.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "path";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let base: string;
const clientId = "a".repeat(32);
const track = { id: "track1", uri: "spotify:track:track1", name: "Test song", artists: [{ name: "Test artist" }], duration_ms: 180000, album: { images: [] }, external_urls: { spotify: "https://open.spotify.com/track/track1" } };
beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(import.meta.dir, "../dist/ui", path === "/" ? "index.html" : path));
    return await file.exists() ? new Response(file) : new Response("missing", { status: 404 });
  } });
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); });
async function setup(width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", route => {
    if (!route.request().url().startsWith(base)) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    const body = path === "/api/fleet/nodes" ? { self: { nodeId: "test", name: "Test" }, nodes: [] } : path === "/api/applications" ? { applications: [] } : {};
    return route.fulfill({ status: path === "/api/fleet/nodes" || path === "/api/applications" ? 200 : 503, json: body });
  });
  return { page, errors };
}
async function login(page: Page, options: { wrongState?: boolean; denied?: boolean } = {}) {
  let tokenCalls = 0;
  await page.route("https://accounts.spotify.com/api/token", async route => {
    tokenCalls++;
    const body = new URLSearchParams(route.request().postData()!);
    expect(body.get("client_id")).toBe(clientId);
    expect(body.has("client_secret")).toBe(false);
    if (body.get("grant_type") === "authorization_code") expect(body.get("code_verifier")?.length).toBe(64);
    await route.fulfill({ json: { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 } });
  });
  await page.route("https://accounts.spotify.com/authorize?**", route => {
    const q = new URL(route.request().url()).searchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("redirect_uri")).toBe(base + "/");
    const args = new URLSearchParams({ state: options.wrongState ? "incorrect" : q.get("state")!, ...(options.denied ? { error: "access_denied" } : { code: "test-code" }) });
    return route.fulfill({ status: 302, headers: { location: base + "/?" + args } });
  });
  await page.goto(base + "/#/spotify");
  await page.getByText("Advanced: custom Cyberdeck player", { exact: true }).click();
  await page.getByLabel("Spotify Client ID", { exact: true }).fill(clientId);
  await page.getByRole("button", { name: "Connect Spotify", exact: true }).click();
  await page.waitForURL(base + "/#/spotify");
  return () => tokenCalls;
}
async function mockSpotify(page: Page) {
  const requests: { path: string; method: string; body: any }[] = [];
  let playing = false;
  let currentDevice = "phone";
  const state = () => ({ item: track, is_playing: playing, progress_ms: 12000, device: { id: currentDevice, name: currentDevice === "browser" ? "Cyberdeck" : "Phone", volume_percent: 50, supports_volume: true }, shuffle_state: false, repeat_state: "off" });
  await page.route("https://api.spotify.com/v1/**", route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(3);
    requests.push({ path: path + url.search, method: request.method(), body: request.postDataJSON() });
    expect(request.headers().authorization).toBe("Bearer test-access");
    let json: unknown;
    if (path === "/me") json = { display_name: "Test listener" };
    else if (path === "/me/playlists") json = { items: [{ id: "playlist1", uri: "spotify:playlist:playlist1", name: "Focus playlist", images: [] }], next: null };
    else if (path === "/me/player/devices") json = { devices: [{ id: "phone", name: "Phone", is_active: true, is_restricted: false, volume_percent: 50 }] };
    else if (path === "/search") { expect(url.searchParams.get("limit")).toBe("10"); json = { tracks: { items: [track] } }; }
    else if (path === "/me/player" && request.method() === "GET") json = state();
    else {
      if (path === "/me/player/play") { playing = true; currentDevice = url.searchParams.get("device_id")!; }
      if (path === "/me/player/pause") playing = false;
      if (path === "/me/player") { currentDevice = request.postDataJSON().device_ids[0]; playing = true; }
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json });
  });
  await page.route("https://sdk.scdn.co/spotify-player.js", route => route.fulfill({ contentType: "application/javascript", body: `
    window.sdkDisconnects = 0;
    window.Spotify = { Player: class {
      constructor(options) { this.options = options; this.listeners = {}; }
      addListener(name, cb) { this.listeners[name] = cb; return true; }
      async connect() { this.options.getOAuthToken(() => this.listeners.ready({device_id:'browser'})); return true; }
      disconnect() { window.sdkDisconnects++; }
      async activateElement() { window.sdkActivated = true; }
    } }; window.onSpotifyWebPlaybackSDKReady();
  ` }));
  return requests;
}

test("default opens the official player without developer setup and fits mobile", async () => {
  const { page, errors } = await setup(390);
  try {
    await page.goto(base + "/#/spotify");
    await page.getByRole("heading", { name: "Just open Spotify and play." }).waitFor();
    expect(await page.getByLabel("Spotify Client ID", { exact: true }).isVisible()).toBe(false);
    expect(await page.getByTestId("spotify-open-player").getAttribute("href")).toBe("https://open.spotify.com/");
    expect(await page.getByTestId("spotify-open-player").getAttribute("target")).toBe("_blank");
    expect(await page.getByRole("link", { name: "Open Spotify app", exact: true }).getAttribute("href")).toBe("spotify:");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/cyberdeck-spotify-setup-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
test("PKCE login, search, browser play, controls, navigation persistence, and disconnect", async () => {
  const { page, errors } = await setup();
  try {
    const requests = await mockSpotify(page);
    const count = await login(page);
    await page.getByText("Connected as Test listener").waitFor();
    expect(count()).toBe(1);
    expect(page.url()).not.toContain("code=");
    await page.getByRole("button", { name: "Enable browser playback" }).click();
    await page.getByText("Browser ready", { exact: true }).waitFor();
    await page.getByLabel("Search Spotify", { exact: true }).fill("test");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Play Test song", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    expect(requests.some(r => r.path === "/me/player/play?device_id=browser" && r.body?.uris?.[0] === "spotify:track:track1")).toBe(true);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).waitFor();
    await page.getByRole("button", { name: "Play playlist", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    expect(requests.some(r => r.body?.context_uri === "spotify:playlist:playlist1")).toBe(true);
    await page.getByTestId("nav-data").click();
    await page.getByTestId("spotify-app").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => (window as any).sdkDisconnects)).toBe(0);
    await page.getByTestId("nav-spotify").click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.getByTestId("spotify-app").evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: "/tmp/cyberdeck-spotify-connected.png", fullPage: true });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("heading", { name: "Just open Spotify and play." }).waitFor();
    expect(await page.evaluate(() => sessionStorage.getItem("cyberdeck-spotify-tokens"))).toBeNull();
    expect(await page.evaluate(() => (window as any).sdkDisconnects)).toBe(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 20000);
test("wrong OAuth state is rejected before token exchange", async () => {
  const { page } = await setup();
  try { const count = await login(page, { wrongState: true }); await page.getByRole("alert").filter({ hasText: "could not be verified" }).waitFor(); expect(count()).toBe(0); } finally { await page.close(); }
});
test("denied authorization gives a retryable error without token exchange", async () => {
  const { page } = await setup();
  try { const count = await login(page, { denied: true }); await page.getByRole("alert").filter({ hasText: "canceled" }).waitFor(); expect(count()).toBe(0); } finally { await page.close(); }
});
test("expired token refresh is single-flight and SDK failure retains Connect controls", async () => {
  const { page } = await setup(390);
  try {
    await mockSpotify(page);
    await page.addInitScript(({ clientId }) => { sessionStorage.setItem("cyberdeck-spotify-tokens", JSON.stringify({ access_token: "expired", refresh_token: "test-refresh", clientId, expires: 0 })); }, { clientId });
    let refreshCalls = 0;
    await page.route("https://accounts.spotify.com/api/token", async route => {
      refreshCalls++;
      expect(new URLSearchParams(route.request().postData()!).get("grant_type")).toBe("refresh_token");
      await new Promise(r => setTimeout(r, 50));
      await route.fulfill({ json: { access_token: "test-access", expires_in: 3600 } });
    });
    await page.route("https://sdk.scdn.co/spotify-player.js", route => route.abort());
    await page.goto(base + "/#/spotify");
    await page.getByText("Connected as Test listener").waitFor();
    expect(refreshCalls).toBe(1);
    await page.getByRole("button", { name: "Enable browser playback" }).click();
    await page.getByRole("alert").filter({ hasText: "could not load" }).waitFor();
    await page.getByLabel("Playback device", { exact: true }).selectOption("phone");
    await page.getByRole("button", { name: "Listen here", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/cyberdeck-spotify-connected-mobile.png", fullPage: true });
  } finally { await page.close(); }
}, 15000);
