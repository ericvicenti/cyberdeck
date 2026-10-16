// Voice routes: what the Casework app (src/native/calls.ts in remote-control) and the web Desk call
// to talk to the Seed agent. The app's flow is GET /api/voice/config -> provider "livekit" ->
// POST /api/voice/livekit -> join the LiveKit room with {url, token, room}. The Casework pairing
// key reaches everything here except setup (caseworkAllows in api/casework.ts).
//
// The agents server lives on one machine of the fleet. A node without a bridge of its own relays
// the call routes to the first paired node that is configured (VoiceRelay), so the iPad app, which
// only ever talks to the node it is paired with, places calls from any node. Answers that went
// through a peer carry `via: {node, name}`.
import type { Hono } from "hono";
import { networkInterfaces } from "os";
import { SeedBridge, SeedError } from "../seed";
import { peerFetch, type NodeRow } from "./fleet";

export type VoiceDeps = {
  /** Full (token or tailscale) authentication for the current request; setup requires it. */
  isFullAuth: (c: any) => boolean;
  /** The https origin `tailscale serve` publishes for a local port (Tailscale.serveOrigin). */
  serveOrigin?: (port: number) => Promise<string | null>;
  /** The paired node that answers for voice when this daemon has none (createVoiceRelay). */
  relay?: VoiceRelay;
};

/** Where a relayed answer came from. */
export type VoiceVia = { node: string; name: string };

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

/** A peer's answer to "do you have voice?" is never itself relayed: this header marks the probe. */
export const DIRECT_HEADER = "x-cyberdeck-voice-direct";
const RELAY_PROBE_MS = 4_000;
/** A found relay is trusted this long before it is asked again; "nobody has voice" is re-checked sooner. */
const RELAY_TTL_MS = 60_000;
const RELAY_MISS_TTL_MS = 15_000;

export type VoiceRelay = {
  /** The paired node whose `/api/voice/config` says configured, or null when none does (cached). */
  find: () => Promise<NodeRow | null>;
  /** Forget the cached answer (tests, re-pairing). */
  reset: () => void;
};

type Probe = (node: NodeRow) => Promise<boolean>;

const probeConfig: Probe = async (node) => {
  // The timer is a hard bound: an AbortSignal cannot cancel a stuck DNS/mDNS lookup of an offline peer.
  const res = await Promise.race([
    peerFetch(node, "/api/voice/config", { headers: { [DIRECT_HEADER]: "1" }, signal: AbortSignal.timeout(RELAY_PROBE_MS) }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), RELAY_PROBE_MS + 500)),
  ]);
  if (!res.ok) return false;
  const body = (await res.json().catch(() => null)) as { configured?: boolean; via?: unknown } | null;
  // A peer that itself relays is not the voice node; the first hop finds the real one on its own.
  return body?.configured === true && !body.via;
};

/**
 * Finds the paired node with a voice bridge. The node that answered last is asked first (it answers
 * in milliseconds); otherwise every peer is probed at once and the first "configured" wins.
 */
export function createVoiceRelay(peers: () => NodeRow[], probe: Probe = probeConfig): VoiceRelay {
  let cached: { node: NodeRow | null; at: number } | null = null;
  let inFlight: Promise<NodeRow | null> | null = null;
  const lookup = async (): Promise<NodeRow | null> => {
    const rows = peers();
    if (rows.length === 0) throw new Error("no peers");
    const last = cached?.node ? rows.find((r) => r.id === cached!.node!.id) : undefined;
    if (last && (await probe(last).catch(() => false))) return last;
    const asked = rows.filter((r) => r.id !== last?.id).map((r) => probe(r).then((ok) => (ok ? r : Promise.reject(new Error("no voice")))));
    return asked.length ? await Promise.any(asked).catch(() => null) : null;
  };
  return {
    async find() {
      if (cached && Date.now() - cached.at < (cached.node ? RELAY_TTL_MS : RELAY_MISS_TTL_MS)) return cached.node;
      // A node with no peers yet caches nothing: the first pairing must be seen at once.
      if (!inFlight) inFlight = lookup().then((node) => { cached = { node, at: Date.now() }; return node; }, () => null).finally(() => { inFlight = null; });
      return inFlight;
    },
    reset() { cached = null; },
  };
}

export const viaOf = (node: NodeRow): VoiceVia => ({ node: node.id, name: node.name });

