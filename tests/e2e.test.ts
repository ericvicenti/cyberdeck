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

const gotoFiles = async (path: string) => {
  await page.goto(`${BASE}/#/files?path=${encodeURIComponent(path)}`);
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
});

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

// ---- fleet: pair a second daemon through the UI, then browse it remotely ----
let daemon2: Subprocess | undefined;
let home2: string | undefined;

test("fleet: pair a second node via the UI and browse it", async () => {
  home2 = mkdtempSync(join(tmpdir(), "cyberdeck-e2e-home2-"));
  writeFileSync(join(home2, "token"), "e2e-token-two");
  writeFileSync(join(home2, "node-id"), "stw-e2e-two");
  writeFileSync(
    join(home2, "config.json"),
    JSON.stringify({ nodeName: "second-box", port: 4796, bind: "127.0.0.1", roots: [], dataRoots: [], watch: false, autoUpdate: false, junkDirs: [], skipDirs: [], scanDepth: 1 , fleetDir: null })
  );
  daemon2 = Bun.spawn(["bun", "run", join(ROOT, "src/daemon/main.ts")], {
    env: { ...process.env, CYBERDECK_HOME: home2, CYBERDECK_SESSIONS_TMUX: "0", CYBERDECK_USAGE_NET: "0" },
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

  // switch the whole UI onto the remote node and browse files through the proxy
  await page.selectOption('[data-testid="node-switcher"]', "stw-e2e-two");
  await gotoFiles(play);
  expect(await page.isVisible('[data-testid="row-readme.md"]')).toBe(true);
  // status bar shows we are remote
  expect(await page.textContent('[data-testid="statusbar-node"]')).toContain("second-box");
  // back to local
  await page.selectOption('[data-testid="node-switcher"]', "");
}, 45000);

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
