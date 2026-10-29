// Full-app e2e: real daemon (sandboxed CYBERDECK_HOME), real built UI, real
// Chromium. Covers browse, create, edit/save, rename, copy/paste, chmod,
// symlinks, hidden files, upload, delete, and the web terminal.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, lstatSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import type { Subprocess } from "bun";

const PORT = 4795;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "e2e-test-token";
const ROOT = join(import.meta.dir, "..");

let cyberdeckHome: string;
let play: string; // playground dir inside $HOME (fs API is home-confined)
let daemon: Subprocess;
let browser: Browser;
let page: Page;

async function waitFor(fn: () => Promise<boolean> | boolean, ms = 15000, step = 150): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, step));
  }
}

const gotoFiles = async (path: string, node = "") => {
  await page.goto(`${BASE}/#/files?path=${encodeURIComponent(path)}${node ? `&node=${node}` : ""}`);
  await page.waitForSelector('[data-testid="files-table"]');
  // wait until the breadcrumbs reflect THIS directory (hash navigation keeps
  // the previous listing rendered while the new one loads)
  const base = path.split("/").pop()!;
  await waitFor(async () => {
    const crumbs = await page.textContent('[data-testid="breadcrumbs"]').catch(() => "");
    return (crumbs ?? "").includes(base);
  });
};

const rowMenu = async (name: string, itemLabel: string) => {
  await page.click(`[data-testid="row-${name}"]`, { button: "right" });
  await page.waitForSelector('[data-testid="context-menu"]');
  await page.click(`[data-testid="context-menu"] >> text=${itemLabel}`);
};

