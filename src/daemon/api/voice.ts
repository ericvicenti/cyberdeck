// Voice routes: what the Casework app (src/native/calls.ts in remote-control) and the web Desk call
// to talk to the Seed agent. The app's flow is GET /api/voice/config -> provider "livekit" ->
// POST /api/voice/livekit -> join the LiveKit room with {url, token, room}. The Casework pairing
// key reaches everything here except setup (caseworkAllows in api/casework.ts).
//
// The voice system lives on one machine of the fleet, the hub. With `voice.hub` set, every node relays
// the call routes to that paired node (VoiceRelay), whatever its own bridge says, so the iPad app,
// which only ever talks to the node it is paired with, and every web Desk place calls through the
// hub. Without a hub, a node with no bridge relays to the first paired node that is configured.
// Answers that went through a peer carry `via: {node, name}`.
import type { Hono } from "hono";
import { networkInterfaces } from "os";
import { SeedBridge, SeedError } from "../seed";
import { peerFetch, type NodeRow } from "./fleet";
import type { TailnetState } from "../tailscale";

export type VoiceDeps = {
  /** Full (token or tailscale) authentication for the current request; setup requires it. */
  isFullAuth: (c: any) => boolean;
  /** The https origin `tailscale serve` publishes for a local port (Tailscale.serveOrigin). */
  serveOrigin?: (port: number) => Promise<string | null>;
  /** The paired node that answers for voice when this daemon has none (createVoiceRelay). */
  relay?: VoiceRelay;
  /** Further bridges from `seed.profiles` (a hosted agents server such as agent.hm), by name. A request with
   *  `?profile=<name>` is answered by that bridge, on this node, never relayed. */
  profiles?: Map<string, SeedBridge>;
  /** This node's own tailnet connection (Tailscale.backend). Asked after the hub failed to answer: a node that is
   *  itself off the tailnet blames itself, not the hub. */
  tailnet?: () => Promise<TailnetState | null>;
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
/** Reads (config, status, transcript) give up on a hub that does not answer this fast; actions (call grant,
 *  new session) wait longer. An offline hub (asleep, off the tailnet) hangs the connect, so these bound the wait. */
export const RELAY_READ_MS = 6_000;
export const RELAY_ACTION_MS = 15_000;
/** After the hub failed to answer, every voice route answers "hub unreachable" from memory this long instead of
 *  waiting on the network again: the Desk polls, the iPad polls, and each poll must not cost another timeout. */
export const HUB_DOWN_TTL_MS = 10_000;

/** A relay target that stopped answering: when it first failed and the last network error. `tailnet` is set when
 *  this node was itself off the tailnet at the time (Tailscale stopped or logged out): then the hub is probably fine. */
export type HubOutage = { since: number; error: string; tailnet?: TailnetState };

export type VoiceRelay = {
  /** The paired node that answers for voice: the hub when one is pinned (null when it is not paired), else
   *  the peer whose `/api/voice/config` says configured, or null when none does (cached). */
  find: () => Promise<NodeRow | null>;
  /** Forget the cached answer (tests, re-pairing). */
  reset: () => void;
  /** The hub's name when this node must relay there (set and not this node); undefined when voice is local or discovered. */
  readonly pinned?: string;
  /** The relay target's current outage, while the last failure is fresher than HUB_DOWN_TTL_MS; null when it answered
   *  since (or was never asked). After the TTL the next route tries the network again; `since` survives repeat failures. */
  outage: () => HubOutage | null;
  /** The relay target did not answer (network error, timeout). An HTTP error from it is not an outage: it answered.
   *  `tailnet`: this node's own connection when it is not running (the likely cause). */
  noteFailure: (error: string, tailnet?: TailnetState | null) => void;
  /** The relay target answered. */
  noteSuccess: () => void;
  /** This node's own name (for "this node is off the tailnet"). */
  readonly self?: string;
};

function outageTracker(): Pick<VoiceRelay, "outage" | "noteFailure" | "noteSuccess"> {
  let down: { at: number; since: number; error: string; tailnet?: TailnetState } | null = null;
  return {
    outage() { return down && Date.now() - down.at < HUB_DOWN_TTL_MS ? { since: down.since, error: down.error, ...(down.tailnet ? { tailnet: down.tailnet } : {}) } : null; },
    noteFailure(error, tailnet) { const now = Date.now(); down = { at: now, since: down?.since ?? now, error, ...(tailnet && !tailnet.running ? { tailnet } : {}) }; },
    noteSuccess() { down = null; },
  };
}

export type VoiceRelayOptions = {
  /** `voice.hub`: the paired node that runs the voice system; naming `self` means this node answers itself. */
  hub?: string;
  /** This node's own name. */
  self?: string;
};

const sameName = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

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
 * Finds the paired node that answers for voice. With a hub pinned it is that node, by name (or id), no
 * probe: `find` is null only while the hub is not paired. Otherwise the node that answered last is asked
 * first (it answers in milliseconds); else every peer is probed at once and the first "configured" wins.
 */
export function createVoiceRelay(peers: () => NodeRow[], probe: Probe = probeConfig, opts: VoiceRelayOptions = {}): VoiceRelay {
  let cached: { node: NodeRow | null; at: number } | null = null;
  let inFlight: Promise<NodeRow | null> | null = null;
  const hub = opts.hub?.trim() || undefined;
  if (hub && !sameName(hub, opts.self)) {
    return {
      pinned: hub,
      self: opts.self,
      async find() { return peers().find((r) => sameName(r.name, hub) || r.id === hub) ?? null; },
      reset() {},
      ...outageTracker(),
    };
  }
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
    self: opts.self,
    ...outageTracker(),
  };
}

