import type { Hono, Context } from "hono";

// Only the authorization code crosses this short-lived handoff. PKCE verifiers
// and Spotify tokens stay in the native client, never in the daemon or event log.
export function registerNativeSpotifyRoutes(app: Hono, isOwner: (c: Context) => boolean, port: number, now = Date.now) {
  type Pending = { state: string; expires: number; result?: { code?: string; error?: string } };
  const pending = new Map<string, Pending>();
  const prune = () => { for (const [id, p] of pending) if (p.expires <= now()) pending.delete(id); };
  app.use("/api/spotify/native/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!isOwner(c)) return c.json({ error: "Owner authentication required" }, 403);
    prune(); await next();
  });
  app.post("/api/spotify/native/start", (c) => {
    if (pending.size >= 8) return c.json({ error: "Too many pending Spotify connections. Try again shortly." }, 429);
    const id = crypto.randomUUID(), state = "casework-spotify-" + crypto.randomUUID();
    pending.set(id, { state, expires: now() + 600_000 });
    return c.json({ id, state, redirect: `http://127.0.0.1:${port}/` });
  });
  app.post("/api/spotify/native/:id/cancel", (c) => { pending.delete(c.req.param("id")); return c.json({ ok: true }); });
  app.get("/api/spotify/native/:id", (c) => {
    const id = c.req.param("id"), p = pending.get(id);
    if (!p) return c.json({ error: "Spotify connection expired. Choose Connect Spotify again." }, 404);
    if (!p.result) return c.json({ pending: true });
    pending.delete(id); return c.json(p.result);
  });
  app.get("/spotify-native-complete", (c) => {
    c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    return c.html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Return to Casework</title><body style="background:#101324;color:#f5f5ff;font:24px system-ui;max-width:600px;margin:15vh auto;padding:32px"><h1>Return to Casework</h1><p>Your Spotify sign-in has been received. Casework will finish connecting.</p></body>');
  });
  app.get("/", async (c, next) => {
    const state = c.req.query("state") ?? "";
    if (!state.startsWith("casework-spotify-")) return next();
    c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
    prune();
    const p = [...pending.values()].find(p => p.state === state);
    const url = new URL(c.req.url);
    if (!p || p.result || url.origin !== `http://127.0.0.1:${port}`) return c.text("Spotify connection expired or already used. Return to Casework and reconnect.", 400);
    const code = c.req.query("code");
    p.result = code && code.length <= 4096 && !c.req.query("error") ? { code } : { error: "Spotify sign-in was not completed. Choose Connect Spotify to try again." };
    return c.redirect("/spotify-native-complete", 303);
  });
}
