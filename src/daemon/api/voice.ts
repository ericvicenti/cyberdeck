// Voice routes: what the Casework app (src/native/calls.ts in remote-control) and the web Desk call
// to talk to the Seed agent. The app's flow is GET /api/voice/config -> provider "livekit" ->
// POST /api/voice/livekit -> join the LiveKit room with {url, token, room}. The Casework pairing
// key reaches everything here except setup (caseworkAllows in api/casework.ts).
import type { Hono } from "hono";
import { networkInterfaces } from "os";
import { SeedBridge, SeedError } from "../seed";

export type VoiceDeps = {
  /** Full (token or tailscale) authentication for the current request; setup requires it. */
  isFullAuth: (c: any) => boolean;
  /** The https origin `tailscale serve` publishes for a local port (Tailscale.serveOrigin). */
  serveOrigin?: (port: number) => Promise<string | null>;
};

/** Addresses that mean "this machine" in a call server URL. */
export function localHosts(): Set<string> {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4") hosts.add(a.address);
  return hosts;
}

/**
 * The wss:// twin of a plain ws:// call server on this machine, when `tailscale serve` publishes its
 * port over TLS (e.g. `tailscale serve --bg --https=7443 http://127.0.0.1:7880`). An https page (the
 * Desk on the tailnet origin) cannot open ws://, so the browser uses this instead; media still flows
 * over WebRTC to the addresses the call server advertises.
 */
export async function secureCallUrl(url: string, serveOrigin: (port: number) => Promise<string | null>, hosts = localHosts()): Promise<string | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "ws:" || !hosts.has(u.hostname)) return null;
  const origin = await serveOrigin(Number(u.port || 80)).catch(() => null);
  return origin ? `${origin.replace(/^https:/, "wss:")}${u.pathname === "/" ? "" : u.pathname}` : null;
}

const errorStatus = (e: unknown): 502 | 503 => (e instanceof SeedError && e.status === 0 && /no agent set up|identity unavailable|unreachable/.test(e.message) ? 503 : 502);
const errorBody = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

export function registerVoiceRoutes(app: Hono, bridge: SeedBridge, deps: VoiceDeps) {
  // A deploy may have added MCP tools; the agents server only sees them after a re-registration.
  if (process.env.NODE_ENV !== "test") {
    setTimeout(() => {
      bridge.refreshMcp()
        .then((r) => { if (r === "refreshed") console.log("seed: MCP tool list changed; re-registered with the agents server"); })
        .catch((err) => console.error("seed: MCP refresh failed:", err instanceof Error ? err.message : err))
        // Then the harness: a deploy may have changed the prompt, the pack sources, or the model.
        .then(() => bridge.queryReady())
        .then((ready) => (ready ? bridge.syncHarness() : null))
        .then((r) => { if (r) for (const a of r.agents) if (a.definition.length || a.memory.written || a.memory.deleted) console.log(`seed: harness sync ${a.role} ${a.agentId}: ${a.definition.join(",") || "definition unchanged"}; memory ${a.memory.written} written, ${a.memory.deleted} deleted`); })
        .catch((err) => console.error("seed: harness sync failed:", err instanceof Error ? err.message : err));
    }, 5000).unref?.();
  }
  app.get("/api/voice/config", async (c) => {
    const s = await bridge.status();
    return c.json({
      configured: s.configured,
      provider: s.configured ? "livekit" : "none",
      engine: "seed",
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.agent ? { agentId: s.agent.id } : {}),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    });
  });

  app.post("/api/voice/livekit", async (c) => {
    const s = await bridge.status();
    if (!s.configured) return c.json({ error: "voice not configured", reason: s.reason }, 503);
    try {
      const v = await bridge.createVoiceSession();
      const secureUrl = deps.serveOrigin ? await secureCallUrl(v.url, deps.serveOrigin) : null;
      return c.json(secureUrl ? { ...v, secureUrl } : v);
    } catch (e) {
      console.error("voice: CreateVoiceSession failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });

  app.get("/api/voice/status", async (c) => c.json(await bridge.status()));

  // Body {room?}: a live call's room is switched to the new session too (the caller keeps talking).
  app.post("/api/voice/session/reset", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try { return c.json(await bridge.resetSession({ room: typeof body?.room === "string" ? body.room : undefined })); }
    catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });

  app.get("/api/voice/transcript", async (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    try { return c.json(await bridge.transcript(Number.isFinite(limit) ? limit : 20)); }
    catch (e) { return c.json({ supported: true, messages: [], ...errorBody(e) }, errorStatus(e)); }
  });

  // Daily fleet check-in schedule trigger on the agent (idempotent). Node token only.
  app.post("/api/voice/dogfood", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await bridge.dogfood({ timezone: typeof body?.timezone === "string" ? body.timezone : undefined, timeOfDay: typeof body?.timeOfDay === "string" ? body.timeOfDay : undefined }));
    } catch (e) {
      console.error("voice: dogfood failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });

  // The companion's system prompt against the fleet persona; POST writes it. Node token only.
  app.get("/api/voice/prompt", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    try { return c.json(await bridge.prompt(false)); } catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });
  app.post("/api/voice/prompt", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    try { return c.json(await bridge.prompt(true)); } catch (e) {
      console.error("voice: prompt failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });

  // Registers this daemon's MCP server with the agents server and picks (or creates) the agent.
  // The harness: prompt + memory pack + definition of the agents, from this node's files.
  app.get("/api/voice/harness", async (c) => {
    try { return c.json(await bridge.harnessStatus()); }
    catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });
  app.get("/api/voice/harness/prompt", (c) => c.text(bridge.harnessPromptText()));
  app.post("/api/voice/harness/sync", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "full authentication required" }, 403);
    const body = await c.req.json().catch(() => ({}));
    try { return c.json(await bridge.syncHarness({ voice: body?.voice === true, force: body?.force === true })); }
    catch (e) { console.error("seed: harness sync failed:", e instanceof Error ? e.message : e); return c.json(errorBody(e), errorStatus(e)); }
  });
  // Node identity and provider sign-in (machines without a Seed vault, docs/VOICE.md).
  app.post("/api/voice/keygen", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "full authentication required" }, 403);
    const body = await c.req.json().catch(() => ({}));
    try { const r = bridge.keygen({ force: body?.force === true }); return c.json({ ...r, ...(await bridge.status()).identity }); }
    catch (e) { return c.json(errorBody(e), 500); }
  });
  app.get("/api/voice/providers", async (c) => {
    try { return c.json({ providers: await bridge.providers() }); }
    catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });
  app.post("/api/voice/login", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "full authentication required" }, 403);
    const body = await c.req.json().catch(() => ({}));
    try {
      if (typeof body?.code === "string" && body.code.trim()) return c.json(await bridge.loginSubmit(body.code, typeof body.loginId === "string" ? body.loginId : undefined));
      if (body?.status === true) return c.json(await bridge.loginStatus(typeof body.loginId === "string" ? body.loginId : undefined));
      return c.json(await bridge.loginStart(typeof body?.providerType === "string" ? body.providerType : undefined));
    } catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });
  app.post("/api/voice/setup", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await bridge.setup({ fresh: body?.new === true || body?.fresh === true, adopt: body?.adopt !== false, name: typeof body?.name === "string" ? body.name : undefined }));
    } catch (e) {
      console.error("voice: setup failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });
}