beforeAll(async () => {
  // sandboxed daemon home
  cyberdeckHome = mkdtempSync(join(tmpdir(), "cyberdeck-e2e-home-"));
  writeFileSync(join(cyberdeckHome, "token"), TOKEN);
  play = mkdtempSync(join(homedir(), ".cyberdeck-e2e-play-"));
  writeFileSync(
    join(cyberdeckHome, "config.json"),
    JSON.stringify({ nodeName: "e2e-node", port: PORT, bind: "127.0.0.1", roots: [play], dataRoots: [join(play, "userdata")], cacheDirs: ["Caches"], watch: false, autoUpdate: false, junkDirs: ["node_modules"], skipDirs: [".git"], scanDepth: 2, fleetDir: null })
  );
  writeFileSync(join(play, "readme.md"), "# playground\n");
  writeFileSync(join(play, "script.ts"), "export const x = 1\n");
  writeFileSync(join(play, ".secret"), "hidden!\n");
  mkdirSync(join(play, "folder"));
  writeFileSync(join(play, "folder", "inside.txt"), "inner content\n");
  mkdirSync(join(play, "userdata", "My Novel"), { recursive: true });
  writeFileSync(join(play, "userdata", "My Novel", "draft.txt"), "important words");
  mkdirSync(join(play, "userdata", "Caches"));
  writeFileSync(join(play, "userdata", "Caches", "junk"), "cache bytes");

  daemon = Bun.spawn(["bun", "run", join(ROOT, "src/daemon/main.ts")], {
    // pty runner only: a tmux-backed session would outlive this sandboxed daemon
    env: { ...process.env, CYBERDECK_HOME: cyberdeckHome, CYBERDECK_SESSIONS_TMUX: "0", CYBERDECK_USAGE_NET: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(async () => {
    try {
      const res = await fetch(`${BASE}/api/status?token=${TOKEN}`);
      return res.ok;
    } catch {
      return false;
    }
  });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/#t=${TOKEN}`);
  await page.waitForSelector("text=Fleet");
}, 60000);

afterAll(async () => {
  await browser?.close();
  daemon?.kill();
  daemon2?.kill();
  rmSync(cyberdeckHome, { recursive: true, force: true });
  if (home2) rmSync(home2, { recursive: true, force: true });
  rmSync(play, { recursive: true, force: true });
});

test("shell renders: title bar, activity bar, home dashboard", async () => {
  expect(await page.textContent("header")).toContain("Cyberdeck");
  expect(await page.isVisible('[data-testid="nav-files"]')).toBe(true);
  expect(await page.textContent("main")).toContain("this machine");
  // the dashboard widgets render from /api/dashboard (usage lookups are offline in e2e)
  await page.waitForSelector('[data-testid="widget-storage"]');
  await waitFor(async () => (await page.textContent('[data-testid="widget-storage"]'))?.includes("free") ?? false);
  expect(await page.textContent('[data-testid="widget-claude"]')).toContain("session");
  expect(await page.textContent('[data-testid="widget-backup"]')).toContain("not configured");
  expect(await page.textContent('[data-testid="widget-activity"]')).toContain("cc");
  // every machine gets a row in Systems; with no peers that is just this one
  await waitFor(async () => (await page.textContent('[data-testid="widget-system"]'))?.includes("memory") ?? false);
  expect(await page.textContent('[data-testid="system-e2e-node"]')).toContain("this machine");
  // the reset row is always there; offline it says so instead of offering a button
  expect(await page.isVisible('[data-testid="widget-codex-resets"]')).toBe(true);
  expect(await page.isVisible('[data-testid="widget-codex-use-reset"]')).toBe(false);
});

test("header Fleet chip opens the Fleet overview from Services", async () => {
  await page.goto(`${BASE}/#/services`);
  await page.click('[data-testid="header-fleet"]');
  await waitFor(async () => new URL(page.url()).hash.startsWith("#/fleet"));
  expect(await page.isVisible('[data-testid="network-map"]')).toBe(true);
});

test("desk view: talk button and the not-configured card render", async () => {
  // the test daemon has no Seed agents bridge, so voice reports unconfigured
  await page.goto(`${BASE}/#/desk`);
  await page.waitForSelector('[data-testid="talk-button"]');
  expect(await page.textContent('[data-testid="talk-button"]')).toMatch(/talk/i);
  expect(await page.isVisible('[data-testid="nav-desk"]')).toBe(true);
  await page.waitForSelector('[data-testid="voice-unconfigured"]');
  const card = await page.textContent('[data-testid="voice-unconfigured"]');
  expect(card).toContain("not configured");
  expect(await page.isVisible('[data-testid="voice-setup"]')).toBe(true);
  // nothing to talk to: the button is inert and the state label says so
  expect(await page.isDisabled('[data-testid="talk-button"]')).toBe(true);
  expect(await page.textContent('[data-testid="voice-state"]')).toContain("tap to talk");
  // talk modes: hands-free is the default; push to talk is remembered across reloads and changes the state line
  expect(await page.getAttribute('[data-testid="voice-mode-hands-free"]', "aria-pressed")).toBe("true");
  expect(await page.getAttribute('[data-testid="talk-button"]', "data-mode")).toBe("hands-free");
  await page.click('[data-testid="voice-mode-push-to-talk"]');
  expect(await page.getAttribute('[data-testid="voice-mode-push-to-talk"]', "aria-pressed")).toBe("true");
  expect(await page.textContent('[data-testid="voice-state"]')).toContain("hold to talk");
  await page.reload();
  await page.waitForSelector('[data-testid="talk-button"][data-mode="push-to-talk"]');
  expect(await page.evaluate(() => localStorage.getItem("cyberdeck-voice-mode"))).toBe("push-to-talk");
  await page.click('[data-testid="voice-mode-hands-free"]');
  expect(await page.textContent('[data-testid="voice-state"]')).toContain("tap to talk");
  expect(await page.textContent('[data-testid="voice-status"]')).toContain("e2e-node");
  expect(await page.textContent('[data-testid="voice-transcript"]')).toContain("transcript");
  // the Fleet / Services / Agents glance sits under the TALK button; this node has no fleet dir and says so
  await page.waitForFunction(() => document.querySelector('[data-testid="glance-empty"]')?.textContent?.includes("No fleet dir"));
  await page.click('[data-testid="glance-tab-services"]');
  expect(await page.getAttribute('[data-testid="glance-tab-services"]', "aria-selected")).toBe("true");
  expect(await page.isVisible('[data-testid="glance-services"]')).toBe(true);
  // "Add to Home Screen" from here installs the Desk (its own manifest + icon), and the manifest is served
  expect(await page.getAttribute('link[rel="manifest"]', "href")).toBe("/desk.webmanifest");
  expect(await page.getAttribute('meta[name="apple-mobile-web-app-title"]', "content")).toBe("Desk");
  const m = await (await fetch(`${BASE}/desk.webmanifest`)).json();
  expect(m.start_url).toBe("/#/desk");
  await page.goto(`${BASE}/#/services`);
  await page.waitForFunction(() => document.querySelector('link[rel="manifest"]')?.getAttribute("href") === "/manifest.webmanifest");
}, 20000);

test("desk view: the daemon relays voice to the hub; the page names it and nothing on the page picks a machine", async () => {
  // voice is centralized: the daemon in view answers with `via` and the page talks to nobody else
  const calls: string[] = [];
  await page.route("**/api/voice/**", (r) => {
    const path = new URL(r.request().url()).pathname.split("/api/")[1];
    calls.push(path);
    const via = { node: "n-hub", name: "Clipper" };
    if (path === "voice/config") return r.fulfill({ json: { configured: true, provider: "livekit", engine: "seed", agentId: "agent-1", sessionId: "sess-1234abcd", via } });
    if (path === "voice/status") return r.fulfill({ json: { configured: true, agent: { id: "agent-1", name: "Companion" }, sessionId: "sess-1234abcd", health: { ok: true }, via } });
    return r.fulfill({ json: { supported: true, messages: [{ role: "assistant", text: "hello from clipper", at: 1 }], via } });
  });
  try {
    await page.goto(`${BASE}/#/fleet`);
    // no page-wide machine dropdown anywhere: the header names the serving machine
    expect(await page.isVisible('[data-testid="node-switcher"]')).toBe(false);
    await page.waitForSelector('[data-testid="header-node"]');
    await page.goto(`${BASE}/#/desk`);
    await page.waitForSelector('[data-testid="talk-button"]');
    await waitFor(async () => (await page.textContent('[data-testid="voice-node"]'))?.includes("Clipper") ?? false);
    expect(await page.isVisible('[data-testid="node-switcher"]')).toBe(false);
    expect(await page.isVisible('[data-testid="voice-unconfigured"]')).toBe(false);
    await waitFor(async () => (await page.textContent('[data-testid="voice-status"]'))?.includes("Companion") ?? false);
    await waitFor(async () => (await page.textContent('[data-testid="voice-transcript"]'))?.includes("hello from clipper") ?? false);
    expect(calls).toContain("voice/config");
    expect(calls.some((c) => c.startsWith("voice/transcript"))).toBe(true);
    expect(calls.every((c) => !c.includes("/proxy/"))).toBe(true);
    await page.goto(`${BASE}/#/fleet`);
    await page.waitForSelector('[data-testid="header-node"]');
  } finally {
    await page.unroute("**/api/voice/**");
  }
}, 30000);

test("desk view: a hub that is paired but not answering shows the offline card, not setup", async () => {
  const via = { node: "n-hub", name: "Clipper" };
  const hub = { name: "Clipper", node: "n-hub", reachable: false, since: Date.now() - 60_000, lastSeen: Date.now() - 2 * 3600_000 };
  const reason = "voice hub Clipper is paired but not answering (no answer in time; last seen 2 h ago); calls resume when it is back on the network";
  await page.route("**/api/voice/**", (r) => {
    const path = new URL(r.request().url()).pathname.split("/api/")[1];
    if (path === "voice/config") return r.fulfill({ json: { configured: false, provider: "none", engine: "seed", reason, via, hub } });
    if (path === "voice/status") return r.fulfill({ json: { configured: false, reason, via, hub, local: { configured: false, reason: "no bridge" } } });
    return r.fulfill({ status: 503, json: { supported: true, messages: [], error: reason, via, hub } });
  });
  try {
    await page.goto(`${BASE}/#/desk`);
    await page.waitForSelector('[data-testid="voice-hub-offline"]');
    const card = await page.textContent('[data-testid="voice-hub-offline"]');
    expect(card).toContain("voice hub Clipper is offline");
    expect(card).toContain("not answering");
    expect(card).toContain("last seen");
    expect(await page.isVisible('[data-testid="voice-unconfigured"]')).toBe(false);
    expect(await page.isVisible('[data-testid="voice-setup"]')).toBe(false);
    await waitFor(async () => (await page.textContent('[data-testid="voice-node"]'))?.includes("Clipper offline") ?? false);
    const talk = await page.$('[data-testid="talk-button"]');
    expect(talk).not.toBeNull();
    expect(await talk!.isDisabled()).toBe(true);
  } finally {
    await page.unroute("**/api/voice/**");
  }
}, 30000);

test("desk view: a node that is itself off the tailnet says so instead of blaming the hub", async () => {
  const via = { node: "n-hub", name: "Clipper" };
  const hub = { name: "Clipper", node: "n-hub", reachable: false, since: Date.now() - 60_000, lastSeen: Date.now() - 10 * 3600_000, tailnet: { state: "NeedsLogin", running: false } };
  const reason = "e2e is off the tailnet, so voice hub Clipper is out of reach (Tailscale on e2e is logged out: log in from the Tailscale menu there, or run tailscale up; hub last seen 10 h ago); calls resume once this node is back on the tailnet";
  await page.route("**/api/voice/**", (r) => {
    const path = new URL(r.request().url()).pathname.split("/api/")[1];
    if (path === "voice/config") return r.fulfill({ json: { configured: false, provider: "none", engine: "seed", reason, via, hub } });
    if (path === "voice/status") return r.fulfill({ json: { configured: false, reason, via, hub, local: { configured: false, reason: "no bridge" } } });
    return r.fulfill({ status: 503, json: { supported: true, messages: [], error: reason, via, hub } });
  });
  try {
    await page.goto(`${BASE}/#/desk`);
    await page.waitForSelector('[data-testid="voice-hub-offline"]');
    await waitFor(async () => (await page.textContent('[data-testid="voice-hub-offline-title"]'))?.includes("is off the tailnet") ?? false);
    const card = await page.textContent('[data-testid="voice-hub-offline"]');
    expect(card).not.toContain("voice hub Clipper is offline");
    expect(card).toContain("Tailscale on e2e is logged out");
    expect(card).toContain("Clipper is probably fine");
    expect(await page.isVisible('[data-testid="voice-unconfigured"]')).toBe(false);
    await waitFor(async () => (await page.textContent('[data-testid="voice-node"]'))?.includes("Clipper out of reach") ?? false);
  } finally {
    await page.unroute("**/api/voice/**");
  }
}, 30000);

test("desk view: a hub reached over Probe that stops answering reads as a Probe outage, not a tailnet one", async () => {
  const via = { node: "n-hub", name: "Clipper", transport: "probe" };
  const hub = { name: "Clipper", node: "n-hub", reachable: false, since: Date.now() - 60_000, lastSeen: Date.now() - 10 * 3600_000, transport: "probe" };
  const reason = "voice hub Clipper is paired but not answering over Probe (Probe SSH tunnel failed: channel 0: open failed; last seen 10 h ago); calls resume when the Probe tunnel to it is back";
  await page.route("**/api/voice/**", (r) => {
    const path = new URL(r.request().url()).pathname.split("/api/")[1];
    if (path === "voice/config") return r.fulfill({ json: { configured: false, provider: "none", engine: "seed", reason, via, hub } });
    if (path === "voice/status") return r.fulfill({ json: { configured: false, reason, via, hub, local: { configured: false, reason: "no bridge" } } });
    return r.fulfill({ status: 503, json: { supported: true, messages: [], error: reason, via, hub } });
  });
  try {
    await page.goto(`${BASE}/#/desk`);
    await page.waitForSelector('[data-testid="voice-hub-offline"]');
    await waitFor(async () => (await page.textContent('[data-testid="voice-hub-offline-title"]'))?.includes("voice hub Clipper is offline") ?? false);
    const card = await page.textContent('[data-testid="voice-hub-offline"]');
    expect(card).toContain("not answering over Probe");
    expect(card).toContain("through Clipper over Probe");
    expect(card).not.toContain("tailnet");
    await waitFor(async () => (await page.textContent('[data-testid="voice-node"]'))?.includes("Clipper offline") ?? false);
    expect(await page.getAttribute('[data-testid="voice-node"]', "title")).toContain("over the Probe SSH relay");
  } finally {
    await page.unroute("**/api/voice/**");
  }
}, 30000);

test("applications: the Casework kitchen sink is an example app with a live console", async () => {
  await page.click('[data-testid="nav-applications"]');
  await page.waitForSelector('[data-testid="app-kitchen-sink"]');
  expect(await page.textContent('[data-testid="app-kitchen-sink"]')).toContain("Casework example");
  await page.click('[data-testid="app-kitchen-sink"]');
  await page.waitForSelector('[data-testid="casework-pair"] svg');
  expect(await page.textContent('[data-testid="casework-console"]')).toContain("No device is connected");

  // A device pairs (what the Casework Desk app does over /control) and the console picks it up live.
  const { key } = await (await fetch(`${BASE}/api/casework/pairing?token=${TOKEN}`)).json();
  const frames: any[] = [];
  const device = new WebSocket(`ws://127.0.0.1:${PORT}/control`);
  device.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
  await new Promise<void>((r) => { device.onopen = () => { device.send(JSON.stringify({ type: "hello", role: "device", token: key, info: { name: "buoy", model: "iPad Pro" } })); r(); }; });
  await waitFor(async () => frames.some((f) => f.type === "welcome"));
  await page.waitForSelector('[data-testid="casework-send"]');
  expect(await page.textContent('select[aria-label="Device"]')).toContain("buoy");

  // Send the app: the device is told to show the kitchen-sink module, and the console knows it is there.
  await page.click('[data-testid="casework-send"]');
  await waitFor(async () => frames.some((f) => f.type === "scene" && f.scene.tree.props.name === "kitchen-sink"));
  await waitFor(async () => (await page.textContent('[data-testid="casework-send"]'))?.includes("is open on the device") ?? false);
  // A console button becomes a native command on the device; what the device reports shows up on the page.
  await page.click('button:has-text("Camera + QR")');
  await waitFor(async () => frames.some((f) => f.type === "command" && f.action.name === "demo.tab" && f.action.args.name === "Camera + QR"));
  device.send(JSON.stringify({ type: "event", name: "camera.barcode", data: { type: "qr", data: "CYBERDECK: scanned" } }));
  await waitFor(async () => (await page.textContent('[data-testid="casework-scanned"]'))?.includes("CYBERDECK: scanned") ?? false);
  expect(await page.textContent('[data-testid="casework-events"]')).toContain("camera.barcode");
  device.close();
  await waitFor(async () => (await page.textContent('[data-testid="casework-console"]'))?.includes("No device is connected") ?? false);

  // Inside the Casework Desk app's WebView the same card opens the app natively on that device.
  const inApp = await browser.newPage({ viewport: { width: 1024, height: 1366 } });
  await inApp.addInitScript(() => { (window as any).posted = []; (window as any).ReactNativeWebView = { postMessage: (m: string) => (window as any).posted.push(m) }; });
  await inApp.goto(`${BASE}/#t=${TOKEN}`);
  await inApp.waitForSelector("text=Fleet");
  await inApp.goto(`${BASE}/#/applications`);
  await inApp.click('[data-testid="app-kitchen-sink-native"]');
  expect(await inApp.evaluate(() => (window as any).posted)).toEqual([JSON.stringify({ cyberdeck: "scene", name: "kitchen-sink" })]);
  await inApp.close();
  await page.click('[data-testid="nav-fleet"]');
}, 30000);

test("data view: user data inventory + repos table", async () => {
  await page.click('[data-testid="nav-data"]');
  await page.waitForSelector("text=Repositories");
  await page.waitForSelector('[data-testid="data-table"]');
  await waitFor(async () => (await page.textContent('[data-testid="data-table"]'))?.includes("My Novel") ?? false);
  const table = await page.textContent('[data-testid="data-table"]');
  expect(table).toContain("Caches");
  expect(await page.textContent("main")).toContain("User data");
});

test("files: can browse the system root", async () => {
  await page.goto(`${BASE}/#/files?path=/`);
  await page.waitForSelector('[data-testid="row-Users"]');
  expect(await page.isVisible('[data-testid="row-Users"]')).toBe(true);
  // breadcrumb shows / and navigating into /Users works
  await page.dblclick('[data-testid="row-Users"]');
  await page.waitForSelector('[data-testid^="row-"]');
});

test("files: lists playground entries with metadata", async () => {
  await gotoFiles(play);
  await page.waitForSelector('[data-testid="row-readme.md"]');
  expect(await page.isVisible(`[data-testid="row-readme.md"]`)).toBe(true);
  expect(await page.isVisible(`[data-testid="row-folder"]`)).toBe(true);
  // permissions column shows rwx string
  const permText = await page.textContent(`[data-testid="row-readme.md"]`);
  expect(permText).toMatch(/-rw/);
  // hidden file not shown by default
  expect(await page.isVisible(`[data-testid="row-.secret"]`)).toBe(false);
});

test("files: hidden toggle reveals dotfiles", async () => {
  await gotoFiles(play);
  await page.check('[data-testid="toggle-hidden"]');
  await page.waitForSelector('[data-testid="row-.secret"]');
  expect(await page.isVisible('[data-testid="row-.secret"]')).toBe(true);
});

test("files: navigate into folder by double-click and back via breadcrumb", async () => {
  await gotoFiles(play);
  await page.dblclick('[data-testid="row-folder"]');
  await page.waitForSelector('[data-testid="row-inside.txt"]');
  const crumb = play.split("/").pop()!;
  await page.click(`[data-testid="breadcrumbs"] >> text="${crumb}"`);
  await page.waitForSelector('[data-testid="row-readme.md"]');
});

test("files: create new folder", async () => {
  await gotoFiles(play);
  await page.click('[data-testid="new-folder"]');
  await page.fill('input[value="untitled folder"]', "made-by-e2e");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="row-made-by-e2e"]');
  expect(statSync(join(play, "made-by-e2e")).isDirectory()).toBe(true);
});

test("files: create file, edit in CodeMirror, save with keyboard", async () => {
  await gotoFiles(play);
  await page.click('[data-testid="new-file"]');
  await page.fill('input[value="untitled.txt"]', "note.md");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="row-note.md"]');

  await page.dblclick('[data-testid="row-note.md"]');
  await page.waitForSelector(".cm-content");
  await page.click(".cm-content");
  await page.keyboard.type("# hello from e2e");
  await page.keyboard.press("ControlOrMeta+s");
  await waitFor(() => existsSync(join(play, "note.md")) && readFileSync(join(play, "note.md"), "utf8").includes("hello from e2e"));
  expect(readFileSync(join(play, "note.md"), "utf8")).toContain("# hello from e2e");
});

test("files: rename via context menu", async () => {
  await gotoFiles(play);
  await rowMenu("note.md", "Rename…");
  await page.fill('input[value="note.md"]', "renamed.md");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="row-renamed.md"]');
  expect(existsSync(join(play, "renamed.md"))).toBe(true);
  expect(existsSync(join(play, "note.md"))).toBe(false);
});

