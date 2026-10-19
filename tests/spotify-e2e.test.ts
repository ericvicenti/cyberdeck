// Built UI + isolated browser. No user account, real Spotify calls, or live daemon mutations.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "path";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let base: string;
const clientId = "6dc6300fa4364a81acb8a5f5e920f809";
const track = {
  id: "track1",
  uri: "spotify:track:track1",
  name: "Test song",
  artists: [
    { id: "artist1", uri: "spotify:artist:artist1", name: "Test artist" },
  ],
  duration_ms: 180000,
  album: {
    id: "album1",
    uri: "spotify:album:album1",
    name: "Test album",
    images: [{ url: "https://art.example/cover.svg" }],
  },
  external_urls: { spotify: "https://open.spotify.com/track/track1" },
};
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const file = Bun.file(
        join(import.meta.dir, "../dist/ui", path === "/" ? "index.html" : path),
      );
      return (await file.exists())
        ? new Response(file)
        : new Response("missing", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
async function setup(width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(3500);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const archive = new Map<string, any>();
  await page.route("**/api/**", (route) => {
    if (!route.request().url().startsWith(base)) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/music/archive") {
      const method = route.request().method();
      const account = new URL(route.request().url()).searchParams.get(
        "account",
      );
      if (method === "PUT") {
        const record = route.request().postDataJSON();
        archive.set(record.key, record);
        return route.fulfill({ json: { saved: true } });
      }
      if (method === "DELETE") {
        for (const [key, record] of archive)
          if (record.account === account) archive.delete(key);
        return route.fulfill({ json: { deleted: true } });
      }
      return route.fulfill({
        json: {
          records: [...archive.values()].filter((r) => r.account === account),
          next: null,
        },
      });
    }
    const body =
      path === "/api/fleet/nodes"
        ? { self: { nodeId: "test", name: "Test" }, nodes: [] }
        : path === "/api/applications"
          ? { applications: [] }
          : {};
    return route.fulfill({
      status:
        path === "/api/fleet/nodes" || path === "/api/applications" ? 200 : 503,
      json: body,
    });
  });
  return { page, errors };
}
async function login(
  page: Page,
  options: { wrongState?: boolean; denied?: boolean } = {},
) {
  let tokenCalls = 0;
  await page.route("https://accounts.spotify.com/api/token", async (route) => {
    tokenCalls++;
    const body = new URLSearchParams(route.request().postData()!);
    expect(body.get("client_id")).toBe(clientId);
    expect(body.has("client_secret")).toBe(false);
    if (body.get("grant_type") === "authorization_code")
      expect(body.get("code_verifier")?.length).toBe(64);
    await route.fulfill({
      json: {
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
      },
    });
  });
  await page.route("https://accounts.spotify.com/authorize?**", (route) => {
    const q = new URL(route.request().url()).searchParams;
    // All three are required by the Web Playback SDK, independently of catalog access.
    const scopes = q.get("scope")!.split(" ");
    for (const scope of ["streaming", "user-read-email", "user-read-private"])
      expect(scopes).toContain(scope);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("redirect_uri")).toBe(base + "/");
    const args = new URLSearchParams({
      state: options.wrongState ? "incorrect" : q.get("state")!,
      ...(options.denied ? { error: "access_denied" } : { code: "test-code" }),
    });
    return route.fulfill({
      status: 302,
      headers: { location: base + "/?" + args },
    });
  });
  await page.goto(base + "/#/spotify");
  await page
    .getByRole("button", { name: "Connect Spotify", exact: true })
    .click();
  await page.waitForURL(base + "/#/spotify");
  return () => tokenCalls;
}
async function mockSpotify(
  page: Page,
  options: { noDevice?: boolean; holdReady?: boolean } = {},
) {
  const requests: { path: string; method: string; body: any }[] = [];
  let playing = false;
  let currentDevice = options.noDevice ? "" : "phone";
  const state = () => ({
    item: track,
    is_playing: playing,
    progress_ms: 12000,
    device: {
      id: currentDevice,
      name: currentDevice === "browser" ? "Cyberdeck" : "Phone",
      volume_percent: 50,
      supports_volume: true,
    },
    shuffle_state: false,
    repeat_state: "off",
  });
  await page.route("https://api.spotify.com/v1/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(3);
    requests.push({
      path: path + url.search,
      method: request.method(),
      body: request.postDataJSON(),
    });
    expect(request.headers().authorization).toBe("Bearer test-access");
    let json: unknown;
    if (path === "/me")
      json = { id: "listener1", display_name: "Test listener" };
    else if (path === "/me/playlists" && request.method() === "POST")
      json = {
        id: "playlist2",
        uri: "spotify:playlist:playlist2",
        name: request.postDataJSON().name,
        images: [],
        owner: { id: "listener1" },
      };
    else if (path === "/playlists/playlist2")
      json = {
        id: "playlist2",
        uri: "spotify:playlist:playlist2",
        name: "A new mix",
        images: [],
        owner: { id: "listener1" },
        items: { items: [], next: null },
      };
    else if (path === "/me/playlists")
      json = {
        items: [
          {
            id: "playlist1",
            uri: "spotify:playlist:playlist1",
            name: "Focus playlist",
            images: [],
            owner: { id: "listener1" },
          },
        ],
        next: null,
      };
    else if (path === "/me/player/devices")
      json = {
        devices: options.noDevice
          ? []
          : [
              {
                id: "phone",
                name: "Phone",
                is_active: true,
                is_restricted: false,
                volume_percent: 50,
              },
            ],
      };
    else if (path === "/playlists/playlist1" && request.method() === "GET")
      json = {
        id: "playlist1",
        uri: "spotify:playlist:playlist1",
        name: "Focus playlist",
        images: [],
        owner: { id: "listener1" },
        snapshot_id: "snap1",
        items: { items: [{ item: track }], next: null },
      };
    else if (path === "/albums/album1")
      json = {
        ...track.album,
        artists: track.artists,
        tracks: { items: [track], next: null },
      };
    else if (path === "/artists/artist1") json = track.artists[0];
    else if (path === "/artists/artist1/albums")
      json = { items: [track.album], next: null };
    else if (path === "/me/player/queue" && request.method() === "GET")
      json = { queue: [track] };
    else if (path === "/me/library/contains") json = [false];
    else if (path === "/me/library")
      return route.fulfill({ status: 200, body: "" });
    else if (path === "/me/tracks" || path === "/me/player/recently-played")
      json = { items: [{ track }], next: null };
    else if (path === "/me/albums")
      json = { items: [{ album: track.album }], next: null };
    else if (path === "/me/following")
      json = { artists: { items: track.artists, next: null } };
    else if (path === "/search") {
      expect(url.searchParams.get("limit")).toBe("10");
      json = {
        tracks: { items: [track], next: null },
        artists: { items: track.artists },
        albums: { items: [track.album] },
        playlists: {
          items: [
            null,
            {
              id: "playlist1",
              uri: "spotify:playlist:playlist1",
              name: "Focus playlist",
              images: [],
            },
          ],
        },
      };
    } else if (path === "/me/player" && request.method() === "GET") {
      if (!currentDevice) return route.fulfill({ status: 204 });
      json = state();
    } else {
      if (path === "/me/player/play") {
        playing = true;
        currentDevice = url.searchParams.get("device_id")!;
        return route.fulfill({
          status: 200,
          contentType: "text/plain",
          body: "OK",
        });
      }
      if (path === "/me/player/pause") playing = false;
      if (path === "/me/player") {
        currentDevice = request.postDataJSON().device_ids[0];
        playing = true;
      }
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json });
  });
  await page.route("https://open.spotify.com/embed/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Spotify video fixture</p>",
    }),
  );
  await page.route("https://art.example/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#b6caa0"/><circle cx="320" cy="320" r="220" fill="#273b25"/><circle cx="320" cy="320" r="90" fill="#e78253"/><text x="320" y="325" fill="#211b10" font-size="24" text-anchor="middle">TEST RECORD</text></svg>',
    }),
  );
  await page.route("**/spotify-sdk.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    window.sdkDisconnects = 0;
    window.Spotify = { Player: class {
      constructor(options) { this.options = options; this.listeners = {}; window.testPlayer = this; }
      addListener(name, cb) { this.listeners[name] = cb; return true; }
      async connect() {
        this.options.getOAuthToken(() => {
          window.sdkConnected = true;
          ${
            options.holdReady
              ? ""
              : "this.listeners.ready({device_id:'browser'});"
          }
        });
        return true;
      }
      disconnect() { window.sdkDisconnects++; }
      async activateElement() { window.sdkActivated = true; }
      async pause() {}
    } }; window.onSpotifyWebPlaybackSDKReady();
  `,
    }),
  );
  return requests;
}

test("custom player is the only experience and fits mobile without external links", async () => {
  const { page, errors } = await setup(390);
  try {
    await page.goto(base + "/#/spotify");
    await page.getByRole("heading", { name: "Make room for music." }).waitFor();
    expect(
      await page.getByLabel("Spotify Client ID", { exact: true }).count(),
    ).toBe(0);
    expect(
      await page
        .getByTestId("spotify-app")
        .locator('a[href^="http"],a[href^="spotify:"]')
        .count(),
    ).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "/tmp/cyberdeck-spotify-setup-mobile.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
test("PKCE login, search, browser play, controls, navigation persistence, and disconnect", async () => {
  const { page, errors } = await setup();
  try {
    const requests = await mockSpotify(page);
    const count = await login(page);
    await page
      .getByText("CONNECTED AS Test listener", { exact: true })
      .waitFor();
    expect(count()).toBe(1);
    expect(page.url()).not.toContain("code=");
    await page.getByText("Playback & connection").click();
    await page.getByRole("button", { name: "Enable browser playback" }).click();
    await page.getByText("Browser ready", { exact: true }).waitFor();
    await page.getByLabel("Search Spotify", { exact: true }).fill("test");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .getByRole("button", { name: "Play Test song", exact: true })
      .click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    expect(
      requests.some(
        (r) =>
          r.path === "/me/player/play?device_id=browser" &&
          r.body?.uris?.[0] === "spotify:track:track1",
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Focus playlist", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Play playlist", exact: true })
      .click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    expect(
      requests.some(
        (r) => r.body?.context_uri === "spotify:playlist:playlist1",
      ),
    ).toBe(true);
    await page.getByTestId("nav-data").click();
    await page.getByTestId("spotify-app").waitFor({ state: "hidden" });
    expect(await page.evaluate(() => (window as any).sdkDisconnects)).toBe(0);
    await page.getByTestId("nav-spotify").click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.getByTestId("spotify-app").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: "/tmp/cyberdeck-spotify-connected.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Disconnect & clear archive", exact: true })
      .click();
    await page.getByRole("heading", { name: "Make room for music." }).waitFor();
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("cyberdeck-spotify-tokens"),
      ),
    ).toBeNull();
    expect(await page.evaluate(() => (window as any).sdkDisconnects)).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20000);
for (const entry of ["Play Test song", "Play playlist", "Play"]) {
  test(`${entry} starts browser playback with no prior device and waits for SDK readiness`, async () => {
    const { page, errors } = await setup();
    try {
      const requests = await mockSpotify(page, {
        noDevice: true,
        holdReady: true,
      });
      await login(page);
      await page
        .getByRole("button", { name: "Focus playlist", exact: true })
        .click();
      const play = page.getByRole("button", { name: entry, exact: true });
      expect(await play.isEnabled()).toBe(true);
      // The user never opens connection settings or enables a device manually.
      await play.click();
      await page.waitForFunction(() => (window as any).sdkConnected);
      await page
        .getByRole("status")
        .filter({ hasText: "Connecting browser" })
        .waitFor();
      expect(requests.some((r) => r.path.startsWith("/me/player/play?"))).toBe(
        false,
      );
      expect(await page.evaluate(() => (window as any).sdkActivated)).toBe(
        true,
      );
      await page.evaluate(() =>
        (window as any).testPlayer.listeners.ready({ device_id: "browser" }),
      );
      await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
      const request = requests.find(
        (r) => r.path === "/me/player/play?device_id=browser",
      );
      expect(request?.body.context_uri).toBe("spotify:playlist:playlist1");
      if (entry === "Play Test song")
        expect(request?.body.offset.uri).toBe(track.uri);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 15000);
}

test("Play reports SDK account errors immediately and can retry without hidden setup", async () => {
  const { page, errors } = await setup();
  try {
    const requests = await mockSpotify(page, {
      noDevice: true,
      holdReady: true,
    });
    await login(page);
    await page
      .getByRole("button", { name: "Focus playlist", exact: true })
      .click();
    const play = page.getByRole("button", {
      name: "Play Test song",
      exact: true,
    });
    await play.click();
    await page.waitForFunction(() => (window as any).sdkConnected);
    await page.evaluate(() => {
      (window as any).sdkConnected = false;
      (window as any).testPlayer.listeners.account_error({
        message: "Spotify Premium is required for browser playback.",
      });
    });
    await page
      .getByRole("alert")
      .filter({ hasText: "Spotify Premium is required" })
      .waitFor();
    expect(await play.isEnabled()).toBe(true);
    expect(requests.some((r) => r.path.startsWith("/me/player/play?"))).toBe(
      false,
    );
    await play.click();
    await page.waitForFunction(() => (window as any).sdkConnected);
    await page.evaluate(() =>
      (window as any).testPlayer.listeners.ready({ device_id: "browser" }),
    );
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 15000);

test("missing playback scopes exposes permission renewal beside the error", async () => {
  const { page, errors } = await setup();
  try {
    await mockSpotify(page, { noDevice: true, holdReady: true });
    const tokenCalls = await login(page);
    await page
      .getByRole("button", { name: "Focus playlist", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Play playlist", exact: true })
      .click();
    await page.waitForFunction(() => (window as any).sdkConnected);
    await page.evaluate(() =>
      (window as any).testPlayer.listeners.authentication_error({
        message: "Invalid token scopes.",
      }),
    );
    const renewal = page
      .getByRole("alert")
      .getByRole("button", { name: "Renew Spotify permissions" });
    await renewal.waitFor();
    await Promise.all([
      page.waitForResponse("https://accounts.spotify.com/api/token"),
      renewal.click(),
    ]);
    expect(tokenCalls()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 15000);

test("wrong OAuth state is rejected before token exchange", async () => {
  const { page } = await setup();
  try {
    const count = await login(page, { wrongState: true });
    await page
      .getByRole("alert")
      .filter({ hasText: "could not be verified" })
      .waitFor();
    expect(count()).toBe(0);
  } finally {
    await page.close();
  }
});
test("denied authorization gives a retryable error without token exchange", async () => {
  const { page } = await setup();
  try {
    const count = await login(page, { denied: true });
    await page.getByRole("alert").filter({ hasText: "canceled" }).waitFor();
    expect(count()).toBe(0);
  } finally {
    await page.close();
  }
});
test("expired token refresh is single-flight and SDK failure retains Connect controls", async () => {
  const { page } = await setup(390);
  try {
    await mockSpotify(page);
    await page.addInitScript(
      ({ clientId }) => {
        sessionStorage.setItem(
          "cyberdeck-spotify-tokens",
          JSON.stringify({
            access_token: "expired",
            refresh_token: "test-refresh",
            clientId,
            expires: 0,
          }),
        );
      },
      { clientId },
    );
    let refreshCalls = 0;
    await page.route(
      "https://accounts.spotify.com/api/token",
      async (route) => {
        refreshCalls++;
        expect(
          new URLSearchParams(route.request().postData()!).get("grant_type"),
        ).toBe("refresh_token");
        await new Promise((r) => setTimeout(r, 50));
        await route.fulfill({
          json: { access_token: "test-access", expires_in: 3600 },
        });
      },
    );
    await page.route("**/spotify-sdk.js", (route) => route.abort());
    await page.goto(base + "/#/spotify");
    await page
      .getByText("CONNECTED AS Test listener", { exact: true })
      .waitFor();
    expect(refreshCalls).toBe(1);
    await page.getByText("Playback & connection").click();
    await page.getByRole("button", { name: "Enable browser playback" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "could not load" })
      .waitFor();
    await page
      .getByLabel("Playback device", { exact: true })
      .selectOption("phone");
    await page
      .getByRole("button", { name: "Listen here", exact: true })
      .click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "/tmp/cyberdeck-spotify-connected-mobile.png",
      fullPage: true,
    });
  } finally {
    await page.close();
  }
}, 15000);

test("catalog navigation, playlist editing, queue, library, radio and video stay in the player", async () => {
  const { page, errors } = await setup();
  try {
    const requests = await mockSpotify(page);
    await login(page);
    await page.getByText("Playback & connection").click();
    await page.getByRole("button", { name: "Enable browser playback" }).click();
    await page.getByText("Browser ready", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Focus playlist", exact: true })
      .first()
      .click();
    await page
      .getByRole("heading", { name: "Focus playlist", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Test artist", exact: true })
      .first()
      .click();
    await page
      .getByRole("heading", { name: "Test artist", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Open album Test album", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Test album", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Play album", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    expect(
      requests.some((r) => r.body?.context_uri === "spotify:album:album1"),
    ).toBe(true);
    await page.getByLabel("Actions for Test song", { exact: true }).click();
    await page
      .getByRole("button", { name: "Add to queue", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Added Test song to queue" })
      .waitFor();
    expect(
      requests.some(
        (r) =>
          r.path.includes("/me/player/queue?") &&
          r.path.includes("uri=spotify%3Atrack%3Atrack1") &&
          r.method === "POST",
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Like / unlike song", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Saved to your Spotify library" })
      .waitFor();
    expect(
      requests.some(
        (r) => r.path.startsWith("/me/library?") && r.method === "PUT",
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Add to playlist", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Focus playlist", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Added to Focus playlist" })
      .waitFor();
    expect(
      requests.some(
        (r) =>
          r.path === "/playlists/playlist1/items" &&
          r.method === "POST" &&
          r.body.uris[0] === track.uri,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Find radio mixes", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Radio mixes", exact: true })
      .waitFor();
    expect(
      requests.some(
        (r) => r.path.includes("type=playlist") && r.path.includes("radio"),
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Focus playlist", exact: true })
      .first()
      .click();
    await page.getByLabel("Actions for Test song", { exact: true }).click();
    await page
      .getByRole("button", { name: "Remove song from playlist", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Focus playlist", exact: true })
      .waitFor();
    expect(
      requests.some(
        (r) =>
          r.path === "/playlists/playlist1/items" &&
          r.method === "DELETE" &&
          r.body.items[0].uri === track.uri,
      ),
    ).toBe(true);
    const frame = page.getByTitle("Spotify video for Test song");
    expect(await frame.getAttribute("sandbox")).not.toContain("allow-popups");
    expect(await frame.getAttribute("sandbox")).not.toContain(
      "allow-top-navigation",
    );
    await page.getByRole("button", { name: /Watch here/ }).click();
    expect(requests.some((r) => r.path.startsWith("/me/player/pause"))).toBe(
      true,
    );
    await page
      .getByRole("button", { name: "Close video playback", exact: true })
      .click();
    // closing the video leaves the listening room where it was (the playlist's own URL)
    expect(page.url().startsWith(base + "/#/spotify")).toBe(true);
    expect(page.url()).not.toContain("video");
    expect(
      await page.getByTestId("spotify-app").locator('a[href^="http"]').count(),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20000);

test("fullscreen artwork is reachable, archive survives reload and exports without tokens", async () => {
  const { page, errors } = await setup();
  try {
    await mockSpotify(page);
    await login(page);
    await page.getByText("Playback & connection").click();
    await page
      .getByRole("button", { name: "Listen here", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Expand artwork", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Close fullscreen", exact: true })
      .waitFor();
    expect(await page.locator(".music-full-art").isVisible()).toBe(true);
    await page.screenshot({ path: "/tmp/cyberdeck-spotify-fullscreen.png" });
    await page
      .getByRole("button", { name: "Close fullscreen", exact: true })
      .click();
    await page.reload();
    await page
      .getByRole("button", { name: "Listening journal", exact: false })
      .click();
    await page
      .getByRole("button", { name: "Play Test song", exact: true })
      .first()
      .waitFor();
    await page
      .locator(".music-sidebar")
      .getByText("Music archive", { exact: true })
      .click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export metadata", exact: true })
      .first()
      .click();
    const exported = await download;
    const path = await exported.path();
    const text = await Bun.file(path!).text();
    expect(text).toContain("Test song");
    expect(text).not.toContain("test-access");
    expect(text).not.toContain("test-refresh");
    const parsed = JSON.parse(text);
    expect(parsed.records.some((r: any) => r.kind === "listen")).toBe(true);
    await page
      .getByRole("button", { name: "Disconnect & clear archive", exact: true })
      .click();
    await page.getByRole("heading", { name: "Make room for music." }).waitFor();
    const count = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const req = indexedDB.open("cyberdeck-spotify", 2);
          req.onsuccess = () => {
            const count = req.result
              .transaction("records")
              .objectStore("records")
              .count();
            count.onsuccess = () => resolve(count.result);
            count.onerror = () => reject(count.error);
          };
        }),
    );
    expect(count).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20000);

test("creating from an editable playlist does not accidentally rename it", async () => {
  const { page } = await setup();
  try {
    const requests = await mockSpotify(page);
    await login(page);
    await page
      .getByRole("button", { name: "Focus playlist", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Rename playlist", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Create playlist", exact: true })
      .click();
    await page.getByLabel("Playlist name", { exact: true }).fill("A new mix");
    await page
      .getByRole("button", { name: "Save playlist", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "A new mix", exact: true })
      .waitFor();
    expect(
      requests.some(
        (r) =>
          r.path === "/me/playlists" &&
          r.method === "POST" &&
          r.body.name === "A new mix" &&
          r.body.public === false,
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) => r.path === "/playlists/playlist1" && r.method === "PUT",
      ),
    ).toBe(false);
  } finally {
    await page.close();
  }
}, 15000);

test("SDK audio tap saves non-silent playable audio and journal replays without Spotify or network", async () => {
  const { page, errors } = await setup();
  const sampleRate = 16000,
    samples = sampleRate * 12;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / sampleRate) * 6000),
      44 + i * 2,
    );
  await page.route("**/capture-test", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<iframe src="/spotify-player.html" allow="autoplay"></iframe><button onclick="document.querySelector('iframe').contentWindow.postMessage({start:true},location.origin)">Start</button><button onclick="document.querySelector('iframe').contentWindow.postMessage({stop:true},location.origin)">Stop</button><script>addEventListener('message', e => { if(e.data.ready)document.body.dataset.ready='true'; if(e.data.saved)document.body.dataset.saved='true'; if(e.data.message?.startsWith('Saved '))document.body.dataset.final='true'; if(e.data.message)document.body.dataset.message=e.data.message; });</script>`,
    }),
  );
  await page.route("https://sdk.scdn.co/embedded/index.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `
    const audio = new Audio('data:audio/wav;base64,${wav.toString("base64")}');
    // Synthetic PCM fixture exercises the tap without contacting Spotify or using protected media.
    Object.defineProperty(audio,'mediaKeys',{value:{}});
    addEventListener('message',e=>{if(e.data.start)audio.play();if(e.data.stop)audio.pause();});
    parent.postMessage({ready:true},location.origin);
  `,
    }),
  );
  await page.goto(base + "/capture-test");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  await page.evaluate((track) => {
    localStorage.setItem("cyberdeck-spotify-account", "listener1");
    document.querySelector("iframe")!.contentWindow!.postMessage(
      {
        cyberdeckCaptureState: {
          account: "listener1",
          track,
          paused: false,
          position: 0,
        },
      },
      location.origin,
    );
  }, track);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForFunction(
    () => document.body.dataset.saved === "true",
    undefined,
    { timeout: 10000 },
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.final === "true");
  const signal = await page.evaluate(async () => {
    const audio = await new Promise<Blob>((resolve) => {
      const req = indexedDB.open("cyberdeck-spotify", 2);
      req.onsuccess = () => {
        const db = req.result;
        const list = db.transaction("audio").objectStore("audio").getAll();
        list.onsuccess = () => {
          db.close();
          resolve(list.result[0]);
        };
      };
    });
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    let peak = 0;
    for (const v of decoded.getChannelData(0))
      peak = Math.max(peak, Math.abs(v));
    await context.close();
    return { peak, duration: decoded.duration };
  });
  expect(signal.peak).toBeGreaterThan(0.05);
  expect(signal.duration).toBeGreaterThan(1);
  await page.goto(base + "/#/spotify");
  await page.getByRole("region", { name: "Saved audio" }).waitFor();
  await page.context().setOffline(true);
  await page.getByRole("button", { name: /Play saved Test song/ }).click();
  await page.waitForFunction(() => {
    const a = document.querySelector(
      '[data-testid="saved-recording-audio"]',
    ) as HTMLAudioElement;
    return a && !a.paused && a.currentTime > 0.3;
  });
  expect(
    await page.getByRole("button", { name: "Pause saved audio" }).count(),
  ).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 20000);

test("Play defaults to this browser even when another Spotify device is connected", async () => {
  const { page } = await setup();
  try {
    const requests = await mockSpotify(page);
    await login(page);
    await page
      .getByText("CONNECTED AS Test listener", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    const request = requests.find((r) => r.path.startsWith("/me/player/play?"));
    expect(request?.path).toContain("device_id=browser");
    expect(request?.body).toEqual({ uris: [track.uri] });
  } finally {
    await page.close();
  }
}, 10000);
