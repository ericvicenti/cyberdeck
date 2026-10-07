// Remote browser: one persistent headless Chromium per "profile" (cookies and
// logins survive restarts under ~/.cyberdeck/browser/<profile>), streamed to the
// dashboard as a CDP screencast with pointer/keyboard forwarded back. Generic:
// the Cloud AI archive drives logged-in chatgpt/claude profiles through it, and
// the UI can use it to log into anything from any device.
import { mkdirSync, existsSync, readdirSync, chmodSync } from "fs";
import { join } from "path";
import { CYBERDECK_HOME } from "./config";

export const BROWSER_HOME = join(CYBERDECK_HOME, "browser");
export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_PROFILES = ["default", "chatgpt", "claude"] as const;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

type PW = typeof import("playwright");
type BrowserContext = import("playwright").BrowserContext;
type Page = import("playwright").Page;
type CDPSession = import("playwright").CDPSession;

export type Profile = { name: string; context: BrowserContext; page: Page; dir: string; openedAt: number };
export type BrowserState = { url: string; title: string; loading: boolean };

/** Browser-originated input messages (validated before they touch CDP). */
export type InputMsg =
  | { t: "mouse"; type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button?: "left" | "right" | "middle" | "none"; clickCount?: number; modifiers?: number }
  | { t: "key"; type: "keyDown" | "keyUp" | "char" | "rawKeyDown"; key?: string; code?: string; text?: string; modifiers?: number; windowsVirtualKeyCode?: number }
  | { t: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { t: "nav"; url: string }
  | { t: "back" }
  | { t: "forward" }
  | { t: "reload" }
  | { t: "resize"; w: number; h: number };

const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
export function validateInput(raw: unknown): InputMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case "mouse": {
      if (!["mousePressed", "mouseReleased", "mouseMoved"].includes(String(m.type))) return null;
      if (!num(m.x, 0, 8192) || !num(m.y, 0, 8192)) return null;
      const button = m.button === undefined ? undefined : (["left", "right", "middle", "none"].includes(String(m.button)) ? (m.button as any) : null);
      if (button === null) return null;
      const clickCount = m.clickCount === undefined ? undefined : num(m.clickCount, 0, 3) ? (m.clickCount as number) : null;
      if (clickCount === null) return null;
      const modifiers = m.modifiers === undefined ? undefined : num(m.modifiers, 0, 15) ? (m.modifiers as number) : null;
      if (modifiers === null) return null;
      return { t: "mouse", type: m.type as any, x: m.x as number, y: m.y as number, button, clickCount, modifiers };
    }
    case "key": {
      if (!["keyDown", "keyUp", "char", "rawKeyDown"].includes(String(m.type))) return null;
      const str = (k: string, max: number) => (m[k] === undefined ? undefined : typeof m[k] === "string" && (m[k] as string).length <= max ? (m[k] as string) : null);
      const key = str("key", 32), code = str("code", 32), text = str("text", 16);
      if (key === null || code === null || text === null) return null;
      const modifiers = m.modifiers === undefined ? undefined : num(m.modifiers, 0, 15) ? (m.modifiers as number) : null;
      if (modifiers === null) return null;
      const vk = m.windowsVirtualKeyCode === undefined ? undefined : num(m.windowsVirtualKeyCode, 0, 255) ? (m.windowsVirtualKeyCode as number) : null;
      if (vk === null) return null;
      return { t: "key", type: m.type as any, key, code, text, modifiers, windowsVirtualKeyCode: vk };
    }
    case "wheel":
      if (!num(m.x, 0, 8192) || !num(m.y, 0, 8192) || !num(m.deltaX, -5000, 5000) || !num(m.deltaY, -5000, 5000)) return null;
      return { t: "wheel", x: m.x as number, y: m.y as number, deltaX: m.deltaX as number, deltaY: m.deltaY as number };
    case "nav": {
      if (typeof m.url !== "string" || m.url.length > 2048) return null;
      const url = normalizeUrl(m.url);
      return url ? { t: "nav", url } : null;
    }
    case "back": return { t: "back" };
    case "forward": return { t: "forward" };
    case "reload": return { t: "reload" };
    case "resize":
      if (!num(m.w, 320, 1920) || !num(m.h, 240, 1400)) return null;
      return { t: "resize", w: Math.round(m.w as number), h: Math.round(m.h as number) };
    default: return null;
  }
}