test("files: copy + paste into folder via context menu", async () => {
  await gotoFiles(play);
  await rowMenu("renamed.md", "Copy");
  await page.dblclick('[data-testid="row-folder"]');
  await page.waitForSelector('[data-testid="row-inside.txt"]');
  await page.click('[data-testid="paste-btn"]');
  await page.waitForSelector('[data-testid="row-renamed.md"]');
  expect(readFileSync(join(play, "folder", "renamed.md"), "utf8")).toContain("hello from e2e");
  expect(existsSync(join(play, "renamed.md"))).toBe(true); // copy, not move
});

test("files: cut + paste moves", async () => {
  await gotoFiles(play);
  await rowMenu("script.ts", "Cut");
  await page.dblclick('[data-testid="row-made-by-e2e"]');
  await page.waitForSelector("text=Empty folder");
  await page.click('[data-testid="paste-btn"]');
  await page.waitForSelector('[data-testid="row-script.ts"]');
  expect(existsSync(join(play, "made-by-e2e", "script.ts"))).toBe(true);
  expect(existsSync(join(play, "script.ts"))).toBe(false);
});

test("files: chmod via permissions dialog", async () => {
  await gotoFiles(play);
  await rowMenu("readme.md", "Permissions…");
  await page.waitForSelector("text=Owner");
  // uncheck all "write" bits -> 444; grid rows are Owner/Group/Others
  for (const row of ["Owner", "Group", "Others"]) {
    const checkbox = page.locator(`tr:has-text("${row}") input`).nth(1); // read, WRITE, execute
    if (await checkbox.isChecked()) await checkbox.uncheck();
  }
  await page.click("text=Apply");
  await waitFor(() => (statSync(join(play, "readme.md")).mode & 0o777) === 0o444);
  expect(statSync(join(play, "readme.md")).mode & 0o777).toBe(0o444);
  // restore
  await fetch(`${BASE}/api/fs/chmod?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: join(play, "readme.md"), mode: "644" }),
  });
});

test("files: create symlink via context menu, badge visible", async () => {
  await gotoFiles(play);
  await rowMenu("readme.md", "New symlink to this…");
  await page.keyboard.press("Enter"); // accept default "readme.md-link"
  await page.waitForSelector('[data-testid="row-readme.md-link"]');
  expect(lstatSync(join(play, "readme.md-link")).isSymbolicLink()).toBe(true);
  const rowText = await page.textContent('[data-testid="row-readme.md-link"]');
  expect(rowText).toContain("→"); // symlink target arrow
});

test("files: create hard link, nlink badge appears", async () => {
  await gotoFiles(play);
  await rowMenu("readme.md", "New hard link to this…");
  await page.fill('input[value="readme.md-link"]', "readme-hard.md");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="row-readme-hard.md"]');
  await waitFor(async () => (await page.textContent('[data-testid="files-table"]'))?.includes("⧉ 2") ?? false);
  expect(statSync(join(play, "readme.md")).nlink).toBe(2);
});

test("files: upload via file input", async () => {
  await gotoFiles(play);
  const tmpFile = join(tmpdir(), "e2e-upload.txt");
  writeFileSync(tmpFile, "uploaded via e2e");
  await page.setInputFiles('[data-testid="upload-input"]', tmpFile);
  await page.waitForSelector('[data-testid="row-e2e-upload.txt"]');
  expect(readFileSync(join(play, "e2e-upload.txt"), "utf8")).toBe("uploaded via e2e");
});

test("files: drop upload path (synthetic DataTransfer)", async () => {
  await gotoFiles(play);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["dropped body"], "dropped.txt", { type: "text/plain" }));
    const target = document.querySelector('[data-testid="files-view"]')!;
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForSelector('[data-testid="row-dropped.txt"]');
  expect(readFileSync(join(play, "dropped.txt"), "utf8")).toBe("dropped body");
});

test("files: delete permanently via context menu", async () => {
  await gotoFiles(play);
  await rowMenu("e2e-upload.txt", "Delete permanently");
  await waitFor(() => !existsSync(join(play, "e2e-upload.txt")));
  expect(existsSync(join(play, "e2e-upload.txt"))).toBe(false);
});

test("files: deep search finds nested file", async () => {
  await gotoFiles(play);
  await page.fill('[data-testid="files-filter"]', "inside");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=result");
  expect(await page.textContent("main")).toContain("inside.txt");
});

test("terminal: runs shell commands end-to-end", async () => {
  await page.goto(`${BASE}/#/term?cwd=${encodeURIComponent(play)}`);
  await page.getByTestId("term-new-form").waitFor();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForSelector("text=live");
  await page.click('[data-testid="terminal-host"]');
  await page.keyboard.type("echo e2e_$((6*7))");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await page.textContent('[data-testid="terminal-host"]'))?.includes("e2e_42") ?? false);
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await waitFor(async () => {
    const text = await page.textContent('[data-testid="terminal-host"]');
    return text?.includes(play.split("/").pop()!) ?? false;
  });
  // the deep link became a durable session: the URL now names it
  expect(page.url()).toMatch(/#\/term\?session=[0-9a-f]{8}/);
}, 30000);