export const viaOf = (node: NodeRow): VoiceVia => ({ node: node.id, name: node.name });

/** Why a node whose hub is not paired has no voice. */
export const hubUnpaired = (hub: string) => `voice hub ${hub} is not paired with this node (pair it from Home, or change voice.hub)`;

/** "2 h ago" / "35 min ago" / "just now" for the hub's last sighting. */
export function agoText(at: number | null | undefined, now = Date.now()): string | null {
  if (!at) return null;
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** What a stopped or logged-out Tailscale needs, in the words of the machine it runs on. */
export function tailnetText(t: TailnetState, self?: string): string {
  const here = self || "this node";
  if (t.state === "NeedsLogin") return `Tailscale on ${here} is logged out: log in from the Tailscale menu there, or run tailscale up`;
  if (t.state === "Stopped") return `Tailscale on ${here} is switched off: turn it on from the Tailscale menu there, or run tailscale up`;
  return `Tailscale on ${here} is ${t.state.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`;
}

/** Why a node whose paired hub does not answer has no voice right now (it is asleep or off the network), or, when
 *  this node is the one off the tailnet, what to do here. */
export function hubUnreachable(node: NodeRow, outage: HubOutage, self?: string): string {
  const seen = agoText(node.last_seen);
  if (outage.tailnet && !outage.tailnet.running) return `${self || "this node"} is off the tailnet, so voice hub ${node.name} is out of reach (${tailnetText(outage.tailnet, self)}${seen ? `; hub last seen ${seen}` : ""}); calls resume once this node is back on the tailnet`;
  return `voice hub ${node.name} is paired but not answering (${outage.error}${seen ? `; last seen ${seen}` : ""}); calls resume when it is back on the network`;
}

/** What every offline-hub answer carries next to `reason`, so a client can show the hub by name and when it was last seen.
 *  `tailnet` names this node's own Tailscale state when that is the cause (never its login url: that stays on the machine). */
export const hubInfo = (node: NodeRow, outage: HubOutage) => ({ name: node.name, node: node.id, reachable: false as const, since: outage.since, lastSeen: node.last_seen ?? null, ...(outage.tailnet ? { tailnet: { state: outage.tailnet.state, running: false as const } } : {}) });

/** A network error's one-line name: AbortSignal timeouts and refused connections read the same everywhere. */
export const networkErrorText = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && (e.name === "TimeoutError" || /timed out|timeout/i.test(msg))) return "no answer in time";
  if (/unable to connect|ECONNREFUSED|ConnectionRefused/i.test(msg)) return "connection refused";
  if (/ENOTFOUND|getaddrinfo|FailedToOpenSocket|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return "no route to the hub";
  return msg.replace(/^(TypeError|Error):\s*/, "").slice(0, 120) || "unreachable";
};

