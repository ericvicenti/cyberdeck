import type { Hono } from "hono";
import type { Browser } from "playwright";
import type { CyberdeckConfig } from "../config";
import { createBrowserStreamHandlers, type Profile } from "../browser";

// Attach only to the browser supervised by cyberdeck-kiosk.service. The debugging
// endpoint stays on loopback; viewers must pass Cyberdeck/Casework authentication.
export function registerKioskRoutes(app: Hono, cfg: CyberdeckConfig, upgradeWebSocket: any, isAuthed: (c: any) => boolean) {
  let browser: Browser | undefined;
  let connecting: Promise<Browser> | undefined;
  const manager = { async get(): Promise<Profile> {
    if (!browser?.isConnected()) {
      connecting ??= import("playwright").then(({ chromium }) => chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 8000 }));
      try { browser = await connecting; } finally { connecting = undefined; }
    }
    const context = browser.contexts()[0];
    const page = context?.pages()[0];
    if (!page) throw new Error("Enuc's screen is unavailable. Check that its desktop is logged in.");
    return { name: "kiosk", context, page, dir: "", openedAt: 0 };
  } };
  app.get("/api/kiosk/stream", upgradeWebSocket((c: any) => {
    if (!cfg.kiosk?.enabled || !isAuthed(c)) return { onOpen(_e: unknown, ws: any) { ws.close(1008, "Screen control is unavailable"); } };
    return createBrowserStreamHandlers(manager, "kiosk", { fixedViewport: true });
  }));
}
