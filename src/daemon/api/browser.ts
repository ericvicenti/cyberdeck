// Remote browser routes: open/inspect a persistent profile and stream it over a WebSocket.
import type { Hono } from "hono";
import { BrowserManager, PROFILE_RE, normalizeUrl, createBrowserStreamHandlers } from "../browser";

export function registerBrowserRoutes(app: Hono, mgr: BrowserManager, upgradeWebSocket: any, isAuthed: (c: any) => boolean) {
  const bad = (c: any) => c.json({ error: "bad profile name" }, 400);

  app.get("/api/browser/profiles", async (c) => {
    const avail = await mgr.available();
    return c.json({ ...avail, profiles: mgr.listProfiles() });
  });

  app.get("/api/browser/:profile/state", async (c) => {
    const name = c.req.param("profile");
    if (!PROFILE_RE.test(name)) return bad(c);
    const st = await mgr.state(name);
    return c.json(st ? { ...st, open: true } : { url: "", title: "", loading: false, open: false });
  });

  app.post("/api/browser/:profile/open", async (c) => {
    const name = c.req.param("profile");
    if (!PROFILE_RE.test(name)) return bad(c);
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    const url = typeof body.url === "string" ? normalizeUrl(body.url) : "about:blank";
    if (!url) return c.json({ error: "bad url" }, 400);
    try { return c.json(await mgr.open(name, url)); } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 503); }
  });

  app.post("/api/browser/:profile/close", async (c) => {
    const name = c.req.param("profile");
    if (!PROFILE_RE.test(name)) return bad(c);
    return c.json({ closed: await mgr.close(name) });
  });

  app.get(
    "/api/browser/:profile/stream",
    upgradeWebSocket((c: any) => {
      if (!isAuthed(c)) return {};
      const name = c.req.param("profile");
      if (!PROFILE_RE.test(name)) return {};
      return createBrowserStreamHandlers(mgr, name);
    })
  );
}