/** Only http(s); a bare host becomes https://host. */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try { const u = new URL(withScheme); if (u.protocol !== "http:" && u.protocol !== "https:") return null; return u.toString(); } catch { return null; }
}

export class BrowserManager {
  private pw: PW | null = null;
  private pwError: string | null = null;
  private profiles = new Map<string, Profile>();
  private opening = new Map<string, Promise<Profile>>();

  constructor(private home = BROWSER_HOME) {}

  async available(): Promise<{ available: boolean; reason?: string }> {
    try { await this.playwright(); return { available: true }; } catch (e) { return { available: false, reason: this.pwError ?? String(e) }; }
  }

  private async playwright(): Promise<PW> {
    if (this.pw) return this.pw;
    if (this.pwError) throw new Error(this.pwError);
    try { this.pw = await import("playwright"); return this.pw; } catch (e) { this.pwError = `playwright is not installed: ${e instanceof Error ? e.message : e}`; throw new Error(this.pwError); }
  }

  /** Profiles on disk plus the built-in names, with live state when open. */
  listProfiles(): { name: string; open: boolean; exists: boolean; url?: string }[] {
    const names = new Set<string>(DEFAULT_PROFILES);
    try { for (const d of readdirSync(this.home)) if (PROFILE_RE.test(d)) names.add(d); } catch {}
    return [...names].sort().map((name) => {
      const p = this.profiles.get(name);
      return { name, open: Boolean(p), exists: existsSync(join(this.home, name)), url: p?.page.url() };
    });
  }

  isOpen(name: string) { return this.profiles.has(name); }
  profileDir(name: string) { return join(this.home, name); }
  hasProfileOnDisk(name: string) { return existsSync(join(this.home, name)); }

