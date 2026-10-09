import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { CyberdeckConfig } from "../config";
import { NETWORK_BYTES, NETWORK_INTERVAL, networkName, type NetworkNode, type NetworkSample, type NetworkSnapshot } from "../../shared/network";
import type { NodeRow } from "./fleet";

const TIMEOUT = 15_000;
const COOLDOWN = 60_000;

/** Partial transfers are failures, never speed samples. */
export async function readNetworkBytes(body: ReadableStream<Uint8Array> | null, expected: number): Promise<number> {
  if (!body) throw new Error("empty response");
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > expected) throw new Error("unexpected transfer size");
    }
    if (bytes !== expected) throw new Error("incomplete transfer");
    return bytes;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function registerNetworkRoutes(app: Hono, db: Database, cfg: CyberdeckConfig) {
  db.run(`CREATE TABLE IF NOT EXISTS network_samples (source TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.run(`CREATE INDEX IF NOT EXISTS network_samples_time ON network_samples(at)`);
  const source = networkName(cfg.nodeName);
  let running: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let boot: ReturnType<typeof setTimeout> | null = null;
  let nextCheckAt: number | null = null;
  let payload: Uint8Array<ArrayBuffer> | null = null;
  const data = () => payload ??= Uint8Array.from(randomBytes(NETWORK_BYTES));
  const peers = () => db.query("SELECT * FROM nodes ORDER BY name").all() as NodeRow[];
  const history = () => (db.query("SELECT data FROM network_samples ORDER BY at DESC LIMIT 512").all() as { data: string }[]).map(r => JSON.parse(r.data) as NetworkSample);
  const automatic = () => cfg.network?.automatic !== false;
  const inventory = (): NetworkNode[] => {
    const paired = peers();
    const nodes: NetworkNode[] = [{ id: null, name: source, kind: "host", roles: [], services: [], local: true }, ...paired.map(p => ({ id: p.id, name: networkName(p.name), kind: "host", roles: [] as string[], services: [] as string[], local: false }))];
    if (cfg.fleetDir) try {
      const manifest = JSON.parse(readFileSync(join(cfg.fleetDir, "fleet.json"), "utf8"));
      for (const [name, value] of Object.entries(manifest.hosts ?? {}) as [string, any][]) {
        const n = nodes.find(n => n.name === networkName(name));
        const fields = { kind: String(value.kind ?? "host"), roles: (value.roles ?? []) as string[], services: [...new Set<string>((value.services ?? []).map((s: any) => String(s.name)))] };
        if (n) Object.assign(n, fields);
        else nodes.push({ id: null, name: networkName(name), local: false, ...fields });
      }
    } catch { /* Nodes without Deck still measure paired peers. */ }
    return nodes;
  };
  const snapshot = (): NetworkSnapshot => ({ source, nodes: inventory(), samples: history(), running, automatic: automatic(), intervalMs: NETWORK_INTERVAL, nextCheckAt });
  const latest = (target: string) => history().find(s => s.target === target);

  async function measure(peer: NodeRow): Promise<void> {
    const target = networkName(peer.name);
    running = target;
    const sample: NetworkSample = { source, target, at: Date.now(), latencyMs: null, downloadMbps: null, uploadMbps: null, bytes: 0 };
    const request = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${peer.url}/api/network/${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT), headers: { ...init.headers, authorization: `Bearer ${peer.token}`, "cache-control": "no-store" } });
      if (!res.ok) throw new Error(res.status === 404 ? "Network tests need a Cyberdeck update on this peer" : `Peer returned HTTP ${res.status}`);
      return res;
    };
    try {
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const pong = await (await request("ping")).json();
        if (pong.protocol !== 1) throw new Error("Peer does not support network tests");
        times.push(performance.now() - start);
      }
      sample.latencyMs = times.sort((a, b) => a - b)[1];
      let start = performance.now();
      const download = await request("payload");
      if (download.headers.get("content-type") !== "application/octet-stream") throw new Error("Peer does not support network tests");
      await readNetworkBytes(download.body, NETWORK_BYTES);
      sample.downloadMbps = NETWORK_BYTES * 8 / Math.max(1, performance.now() - start) / 1000;
      sample.bytes += NETWORK_BYTES;
      start = performance.now();
      const receipt = await (await request("payload", { method: "POST", body: data(), headers: { "content-type": "application/octet-stream" } })).json();
      if (receipt.bytes !== NETWORK_BYTES) throw new Error("Peer did not receive the full transfer");
      sample.uploadMbps = NETWORK_BYTES * 8 / Math.max(1, performance.now() - start) / 1000;
      sample.bytes += NETWORK_BYTES;
    } catch (e) { sample.error = e instanceof Error ? e.message : "Probe failed"; }
    finally {
      try {
        db.query("INSERT INTO network_samples VALUES (?, ?, ?, ?)").run(source, target, sample.at, JSON.stringify(sample));
        db.query("DELETE FROM network_samples WHERE rowid NOT IN (SELECT rowid FROM network_samples ORDER BY at DESC LIMIT 512)").run();
      } finally { running = null; }
    }
  }
  const start = (peer: NodeRow) => { void measure(peer).catch(e => console.error("network probe:", e)); };
  const tick = () => {
    nextCheckAt = Date.now() + 120_000;
    if (!automatic() || running) return;
    const now = Date.now();
    const peer = peers().sort((a, b) => (latest(networkName(a.name))?.at ?? 0) - (latest(networkName(b.name))?.at ?? 0)).find(p => now - (latest(networkName(p.name))?.at ?? 0) >= NETWORK_INTERVAL);
    if (peer) start(peer);
  };

  // Shared receiver budget: at most 32 MiB/minute, regardless of caller count.
  let windowAt = 0, allowance = 0;
  const allowed = () => {
    if (Date.now() - windowAt >= 60_000) { windowAt = Date.now(); allowance = 8; }
    if (allowance <= 0) return false;
    allowance--; return true;
  };
  app.get("/api/network", c => c.json(snapshot()));
  app.get("/api/network/ping", c => { c.header("cache-control", "no-store"); return c.json({ protocol: 1, source }); });
  app.get("/api/network/payload", c => {
    if (!allowed()) return c.json({ error: "Network test budget exhausted; retry in a minute" }, 429);
    return new Response(data(), { headers: { "content-type": "application/octet-stream", "content-length": String(NETWORK_BYTES), "cache-control": "no-store, no-transform", "content-encoding": "identity" } });
  });
  app.post("/api/network/payload", async c => {
    if (Number(c.req.header("content-length")) !== NETWORK_BYTES) return c.json({ error: "Expected a 4 MiB payload" }, 413);
    if (!allowed()) return c.json({ error: "Network test budget exhausted; retry in a minute" }, 429);
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.json({ error: "Missing payload" }, 400);
    const timeout = setTimeout(() => void reader.cancel(), TIMEOUT);
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > NETWORK_BYTES) break;
      }
      return bytes === NETWORK_BYTES ? c.json({ bytes }) : c.json({ error: "Incomplete or oversized payload" }, 400);
    } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  });
  app.post("/api/network/test", async c => {
    const body = await c.req.json().catch(() => null);
    const peer = peers().find(p => p.id === body?.target);
    if (!peer) return c.json({ error: "Choose a paired machine" }, 400);
    if (running) return c.json({ error: `Already testing ${running}` }, 409);
    if (Date.now() - (latest(networkName(peer.name))?.at ?? 0) < COOLDOWN) return c.json({ error: "Wait one minute before retesting this connection" }, 429);
    start(peer);
    return c.json({ started: true }, 202);
  });
  return {
    start() {
      if (timer) return;
      nextCheckAt = Date.now() + 30_000 + Math.random() * 90_000;
      boot = setTimeout(tick, nextCheckAt - Date.now()); boot.unref();
      timer = setInterval(tick, 120_000); timer.unref();
    },
    stop() { if (boot) clearTimeout(boot); if (timer) clearInterval(timer); timer = null; nextCheckAt = null; },
    snapshot,
  };
}