test("sessions survive leaving the view and reload; the strip leads back in", async () => {
  const url = page.url();
  const id = url.match(/session=([0-9a-f]{8})/)![1];
  await page.goto(`${BASE}/#/fleet`);
  await page.waitForSelector('[data-testid="session-chip"]');
  // output produced while nobody is attached is replayed on return
  const res = await fetch(`${BASE}/api/sessions/${id}/input`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ data: "echo while_away_$((3*3))", enter: true }) });
  expect(res.ok).toBe(true);
  await page.click('[data-testid="session-chip"]');
  await page.waitForSelector("text=live");
  await waitFor(async () => (await page.textContent('[data-testid="terminal-host"]'))?.includes("while_away_9") ?? false);
  expect(page.url()).toContain(`session=${id}`);
  await page.reload();
  await page.waitForSelector("text=live");
  await waitFor(async () => (await page.textContent('[data-testid="terminal-host"]'))?.includes("e2e_42") ?? false);
}, 30000);

test("prompt bar: plans a harness from the text and starts a session from any view", async () => {
  await page.goto(`${BASE}/#/files?path=${encodeURIComponent(play)}`);
  await page.waitForSelector('[data-testid="files-table"]');
  await page.fill('[data-testid="prompt-input"]', "cx: look at this");
  await page.waitForSelector('[data-testid="plan-chips"]');
  expect(await page.textContent('[data-testid="plan-tool"]')).toContain("cx");
  expect(await page.textContent('[data-testid="plan-reasons"]')).toContain("prefix");
  // the Files view's directory is the proposed working directory
  expect(await page.textContent('[data-testid="plan-cwd"]')).toContain(play.split("/").pop()!);
  // click the tool chip to cycle: cx -> shell (pinned)
  await page.click('[data-testid="plan-tool"]');
  expect(await page.textContent('[data-testid="plan-tool"]')).toContain("shell");
  expect(await page.textContent('[data-testid="plan-chips"]')).toContain("pinned");
  // a $ command needs no agent: Enter starts it and lands in its terminal
  await page.fill('[data-testid="prompt-input"]', "$ echo from_bar_$((5*5)) && pwd");
  await page.press('[data-testid="prompt-input"]', "Enter");
  await page.waitForSelector("text=live");
  await waitFor(async () => (await page.textContent('[data-testid="terminal-host"]'))?.includes("from_bar_25") ?? false);
  expect(page.url()).toMatch(/#\/term\?session=/);
  // it ran in the Files directory and shows up as a tab and a live chip
  await waitFor(async () => (await page.textContent('[data-testid="terminal-host"]'))?.includes(play.split("/").pop()!) ?? false);
  expect((await page.$$('[data-testid="term-tab"]')).length).toBeGreaterThanOrEqual(1);
  expect(await page.textContent('[data-testid="session-strip"]')).toContain("sh echo from_bar");
  // background start (meta+Enter) keeps you where you are
  await page.fill('[data-testid="prompt-input"]', "$ sleep 30");
  await page.press('[data-testid="prompt-input"]', "Meta+Enter");
  await waitFor(async () => ((await page.textContent('[data-testid="prompt-note"]').catch(() => "")) ?? "").includes("started sh sleep 30"));
  expect(page.url()).toContain("session=");
  // kill it from the tab bar (dialogs auto-accept)
  await page.waitForSelector('[data-testid="term-tab"]:has-text("sleep 30")');
  const before = (await page.$$('[data-testid="term-tab"]')).length;
  await page.click(`[data-testid="term-tab"]:has-text("sleep 30") >> text=×`);
  await waitFor(async () => (await page.$$('[data-testid="term-tab"]')).length === before - 1);
}, 45000);

/** A running shell session on the local daemon (whatever earlier tests left behind). */
const ensureLocalSession = async () => {
  const list = await (await fetch(`${BASE}/api/sessions?token=${TOKEN}`)).json();
  if (list.sessions.some((x: { state: string }) => x.state === "running")) return;
  const res = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ cmd: "sleep 300", title: "local keepalive", runner: "pty" }) });
  expect(res.ok).toBe(true);
};