  /** Open (or reuse) the profile's browser. Throws with a readable reason when Chromium cannot start. */
  async get(name: string): Promise<Profile> {
    if (!PROFILE_RE.test(name)) throw new Error("bad profile name");
    const existing = this.profiles.get(name);
    if (existing && !existing.page.isClosed()) return existing;
    const inflight = this.opening.get(name);
    if (inflight) return inflight;
    const task = (async () => {
      const pw = await this.playwright();
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      try { chmodSync(this.home, 0o700); } catch {}
      const dir = join(this.home, name);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      let context: BrowserContext;
      try {
        context = await pw.chromium.launchPersistentContext(dir, {
          headless: true,
          channel: "chromium", // full Chromium in new headless mode (not the headless shell): fewer bot-detection trips on login pages
          viewport: { width: 1280, height: 800 },
          userAgent: UA,
          locale: "en-US",
          args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
          ignoreDefaultArgs: ["--enable-automation"],
        });
      } catch (e) {
        throw new Error(`could not launch Chromium for profile ${name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
      const page = context.pages()[0] ?? (await context.newPage());
      await page.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
      const profile: Profile = { name, context, page, dir, openedAt: Date.now() };
      context.on("close", () => { if (this.profiles.get(name) === profile) this.profiles.delete(name); });
      this.profiles.set(name, profile);
      return profile;
    })();
    this.opening.set(name, task);
    try { return await task; } finally { this.opening.delete(name); }
  }

  async state(name: string): Promise<BrowserState | null> {
    const p = this.profiles.get(name);
    if (!p) return null;
    let title = "";
    try { title = await p.page.title(); } catch {}
    return { url: p.page.url(), title, loading: false };
  }

  async open(name: string, url: string): Promise<BrowserState> {
    const p = await this.get(name);
    await p.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => { console.warn(`browser ${name}: goto ${url}: ${e instanceof Error ? e.message.split("\n")[0] : e}`); });
    return (await this.state(name))!;
  }

  async close(name: string): Promise<boolean> {
    const p = this.profiles.get(name);
    if (!p) return false;
    this.profiles.delete(name);
    try { await p.context.close(); } catch {}
    return true;
  }

  async closeAll(): Promise<void> { for (const name of [...this.profiles.keys()]) await this.close(name); }
}

export const browsers = new BrowserManager();

/** One screencast viewer: frames out as {t:"frame"} JSON, input in as InputMsg JSON. */
export function createBrowserStreamHandlers(mgr: BrowserManager, profileName: string) {
  let cdp: CDPSession | null = null;
  let page: Page | null = null;
  let closed = false;
  let send: (s: string) => void = () => {};
  let close: () => void = () => {};
  const push = (o: unknown) => { if (!closed) try { send(JSON.stringify(o)); } catch {} };
  const pushState = async () => { if (!page) return; let title = ""; try { title = await page.title(); } catch {} push({ t: "state", url: page.url(), title }); };
  const onNav = () => { pushState(); };

  return {
    async onOpen(_ev: unknown, ws: { send: (s: string) => void; close: () => void }) {
      send = (s) => ws.send(s); close = () => ws.close();
      try {
        const profile = await mgr.get(profileName);
        if (closed) return;
        page = profile.page;
        cdp = await profile.context.newCDPSession(page);
        cdp.on("Page.screencastFrame", (ev: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
          push({ t: "frame", data: ev.data, w: ev.metadata.deviceWidth, h: ev.metadata.deviceHeight });
          cdp?.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
        });
        await cdp.send("Page.enable");
        const vp = page.viewportSize() ?? { width: 1280, height: 800 };
        await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
        page.on("framenavigated", onNav);
        page.on("load", onNav);
        await pushState();
      } catch (e) {
        push({ t: "error", message: e instanceof Error ? e.message : String(e) });
        close();
      }
    },
    async onMessage(ev: { data: unknown }) {
      if (!cdp || !page) return;
      let raw: unknown;
      try { raw = JSON.parse(String(ev.data)); } catch { return; }
      const m = validateInput(raw);
      if (!m) { push({ t: "error", message: "rejected input" }); return; }
      try {
        switch (m.t) {
          case "mouse": await cdp.send("Input.dispatchMouseEvent", { type: m.type, x: m.x, y: m.y, button: m.button ?? (m.type === "mouseMoved" ? "none" : "left"), clickCount: m.clickCount ?? (m.type === "mouseMoved" ? 0 : 1), modifiers: m.modifiers ?? 0 }); break;
          case "key": await cdp.send("Input.dispatchKeyEvent", { type: m.type, key: m.key, code: m.code, text: m.text, unmodifiedText: m.text, modifiers: m.modifiers ?? 0, windowsVirtualKeyCode: m.windowsVirtualKeyCode, nativeVirtualKeyCode: m.windowsVirtualKeyCode }); break;
          case "wheel": await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: m.x, y: m.y, deltaX: m.deltaX, deltaY: m.deltaY }); break;
          case "nav": page.goto(m.url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {}); break;
          case "back": page.goBack({ timeout: 20_000 }).catch(() => {}); break;
          case "forward": page.goForward({ timeout: 20_000 }).catch(() => {}); break;
          case "reload": page.reload({ timeout: 45_000 }).catch(() => {}); break;
          case "resize":
            await page.setViewportSize({ width: m.w, height: m.h });
            await cdp.send("Page.stopScreencast").catch(() => {});
            await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: m.w, maxHeight: m.h, everyNthFrame: 1 });
            break;
        }
      } catch (e) { push({ t: "error", message: e instanceof Error ? e.message.split("\n")[0] : String(e) }); }
    },
    async onClose() {
      closed = true;
      try { page?.off("framenavigated", onNav); page?.off("load", onNav); } catch {}
      try { await cdp?.send("Page.stopScreencast"); } catch {}
      try { await cdp?.detach(); } catch {}
      cdp = null; page = null;
    },
  };
}