/** The shape `/api/state` and the Casework welcome carry: this node's bridge, or the peer that answers for it. */
export async function voiceSummary(bridge: SeedBridge, relay?: VoiceRelay): Promise<{ configured: boolean; provider: "livekit" | "none"; engine: "seed"; reason?: string; via?: VoiceVia }> {
  if (relay?.pinned) {
    const node = await relay.find().catch(() => null);
    if (!node) return { configured: false, provider: "none", engine: "seed", reason: hubUnpaired(relay.pinned) };
    const outage = relay.outage();
    if (outage) return { configured: false, provider: "none", engine: "seed", reason: hubUnreachable(node, outage, relay.self), via: viaOf(node) };
    return { configured: true, provider: "livekit", engine: "seed", via: viaOf(node) };
  }
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
        .catch((err) => console.error("seed: MCP refresh failed:", err instanceof Error ? err.message : err))
        // Then the harness: a deploy may have changed the prompt, the pack sources, or the model.
        .then(() => bridge.queryReady())
        .then((ready) => (ready ? bridge.syncHarness() : null))
        .then((r) => { if (r) for (const a of r.agents) if (a.definition.length || a.memory.written || a.memory.deleted) console.log(`seed: harness sync ${a.role} ${a.agentId}: ${a.definition.join(",") || "definition unchanged"}; memory ${a.memory.written} written, ${a.memory.deleted} deleted`); })
        .catch((err) => console.error("seed: harness sync failed:", err instanceof Error ? err.message : err));
    }, 5000).unref?.();
  }

  // `?profile=<name>` picks a `seed.profiles` bridge: another agents server this node signs into itself, so the hub
  // relay and the hub-missing answer do not apply. The default bridge otherwise.
  type Pick = { bridge: SeedBridge; direct: boolean; error: null } | { bridge: null; direct: false; error: string };
  const pick = (c: any): Pick => {
    const name = c.req.query("profile");
    if (!name) return { bridge, direct: false, error: null };
    const b = deps.profiles?.get(name);
    return b ? { bridge: b, direct: true, error: null } : { bridge: null, direct: false, error: `unknown seed profile "${name}" (config seed.profiles: ${[...(deps.profiles?.keys() ?? [])].join(", ") || "none"})` };
  };
  // The peer that answers for this node: the pinned hub whatever the local bridge says, else (for a node
  // without a bridge) the discovered peer. Never when the caller asked this node directly.
  const relayFor = async (c: any): Promise<NodeRow | null> => {
    if (!deps.relay || c.req.header(DIRECT_HEADER)) return null;
    if (deps.relay.pinned) return deps.relay.find().catch(() => null);
    if ((await bridge.status()).configured) return null;
    return deps.relay.find().catch(() => null);
  };
  // A pinned hub that is not paired: this node has no voice, and says why (the local bridge is not consulted).
  const hubMissing = (c: any): string | null => (deps.relay?.pinned && !c.req.header(DIRECT_HEADER) ? hubUnpaired(deps.relay.pinned) : null);
  // The peer did not answer (asleep, off the tailnet): voice is off here for now, and the answer says which hub,
  // since when, and that it comes back by itself. Shapes per route, so the Desk and the iPad read them like "not configured".
  type OfflineKind = "config" | "action" | "status" | "transcript" | "control";
  const offline = (c: any, node: NodeRow, outage: HubOutage, kind: OfflineKind, local?: unknown) => {
    const reason = hubUnreachable(node, outage, deps.relay?.self);
    const tail = { via: viaOf(node), hub: hubInfo(node, outage) };
    if (kind === "config") return c.json({ configured: false, provider: "none", engine: "seed", reason, ...tail });
    if (kind === "action") return c.json({ error: "voice hub unreachable", reason, ...tail }, 503);
    if (kind === "transcript") return c.json({ supported: true, messages: [], error: reason, ...tail }, 503);
    if (kind === "control") return c.json({ now: Date.now(), controls: [], error: reason, ...tail }, 503);
    return c.json({ ...(local as object), configured: false, reason, ...tail, local });
  };
  // After the hub failed to answer: this node's own Tailscale when it is not running (the likely cause), else null.
  const offTailnet = async (): Promise<TailnetState | null> => {
    const t = await deps.tailnet?.().catch(() => null);
    return t && !t.running ? t : null;
  };
  // Forwards the request to the peer and returns its answer with `via` (and the peer's status code). A peer that does
  // not answer is remembered as down (HUB_DOWN_TTL_MS) so the next polls answer at once instead of waiting again.
  const relayed = async (c: any, node: NodeRow, path: string, kind: OfflineKind, init: RequestInit = {}) => {
    const known = deps.relay?.outage();
    if (known) return offline(c, node, known, kind);
    try {
      const res = await peerFetch(node, path, { ...init, headers: { ...(init.headers as Record<string, string>), [DIRECT_HEADER]: "1" }, signal: AbortSignal.timeout(kind === "action" ? RELAY_ACTION_MS : RELAY_READ_MS) });
      deps.relay?.noteSuccess();
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return c.json({ error: `voice relay to ${node.name} returned ${res.status}`, via: viaOf(node) }, 502);
      return c.json({ ...body, via: viaOf(node) }, res.status as any);
    } catch (e) {
      const error = networkErrorText(e);
      const tailnet = await offTailnet();
      console.error(`voice: relay to ${node.name} failed:`, error, tailnet ? `(${tailnetText(tailnet, deps.relay?.self)}${tailnet.authUrl ? `; log in at ${tailnet.authUrl}` : ""})` : "");
      deps.relay?.noteFailure(error, tailnet);
      return offline(c, node, deps.relay?.outage() ?? { since: Date.now(), error, ...(tailnet ? { tailnet } : {}) }, kind);
    }
  };

  app.get("/api/voice/config", async (c) => {
    const node = await relayFor(c);
    if (node) return relayed(c, node, "/api/voice/config", "config");
    const missing = hubMissing(c);
    if (missing) return c.json({ configured: false, provider: "none", engine: "seed", reason: missing });
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
    const p = pick(c);
    if (!p.bridge) return c.json({ error: p.error }, 404);
    const node = p.direct ? null : await relayFor(c);
    if (node) return relayed(c, node, "/api/voice/livekit", "action", { method: "POST" });
    const missing = p.direct ? null : hubMissing(c);
    if (missing) return c.json({ error: "voice not configured", reason: missing }, 503);
    const s = await p.bridge.status();
    if (!s.configured) return c.json({ error: "voice not configured", reason: s.reason }, 503);
    try {
      const v = await p.bridge.createVoiceSession();
      const secureUrl = deps.serveOrigin ? await secureCallUrl(v.url, deps.serveOrigin) : null;
      return c.json(secureUrl ? { ...v, secureUrl } : v);
    } catch (e) {
      console.error("voice: CreateVoiceSession failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });

  // This node's own bridge; when a peer answers for it, the peer's status with `via` and this node's under `local`.
  app.get("/api/voice/status", async (c) => {
    const p = pick(c);
    if (!p.bridge) return c.json({ error: p.error }, 404);
    const s = await p.bridge.status();
    if (p.direct) return c.json(s);
    const node = await relayFor(c);
    if (node) {
      const known = deps.relay?.outage();
      if (known) return offline(c, node, known, "status", s);
      try {
        const res = await peerFetch(node, "/api/voice/status", { headers: { [DIRECT_HEADER]: "1" }, signal: AbortSignal.timeout(RELAY_READ_MS) });
        deps.relay?.noteSuccess();
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (body && typeof body === "object") return c.json({ ...body, via: viaOf(node), local: s }, res.status as any);
      } catch (e) {
        const error = networkErrorText(e);
        const tailnet = await offTailnet();
        console.error(`voice: status relay to ${node.name} failed:`, error, tailnet ? `(${tailnetText(tailnet, deps.relay?.self)})` : "");
        deps.relay?.noteFailure(error, tailnet);
        return offline(c, node, deps.relay?.outage() ?? { since: Date.now(), error, ...(tailnet ? { tailnet } : {}) }, "status", s);
      }
    }
    const missing = hubMissing(c);
    if (missing) return c.json({ ...s, configured: false, reason: missing, local: s });
    return c.json(s);
  });

  // Body {room?}: a live call's room is switched to the new session too (the caller keeps talking).
  app.post("/api/voice/session/reset", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const p = pick(c);
    if (!p.bridge) return c.json({ error: p.error }, 404);
    const node = p.direct ? null : await relayFor(c);
    if (node) return relayed(c, node, "/api/voice/session/reset", "action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const missing = p.direct ? null : hubMissing(c);
    if (missing) return c.json({ error: "voice not configured", reason: missing }, 503);
    try { return c.json(await p.bridge.resetSession({ room: typeof body?.room === "string" ? body.room : undefined })); }
    catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });

  app.get("/api/voice/transcript", async (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    const p = pick(c);
    if (!p.bridge) return c.json({ error: p.error }, 404);
    const node = p.direct ? null : await relayFor(c);
    if (node) return relayed(c, node, `/api/voice/transcript?limit=${Number.isFinite(limit) ? limit : 20}`, "transcript");
    const missing = p.direct ? null : hubMissing(c);
    if (missing) return c.json({ supported: true, messages: [], error: missing }, 503);
    try { return c.json(await p.bridge.transcript(Number.isFinite(limit) ? limit : 20)); }
    catch (e) { return c.json({ supported: true, messages: [], ...errorBody(e) }, errorStatus(e)); }
  });

  // What the agent asked of the live call through its `listen` tool (mute / unmute / hangup) since the client last
  // asked: the Desk and the iPad poll this every few seconds while a call is up. Without `since` nothing is pending
  // and the answer's `now` is the baseline for the next poll (the server's clock, so a skewed browser never misses one).
  app.get("/api/voice/control", async (c) => {
    const raw = c.req.query("since");
    const node = await relayFor(c);
    if (node) return relayed(c, node, `/api/voice/control${raw !== undefined ? `?since=${encodeURIComponent(raw)}` : ""}`, "control");
    const missing = hubMissing(c);
    if (missing) return c.json({ now: Date.now(), controls: [], error: missing }, 503);
    const now = Date.now();
    const since = raw === undefined ? now : Number(raw);
    if (!Number.isFinite(since)) return c.json({ error: "since must be a Unix millisecond timestamp" }, 400);
    return c.json({ now, controls: bridge.controls(since, now) });
  });

  // The companion's triggers and prompt live with the voice hub, like the companion itself: on a node pinned to a
  // hub these node-token routes go there (the answer carries `via`), so `cyberdeck seed digest` on any node acts on
  // the one agent instead of making a second trigger, grant or signing identity on the node's own agents server.
  // `?profile=` stays local: a profile is this node's own bridge. A pinned hub that is not paired refuses, like `livekit`.
  const hubOrLocal = async (c: any, path: string, init: RequestInit): Promise<{ bridge: SeedBridge } | { response: Response }> => {
    const p = pick(c);
    if (!p.bridge) return { response: c.json({ error: p.error }, 404) };
    const node = p.direct ? null : await relayFor(c);
    if (node) return { response: await relayed(c, node, path, "action", init) };
    const missing = p.direct ? null : hubMissing(c);
    if (missing) return { response: c.json({ error: "voice not configured", reason: missing }, 503) };
    return { bridge: p.bridge };
  };

  // Daily fleet check-in schedule trigger on the agent (idempotent; a stale prompt is rewritten). Node token only.
  app.post("/api/voice/dogfood", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const t = await hubOrLocal(c, "/api/voice/dogfood", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    if ("response" in t) return t.response;
    try {
      return c.json(await t.bridge.dogfood({ timezone: typeof body?.timezone === "string" ? body.timezone : undefined, timeOfDay: typeof body?.timeOfDay === "string" ? body.timeOfDay : undefined }));
    } catch (e) {
      console.error("voice: dogfood failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });

  // Run-completed trigger on the voice agent announcing finished harness runs on the Desk (idempotent). Node token only.
  app.post("/api/voice/runwatch", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const t = await hubOrLocal(c, "/api/voice/runwatch", { method: "POST" });
    if ("response" in t) return t.response;
    try { return c.json(await t.bridge.runWatch()); }
    catch (e) {
      console.error("voice: runwatch failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });

  // Weekly fleet digest: signing identity + publish grant + Monday schedule trigger on the agent (idempotent). Node token only.
  app.post("/api/voice/digest", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const t = await hubOrLocal(c, "/api/voice/digest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    if ("response" in t) return t.response;
    try {
      return c.json(await t.bridge.digest({ timezone: typeof body?.timezone === "string" ? body.timezone : undefined, timeOfDay: typeof body?.timeOfDay === "string" ? body.timeOfDay : undefined, dayOfWeek: typeof body?.dayOfWeek === "number" ? body.dayOfWeek : undefined }));
    } catch (e) {
      console.error("voice: digest failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });

  // The companion's system prompt against the fleet persona; POST writes it. Node token only.
  app.get("/api/voice/prompt", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const t = await hubOrLocal(c, "/api/voice/prompt", { method: "GET" });
    if ("response" in t) return t.response;
    try { return c.json(await t.bridge.prompt(false)); } catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });
  app.post("/api/voice/prompt", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const t = await hubOrLocal(c, "/api/voice/prompt", { method: "POST" });
    if ("response" in t) return t.response;
    try { return c.json(await t.bridge.prompt(true)); } catch (e) {
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
  // Every bridge of this node: the default first, then each `seed.profiles` entry, with where it points and whether it is set up.
  app.get("/api/voice/profiles", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const all: [string | null, SeedBridge][] = [[null, bridge], ...[...(deps.profiles ?? [])]];
    const profiles = await Promise.all(all.map(async ([name, b]) => {
      const s = await b.status();
      return { name, agentsUrl: s.agentsUrl, mcpUrl: s.mcpUrl, configured: s.configured, ...(s.reason ? { reason: s.reason } : {}), identity: s.identity, ...(s.agent ? { agent: s.agent } : {}), ...(s.sessionId ? { sessionId: s.sessionId } : {}), health: s.health ?? null, stateFile: b.stateFile };
    }));
    return c.json({ profiles });
  });
  // Node identity and provider sign-in (machines without a Seed vault, docs/VOICE.md).
  app.post("/api/voice/keygen", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "full authentication required" }, 403);
    const body = await c.req.json().catch(() => ({}));
    try { const r = bridge.keygen({ force: body?.force === true }); return c.json({ ...r, ...(await bridge.status()).identity }); }
    catch (e) { return c.json(errorBody(e), 500); }
  });
  app.get("/api/voice/providers", async (c) => {
    const p = pick(c);
    if (!p.bridge) return c.json({ error: p.error }, 404);
    try { return c.json({ providers: await p.bridge.providers() }); }
    catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });
  app.post("/api/voice/login", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "full authentication required" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const p = pick(c);
    if (!p.bridge) return c.json({ error: p.error }, 404);
    try {
      if (typeof body?.code === "string" && body.code.trim()) return c.json(await p.bridge.loginSubmit(body.code, typeof body.loginId === "string" ? body.loginId : undefined));
      if (body?.status === true) return c.json(await p.bridge.loginStatus(typeof body.loginId === "string" ? body.loginId : undefined));
      return c.json(await p.bridge.loginStart(typeof body?.providerType === "string" ? body.providerType : undefined));
    } catch (e) { return c.json(errorBody(e), errorStatus(e)); }
  });
  app.post("/api/voice/setup", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const p = pick(c);
    if (!p.bridge) return c.json({ error: p.error }, 404);
    try {
      return c.json(await p.bridge.setup({ fresh: body?.new === true || body?.fresh === true, adopt: body?.adopt !== false, name: typeof body?.name === "string" ? body.name : undefined }));
    } catch (e) {
      console.error("voice: setup failed:", e instanceof Error ? e.message : e);
      return c.json(errorBody(e), errorStatus(e));
    }
  });
}
