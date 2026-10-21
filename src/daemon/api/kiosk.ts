import type { Hono } from "hono";
import type { Browser } from "playwright";
import type { CyberdeckConfig } from "../config";
import { createBrowserStreamHandlers, type Profile } from "../browser";
import { screenMedia, parseMediaCommand, type LibraryItem, type MediaCommand, type MediaState } from "../screenmedia";

/** Playwright errors carry a multi-line call log; the first line is the message worth repeating aloud. */
const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();

/** What a node says about its screen: the media state, or why there is none here. */
export type Kiosk = {
  enabled: boolean;
  /** Run one media command on this node's screen; throws when the screen is unavailable. */
  media: (cmd: MediaCommand) => Promise<MediaState>;
};

// Attach only to the browser supervised by cyberdeck-kiosk.service. The debugging
// endpoint stays on loopback; viewers must pass Cyberdeck/Casework authentication.
export function registerKioskRoutes(app: Hono, cfg: CyberdeckConfig, upgradeWebSocket: any, isAuthed: (c: any) => boolean, opts: { connect?: () => Promise<Browser> } = {}): Kiosk {
  let browser: Browser | undefined;
  let connecting: Promise<Browser> | undefined;
  const connect = opts.connect ?? (() => import("playwright").then(({ chromium }) => chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 8000, noDefaults: true })));
  const manager = { async get(): Promise<Profile> {
    if (!browser?.isConnected()) {
      connecting ??= connect();
      try { browser = await connecting; } finally { connecting = undefined; }
    }
    const context = browser.contexts()[0];
    const page = context?.pages()[0];
    if (!page) throw new Error(`${cfg.nodeName}'s screen is unavailable. Check that its desktop is logged in.`);
    return { name: "kiosk", context, page, dir: "", openedAt: 0 };
  } };
  app.get("/api/kiosk/stream", upgradeWebSocket((c: any) => {
    if (!cfg.kiosk?.enabled || !isAuthed(c)) return { onOpen(_e: unknown, ws: any) { ws.close(1008, "Screen control is unavailable"); } };
    return createBrowserStreamHandlers(manager, "kiosk", { fixedViewport: true });
  }));

  // Afterglow's downloaded titles, read from the application URL this node is configured with.
  const afterglowUrl = () => (cfg.applications ?? []).find((a) => a.id === "afterglow")?.url;
  const library = async (): Promise<LibraryItem[]> => {
    const base = afterglowUrl();
    if (!base) throw new Error("no Afterglow application is configured on this node");
    const res = await fetch(new URL("/api/library", base), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Afterglow answered ${res.status}`);
    const data = (await res.json()) as { items?: LibraryItem[] | null };
    return Array.isArray(data.items) ? data.items : [];
  };
  const media = async (cmd: MediaCommand): Promise<MediaState> => {
    if (!cfg.kiosk?.enabled) throw new Error(`${cfg.nodeName} has no kiosk screen (config kiosk.enabled).`);
    const { page } = await manager.get();
    return screenMedia(page as any, cmd, { library: afterglowUrl() ? library : undefined });
  };

  // One media command on this node's screen (the voice agent's `media` tool and the Casework remote use it).
  app.post("/api/kiosk/media", async (c) => {
    if (!cfg.kiosk?.enabled) return c.json({ error: `${cfg.nodeName} has no kiosk screen.`, screen: false }, 409);
    const cmd = parseMediaCommand(await c.req.json().catch(() => ({})));
    if ("error" in cmd) return c.json({ error: cmd.error }, 400);
    try {
      return c.json(await media(cmd));
    } catch (err) {
      return c.json({ error: firstLine(err), screen: true }, 503);
    }
  });
  return { enabled: Boolean(cfg.kiosk?.enabled), media };
}