// ---- fleet: pair a second daemon through the UI, then browse it remotely ----
let daemon2: Subprocess | undefined;
let home2: string | undefined;

test("fleet: pair a second node via the UI and browse it", async () => {
  home2 = mkdtempSync(join(tmpdir(), "cyberdeck-e2e-home2-"));
  writeFileSync(join(home2, "token"), "e2e-token-two");
  writeFileSync(join(home2, "node-id"), "stw-e2e-two");
  writeFileSync(
    join(home2, "config.json"),
    // the peer is the one with the Deck checkout (the stub CLI, presenting itself as host "second-box"); this node has none
    JSON.stringify({ nodeName: "second-box", port: 4796, bind: "127.0.0.1", roots: [], dataRoots: [], watch: false, autoUpdate: false, junkDirs: [], skipDirs: [], scanDepth: 1, fleetDir: join(ROOT, "tests", "fixtures", "fleet") })
  );
  daemon2 = Bun.spawn(["bun", "run", join(ROOT, "src/daemon/main.ts")], {
    env: { ...process.env, CYBERDECK_HOME: home2, CYBERDECK_SESSIONS_TMUX: "0", CYBERDECK_USAGE_NET: "0", DECK_STUB_HOST: "second-box" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(async () => {
    try {
      return (await fetch("http://127.0.0.1:4796/api/status?token=e2e-token-two")).ok;
    } catch {
      return false;
    }
  });

  // get a pairing code from the second daemon (as its UI would)
  const { code } = await (
    await fetch("http://127.0.0.1:4796/api/fleet/pairing/start", {
      method: "POST",
      headers: { authorization: "Bearer e2e-token-two" },
    })
  ).json();

  await page.goto(`${BASE}/#/fleet`);
  await page.waitForSelector('[data-testid="pair-url"]');
  await page.fill('[data-testid="pair-url"]', "http://127.0.0.1:4796");
  await page.fill('[data-testid="pair-code"]', code);
  await page.click('[data-testid="pair-submit"]');
  await page.waitForSelector('[data-testid="pair-msg"]');
  expect(await page.textContent('[data-testid="pair-msg"]')).toContain("Paired with second-box");

  // the peer card appears and reports online
  await page.waitForSelector("text=second-box");

  // there is no page-wide node switcher any more: a machine is named by the view's own URL
  expect(await page.$('[data-testid="node-switcher"]')).toBeNull();
  await gotoFiles(play, "stw-e2e-two");
  await page.getByTestId("row-readme.md").waitFor().catch(async error => { console.log("Peer navigation diagnostic", page.url(), await page.locator("main").innerText()); throw error; });
  expect(await page.isVisible('[data-testid="row-readme.md"]')).toBe(true);
  // the Files picker shows which machine this listing is from; the status bar still names the serving node
  expect(await page.inputValue('[data-testid="files-node"]')).toBe("stw-e2e-two");
  expect(await page.textContent('[data-testid="statusbar-node"]')).toContain("e2e-node");
  expect(await page.title()).toContain("second-box");
  // links carry the machine: a terminal opened from here is offered on second-box, not this node
  // (the link prefills the form; Open starts it)
  await page.click("text=▚ Shell");
  await page.waitForSelector('[data-testid="term-new-form"]');
  expect(await page.inputValue('[data-testid="term-new-node"]')).toBe("stw-e2e-two");
  await page.click('[data-testid="term-new-open"]');
  await page.waitForSelector("text=live");
  expect(page.url()).toContain("node=stw-e2e-two");
  await waitFor(async () => (await page.textContent('[data-testid="term-status"]'))?.includes("second-box") ?? false);
  const remote = page.url().match(/session=([0-9a-f]{8})/)![1];
  const two = await (await fetch(`http://127.0.0.1:4796/api/sessions?token=e2e-token-two`)).json();
  expect(two.sessions.map((x: { id: string }) => x.id)).toContain(remote);
  // Sessions lists both machines' sessions in one strip, each tagged with its host; the strip chip too
  // (a local session is started here so the test does not depend on earlier ones)
  await ensureLocalSession();
  await waitFor(async () => (await page.$$('[data-testid="term-tab"][data-node=""]')).length >= 1);
  expect(await page.textContent(`[data-testid="term-tab"][data-session="${remote}"]`)).toContain("second-box");
  await waitFor(async () => ((await page.textContent('[data-testid="session-strip"]')) ?? "").includes("second-box"));
  // the picker in the strip narrows to one machine without changing the URL's session
  await page.selectOption('[data-testid="term-filter-node"]', "");
  await waitFor(async () => (await page.$$('[data-testid="term-tab"][data-node="stw-e2e-two"]')).length === 0);
  expect((await page.$$('[data-testid="term-tab"][data-node=""]')).length).toBeGreaterThanOrEqual(1);
  expect(page.url()).toContain(`session=${remote}`);
  await page.selectOption('[data-testid="term-filter-node"]', "*");
  // switching the Files picker back to this machine drops the node from the URL
  await gotoFiles(play, "stw-e2e-two");
  await page.selectOption('[data-testid="files-node"]', "");
  await waitFor(async () => !page.url().includes("node="));
  await page.waitForSelector('[data-testid="files-table"]');
  // Data asks every machine and names each one; second-box answered
  await page.goto(`${BASE}/#/data`);
  await page.waitForSelector('[data-testid="node-health-second-box"]');
  await waitFor(async () => (await page.getAttribute('[data-testid="node-health-second-box"]', "data-state")) === "ok");
  expect(await page.textContent("main")).toContain("2 machines");
  // the Fleet page's "this machine" card still describes the local node (one repo after this
  // scan), not the remote node (no roots, 0 repos)
  mkdirSync(join(play, "repo-one"));
  Bun.spawnSync(["git", "init", "-q", join(play, "repo-one")]);
  await fetch(`${BASE}/api/scan`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
  await waitFor(async () => ((await (await fetch(`${BASE}/api/status?token=${TOKEN}`)).json()).repos ?? 0) >= 1);
  await page.goto(`${BASE}/#/fleet`);
  await page.waitForSelector('[data-testid="self-card"]');
  await waitFor(async () => /(?<!\d)1\s*repos/.test((await page.textContent('[data-testid="self-card"]')) ?? ""));
  expect(await page.textContent('[data-testid="self-card"]')).toContain("this machine");
  // ...while the fleet-wide widgets list both machines, each under its own name
  await waitFor(async () => (await page.textContent('[data-testid="system-second-box"]'))?.includes("memory") ?? false, 20000);
  const storage = (await page.textContent('[data-testid="widget-storage"]')) ?? "";
  expect(storage).toContain("e2e-node");
  expect(storage).toContain("2 machines");
  expect(await page.textContent('[data-testid="system-second-box"]')).toContain("memory");
  expect(await page.textContent('[data-testid="system-e2e-node"]')).toContain("this machine");
  // a machine card's buttons link to that machine's view
  await page.click('[data-testid="node-card-second-box"] [data-testid="card-files"]');
  await waitFor(async () => page.url().includes("node=stw-e2e-two"));
  await page.waitForSelector('[data-testid="files-table"]');
  expect(await page.inputValue('[data-testid="files-node"]')).toBe("stw-e2e-two");
}, 60000);

const PEER = "stw-e2e-two";
const peerSessions = async () => (await (await fetch(`http://127.0.0.1:4796/api/sessions?token=e2e-token-two`)).json()).sessions as { id: string; cwd: string }[];
const localSessions = async () => (await (await fetch(`${BASE}/api/sessions?token=${TOKEN}`)).json()).sessions as { id: string; cwd: string }[];

test("fleet: Deck read from a peer: Projects, Services and Agents render, and the peer's host actions run on the peer, not here", async () => {
  // this node has no fleetDir: the views take the Deck overview from second-box and say so
  await page.goto(`${BASE}/#/projects`);
  await page.waitForSelector('[data-testid="overview-source"]');
  expect(await page.textContent('[data-testid="overview-source"]')).toContain("second-box");
  expect((await page.$$('[data-testid="project-demo"]')).length).toBe(1);
  // the peer's Deck says host "second-box" is where the project lives; that chip is the peer, not this node
  expect(await page.isVisible('[data-testid="host-chip-second-box"]')).toBe(true);
  // unassigned repos are host-bound: this node's repo-one, tagged with this node's name
  await page.goto(`${BASE}/#/projects?p=_repos`);
  await page.waitForSelector('[data-testid="unassigned-row"]');
  const unassigned = (await page.textContent('[data-testid="unassigned-row"]')) ?? "";
  expect(unassigned).toContain("repo-one");
  expect(unassigned).toContain("e2e-node");

  // Services: the host panel for the Deck host offers a shell ON THAT NODE ("here" is still e2e-node)
  await page.goto(`${BASE}/#/services`);
  await page.waitForSelector('[data-testid="host-panel-second-box"]');
  expect(await page.textContent('[data-testid="overview-source"]')).toContain("second-box");
  expect(await page.getAttribute('[data-testid="host-shell-second-box"]', "data-route")).toBe("node");
  expect(await page.textContent('[data-testid="host-shell-second-box"]')).toContain("second-box");
  const localBefore = (await localSessions()).length;
  const peerBefore = (await peerSessions()).length;
  await page.click('[data-testid="host-shell-second-box"]');
  await waitFor(async () => page.url().includes(`node=${PEER}`));
  await page.waitForSelector("text=live");
  await waitFor(async () => (await peerSessions()).length === peerBefore + 1);
  expect((await localSessions()).length).toBe(localBefore);
  expect(await page.textContent('[data-testid="term-status"]')).toContain("second-box");

  // Agents: renders from the peer's Deck too (no "No fleet dir" error); its indexed session resumes on second-box,
  // its open task runs on second-box (the host it names), and the launch form offers this machine first
  await page.goto(`${BASE}/#/agents`);
  await page.waitForSelector('[data-testid="overview-source"]');
  expect(await page.textContent('[data-testid="overview-source"]')).toContain("second-box");
  await page.waitForSelector('[data-testid="session-resume"]');
  expect(await page.textContent('[data-testid="session-resume"]')).toBe("Resume on second-box");
  expect(await page.textContent('[data-testid="launch-node"] option[value=""]')).toContain("e2e-node");
  expect(await page.textContent('[data-testid="task-run-t1"]')).toBe("Run on second-box");
  expect(await page.textContent('[data-testid="collab-tick"]')).toContain("second-box");
}, 60000);

test("fleet: Projects stays one canonical list when this node has the Deck checkout too", async () => {
  // give this node the same Deck the peer has (the real proxied answer), without a second fleetDir
  const ov = await (await fetch(`${BASE}/api/nodes/${PEER}/proxy/control/overview?token=${TOKEN}`)).json();
  await page.route("**/api/control/overview", (r) => r.fulfill({ json: ov }));
  try {
    await page.goto(`${BASE}/?fresh=${Date.now()}#/projects?p=demo`);
    await page.waitForSelector('[data-testid="project-demo"]');
    await page.waitForSelector('[data-testid="node-health-second-box"]');
    expect((await page.$$('[data-testid="project-demo"]')).length).toBe(1);
    // read locally now: no "Deck read from" note, and the project chip for second-box is still the peer
    expect(await page.$('[data-testid="overview-source"]')).toBeNull();
    expect(await page.textContent('[data-testid="project-tree"]')).toContain("Demo");
  } finally {
    await page.unroute("**/api/control/overview");
  }
}, 30000);

test("sessions: a cwd link prefills the New session form on the named machine and starts nothing until Open", async () => {
  const before = (await peerSessions()).length;
  await page.goto(`${BASE}/#/term?cwd=${encodeURIComponent(play)}&node=${PEER}`);
  await page.waitForSelector('[data-testid="term-new-form"]');
  expect(await page.inputValue('[data-testid="term-new-node"]')).toBe(PEER);
  expect(await page.inputValue('[data-testid="term-new-form"] input[list="cwd-options"]')).toBe(play);
  await new Promise((r) => setTimeout(r, 1200));
  expect((await peerSessions()).length).toBe(before);
  expect(page.url()).toContain("cwd=");
  await page.click('[data-testid="term-new-open"]');
  await waitFor(async () => (await peerSessions()).length === before + 1);
  await waitFor(async () => page.url().includes("session=") && page.url().includes(`node=${PEER}`) && !page.url().includes("cwd="));
  expect((await peerSessions()).some((x) => x.cwd === play)).toBe(true);
  await page.waitForSelector("text=live");
}, 30000);

test("fleet: cmux surfaces from every machine in one tree, and input goes to the machine that owns the surface", async () => {
  const surface = (ref: string, title: string) => ({ kind: "surface", ref, title, type: "terminal", selected: true, focused: true, current: true, active: true, children: [] });
  const tree = (name: string) => ({ available: true, running: true, current: "ws1", tree: [{ kind: "window", ref: "w1", selected: true, focused: true, current: true, active: true, children: [{ kind: "workspace", ref: "ws1", title: name, selected: true, focused: true, current: true, active: true, children: [surface("s1", `${name} shell`)] }] }] });
  const sent: string[] = [];
  await page.route("**/api/cmux/tree", (r) => r.fulfill({ json: { available: false, error: "cmux is not installed on this node" } }));
  await page.route(`**/api/nodes/${PEER}/proxy/cmux/tree`, (r) => r.fulfill({ json: tree("peer") }));
  await page.route(`**/api/nodes/${PEER}/proxy/cmux/screen*`, (r) => r.fulfill({ json: { text: "peer screen" } }));
  await page.route(`**/api/nodes/${PEER}/proxy/cmux/send`, (r) => { sent.push(`peer:${JSON.parse(r.request().postData() ?? "{}").text}`); r.fulfill({ json: { ok: true } }); });
  await page.route("**/api/cmux/send", (r) => { sent.push(`local:${JSON.parse(r.request().postData() ?? "{}").text}`); r.fulfill({ json: { ok: true } }); });
  try {
    await page.goto(`${BASE}/#/cmux`);
    await page.waitForSelector('[data-testid="cmux-host-second-box"]');
    await waitFor(async () => page.url().includes("surface=s1") && page.url().includes(`node=${PEER}`));
    expect(await page.textContent('[data-testid="cmux-idle"]')).toContain("e2e-node");
    await waitFor(async () => ((await page.textContent('[data-testid="cmux-screen"]')) ?? "").includes("peer screen"));
    await page.fill('[data-testid="cmux-input"]', "echo hi");
    await page.press('[data-testid="cmux-input"]', "Enter");
    await waitFor(async () => sent.length > 0);
    expect(sent).toEqual(["peer:echo hi"]);
    expect(await page.textContent('[data-testid="cmux-msg"]')).toContain("second-box");
  } finally {
    await page.unroute("**/api/cmux/tree");
    await page.unroute(`**/api/nodes/${PEER}/proxy/cmux/tree`);
    await page.unroute(`**/api/nodes/${PEER}/proxy/cmux/screen*`);
    await page.unroute(`**/api/nodes/${PEER}/proxy/cmux/send`);
    await page.unroute("**/api/cmux/send");
  }
}, 30000);

test("fleet: a dead peer keeps its last sessions on screen and is reported, this node's view keeps working", async () => {
  await ensureLocalSession();
  await page.goto(`${BASE}/#/term`);
  await waitFor(async () => (await page.$$('[data-testid="term-tab"][data-node="stw-e2e-two"]')).length >= 1);
  daemon2!.kill();
  await waitFor(async () => ((await page.textContent('[data-testid="term-node-errors"]').catch(() => "")) ?? "").includes("second-box"), 30000);
  // its sessions are still listed (last known), this node's are still live and usable
  expect((await page.$$('[data-testid="term-tab"][data-node="stw-e2e-two"]')).length).toBeGreaterThanOrEqual(1);
  expect((await page.$$('[data-testid="term-tab"][data-node=""]')).length).toBeGreaterThanOrEqual(1);
  await page.click('[data-testid="term-tab"][data-node=""] >> button');
  await page.waitForSelector("text=live");
  // Files on the dead peer fails in its own view with the machine named; local Files is unaffected
  await page.goto(`${BASE}/#/files?path=${encodeURIComponent(play)}&node=stw-e2e-two`);
  await waitFor(async () => ((await page.textContent("main")) ?? "").toLowerCase().includes("second-box") || ((await page.textContent("main")) ?? "").includes("502"), 20000);
  await gotoFiles(play);
  expect(await page.isVisible('[data-testid="row-readme.md"]')).toBe(true);
}, 60000);

test("media player: playlist, transport, track switching", async () => {
  mkdirSync(join(play, "music"), { recursive: true });
  writeFileSync(join(play, "music", "01-first.mp3"), "not-really-audio");
  writeFileSync(join(play, "music", "02-second.mp3"), "not-really-audio");
  await page.goto(`${BASE}/#/edit?path=${encodeURIComponent(join(play, "music", "01-first.mp3"))}`);
  await page.waitForSelector('[data-testid="media-player"]');
  await page.waitForSelector('[data-testid="media-playlist"]');
  expect(await page.textContent('[data-testid="media-playlist"]')).toContain("02-second.mp3");
  expect(await page.isVisible('[data-testid="media-transport"]')).toBe(true);
  await page.click('[data-testid="media-playlist"] >> text=02-second.mp3');
  await waitFor(async () => (await page.textContent("main"))?.includes("2 of 2") ?? false);
});

test("video: direct playback with working seek (webm)", async () => {
  const ffmpeg = Bun.which("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg";
  const src = join(play, "clip.webm");
  const gen = Bun.spawn(
    [ffmpeg, "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=15", "-c:v", "libvpx-vp9", "-b:v", "200k", src],
    { stdout: "ignore", stderr: "ignore" }
  );
  expect(await gen.exited).toBe(0);
  await page.goto(`${BASE}/#/edit?path=${encodeURIComponent(src)}`);
  await page.waitForSelector('[data-testid="videojs-host"] video');
  const video = '[data-testid="videojs-host"] video';
  await waitFor(async () => (await page.$eval(video, (v: any) => v.currentTime)) > 0.3);
  // seek forward: only possible because /api/fs/read honors Range requests
  await page.$eval(video, (v: any) => (v.currentTime = 3.0));
  await waitFor(async () => (await page.$eval(video, (v: any) => v.currentTime)) >= 3.0);
  expect(await page.$eval(video, (v: any) => v.seekable.length)).toBeGreaterThan(0);
}, 30000);

test("video: non-native format transcodes to HLS via video.js", async () => {
  const ffmpeg = Bun.which("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg";
  const src = join(play, "movie.mkv");
  const gen = Bun.spawn(
    [ffmpeg, "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=15", src],
    { stdout: "ignore", stderr: "ignore" }
  );
  expect(await gen.exited).toBe(0);
  const playlistResponse = page.waitForResponse((r) => r.url().includes("/api/media/hls/") && r.url().endsWith("index.m3u8"), { timeout: 20000 });
  await page.goto(`${BASE}/#/edit?path=${encodeURIComponent(src)}`);
  await page.waitForSelector('[data-testid="videojs-host"] video');
  expect((await playlistResponse).status()).toBe(200);
  await waitFor(async () => ((await page.textContent('[data-testid="video-status"]')) ?? "").toLowerCase().includes("transcod") || ((await page.textContent('[data-testid="video-status"]')) ?? "").includes("HLS"));
}, 30000);

test("mobile: dialogs fit the viewport, editor and player usable", async () => {
  // Keep the mobile case runnable without the earlier desktop playlist test.
  mkdirSync(join(play, "music"), { recursive: true });
  writeFileSync(join(play, "music", "01-first.mp3"), "not-really-audio");
  writeFileSync(join(play, "music", "02-second.mp3"), "not-really-audio");
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.goto(`${BASE}/#t=${TOKEN}`);
  await phone.waitForSelector('[data-testid="mnav-files"]');
  await phone.goto(`${BASE}/#/files?path=${encodeURIComponent(play)}`);
  await phone.waitForSelector('[data-testid="row-readme.md"]');
  // dialog fits on a 390px screen
  await phone.click('[data-testid="new-folder"]');
  const box = await (await phone.waitForSelector('input[value="untitled folder"]'))!.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await phone.keyboard.press("Escape");
  await phone.mouse.click(10, 400); // dismiss
  // editor opens and header wraps without horizontal scroll
  await phone.goto(`${BASE}/#/edit?path=${encodeURIComponent(join(play, "readme.md"))}`);
  await phone.waitForSelector(".cm-content");
  const scrollW = await phone.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW).toBeLessThanOrEqual(392);
  // audio player stacks playlist below on mobile
  await phone.goto(`${BASE}/#/edit?path=${encodeURIComponent(join(play, "music", "01-first.mp3"))}`);
  await phone.waitForSelector('[data-testid="media-player"]');
  await phone.waitForSelector('[data-testid="media-playlist"]');
  expect(await phone.isVisible('[data-testid="media-playlist"]')).toBe(true);
  await phone.close();
}, 30000);

test("mobile: bottom nav, compact files table, no tree", async () => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.goto(`${BASE}/#t=${TOKEN}`);
  await phone.waitForSelector('[data-testid="mnav-files"]');
  expect(await phone.isVisible('[data-testid="mnav-term"]')).toBe(true);
  expect(await phone.isVisible('[data-testid="nav-files"]')).toBe(false); // activity bar hidden

  await phone.goto(`${BASE}/#/files?path=${encodeURIComponent(play)}`);
  await phone.waitForSelector('[data-testid="row-readme.md"]');
  expect(await phone.isVisible('[data-testid="file-tree"]')).toBe(false);
  // permissions column is hidden on phones, name still visible
  expect(await phone.isVisible('[data-testid="rowmenu-readme.md"]')).toBe(true);
  // row menu button opens the context menu (touch affordance)
  await phone.click('[data-testid="rowmenu-readme.md"]');
  await phone.waitForSelector('[data-testid="context-menu"]');
  expect(await phone.textContent('[data-testid="context-menu"]')).toContain("Get info");
  await phone.close();
});

test("auth: wrong token is locked out", async () => {
  const p2 = await browser.newPage();
  await p2.goto(`${BASE}/#t=wrong-token`);
  await p2.waitForSelector("text=Cyberdeck is locked");
  await p2.close();
});