/** The shape `/api/state` and the Casework welcome carry: this node's bridge, or the peer that answers for it. */
export async function voiceSummary(bridge: SeedBridge, relay?: VoiceRelay): Promise<{ configured: boolean; provider: "livekit" | "none"; engine: "seed"; reason?: string; via?: VoiceVia }> {
  const own = await bridge.voiceSummary();
  if (own.configured || !relay) return own;
  const node = await relay.find().catch(() => null);
  return node ? { configured: true, provider: "livekit", engine: "seed", via: viaOf(node) } : own;
}

const errorStatus = (e: unknown): 502 | 503 => (e instanceof SeedError && e.status === 0 && /no agent set up|identity unavailable|unreachable/.test(e.message) ? 503 : 502);
const errorBody = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

export function registerVoiceRoutes(app: Hono, bridge: SeedBridge, deps: VoiceDeps) {
  // A deploy may have added MCP tools; the agents server only sees them after a re-registration.
  if (process.env.NODE_ENV !== "test") {
    setTimeout(() => {
      bridge.refreshMcp()
        .then((r) => { if (r === "refreshed") console.log("seed: MCP tool list changed; re-registered with the agents server"); })
        .catch((err) => console.error("seed: MCP refresh failed:", err instanceof Error ? err.message : err));
    }, 5000).unref?.();
  }

  // The peer that answers for a node without a bridge, unless the caller asked this node directly.
  const relayFor = async (c: any): Promise<NodeRow | null> => {
    if (!deps.relay || c.req.header(DIRECT_HEADER)) return null;
    if ((await bridge.status()).configured) return null;
    return deps.relay.find().catch(() => null);
  };
  // Forwards the request to the peer and returns its answer with `via` (and the peer's status code).
  const relayed = async (c: any, node: NodeRow, path: string, init: RequestInit = {}) => {
    try {
      const res = await peerFetch(node, path, { ...init, headers: { ...(init.headers as Record<string, string>), [DIRECT_HEADER]: "1" }, signal: AbortSignal.timeout(20_000) });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return c.json({ error: `voice relay to ${node.name} returned ${res.status}`, via: viaOf(node) }, 502);
      return c.json({ ...body, via: viaOf(node) }, res.status as any);
    } catch (e) {
      console.error(`voice: relay to ${node.name} failed:`, e instanceof Error ? e.message : e);
      return c.json({ error: `voice relay to ${node.name} failed: ${e instanceof Error ? e.message : e}`, via: viaOf(node) }, 502);
    }
  };

  app.get("/api/voice/config", async (c) => {
    const s = await bridge.status();
    if (!s.configured) {
      const node = await relayFor(c);
      if (node) return relayed(c, node, "/api/voice/config");
    }
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
    if (!s.configured) {
      const node = await relayFor(c);
      if (node) return relayed(c, node, "/api/voice/livekit", { method: "POST" });
      return c.json({ error: "voice not configured", reason: s.reason }, 503);
    }
    try {
      const v = await bridge.createVoiceSession();
      const secureUrl = deps.serveOrigin ? await secureCallUrl(v.url, deps.serveOrigin) : null;
      return c.json(secureUrl ? { ...v, secureUrl } : v);
    } catch (e) {
      console.error("voice: CreateVoiceSession failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });

  // This node's own bridge; when a peer answers for it, the peer's status with `via` and this node's under `local`.
  app.get("/api/voice/status", async (c) => {
    const s = await bridge.status();
    if (!s.configured) {
      const node = await relayFor(c);
      if (node) {
        try {
          const res = await peerFetch(node, "/api/voice/status", { headers: { [DIRECT_HEADER]: "1" }, signal: AbortSignal.timeout(20_000) });
          const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          if (body && typeof body === "object") return c.json({ ...body, via: viaOf(node), local: s }, res.status as any);
        } catch (e) {
          console.error(`voice: status relay to ${node.name} failed:`, e instanceof Error ? e.message : e);
        }
      }
    }
    return c.json(s);
  });

  // Body {room?}: a live call's room is switched to the new session too (the caller keeps talking).
  app.post("/api/voice/session/reset", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const node = await relayFor(c);
    if (node) return relayed(c, node, "/api/voice/session/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    try { return c.json(await bridge.resetSession({ room: typeof body?.room === "string" ? body.room : undefined })); }
    catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });

  app.get("/api/voice/transcript", async (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    const node = await relayFor(c);
    if (node) return relayed(c, node, `/api/voice/transcript?limit=${Number.isFinite(limit) ? limit : 20}`);
    try { return c.json(await bridge.transcript(Number.isFinite(limit) ? limit : 20)); }
    catch (e) { return c.json({ supported: true, messages: [], ...errorBody(e) }, errorStatus(e)); }
  });

  // Daily fleet check-in schedule trigger on the agent (idempotent; a stale prompt is rewritten). Node token only.
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
