// Fleet v1: pragmatic node pairing + request proxying.
//
// Pairing exchanges each node's API token over a direct HTTP call, gated by a
// short-lived 6-digit code the user carries between the two UIs. This trusts
// the local network during the pairing window; the ed25519 mutual-auth
// handshake from docs/FLEET.md replaces it in a later milestone.
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { networkInterfaces } from "os";
import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import type { CyberdeckConfig } from "../config";
import { currentCommit, nudgePeer, maybeSelfUpdate } from "../updater";
import type { Tailscale } from "../tailscale";

export type NodeRow = {
  id: string;
  name: string;
  url: string;
  token: string;
  added_at: number;
  last_seen: number | null;
};

const PAIRING_TTL_MS = 5 * 60 * 1000;
let pairing: { code: string; expiresAt: number } | null = null;

function codeMatches(given: string): boolean {
  if (!pairing || Date.now() > pairing.expiresAt) return false;
  const a = Buffer.from(pairing.code);
  const b = Buffer.from(String(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

export async function peerFetch(node: NodeRow, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${node.url}${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${node.token}` },
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
}

export function registerFleetRoutes(
  app: Hono,
  db: Database,
  cfg: CyberdeckConfig,
  nodeId: string,
  myToken: string,
  upgradeWebSocket: any,
  extras: { tailscale?: Tailscale; authedViaTailscale?: (c: { req: { raw: Request } }) => boolean } = {}
) {
  const getNode = (id: string): NodeRow | null =>
    (db.query("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow) ?? null;
  const tailnetInfo = async () => (extras.tailscale ? await extras.tailscale.self() : null);

  /** URL peers should dial us at: the MagicDNS name when on a tailnet, else the LAN address closest to the peer. */
  const selfUrl = async (peerUrl?: string, dialedAs?: string): Promise<string> => {
    // Bound to one explicit address (127.0.0.1 in tests, or a pinned LAN IP): that is the
    // only place peers can reach us, so never advertise the tailnet name or another interface.
    // `dialedAs` is the Host a peer just reached us at, which beats cfg.port when that is 0 (ephemeral).
    if (cfg.bind !== "tailscale" && cfg.bind !== "lan") return dialedAs ? `http://${dialedAs}` : `http://${cfg.bind}:${cfg.port}`;
    const self = await tailnetInfo();
    if (self?.dnsName) return `http://${self.dnsName}:${cfg.port}`;
    const myUrls = lanUrls(cfg.port);
    const peerHost = peerUrl ? new URL(peerUrl).hostname : "";
    return (
      myUrls.find((u) => new URL(u).hostname.split(".").slice(0, 3).join(".") === peerHost.split(".").slice(0, 3).join(".")) ??
      myUrls[0] ??
      `http://127.0.0.1:${cfg.port}`
    );
  };
  const upsertNode = (id: string, name: string, url: string, token: string) =>
    db.query(
      `INSERT INTO nodes (id, name, url, token, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, token=excluded.token`
    ).run(id, name, url, token, Date.now());

  app.get("/api/fleet/self", async (c) => {
    const self = await tailnetInfo();
    return c.json({ nodeId, name: cfg.nodeName, port: cfg.port, urls: lanUrls(cfg.port), url: await selfUrl(), tailscale: self });
  });

  app.post("/api/fleet/pairing/start", (c) => {
    pairing = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
    return c.json({ code: pairing.code, expiresAt: pairing.expiresAt, urls: lanUrls(cfg.port) });
  });

  // Called BY the other node. Gated by the one-time code, or by the caller
  // being the node owner on the tailnet (identified by `tailscale whois`).
  app.post("/api/fleet/pairing/complete", async (c) => {
    const body = await c.req.json();
    const viaCode = codeMatches(body.code);
    if (!viaCode && !extras.authedViaTailscale?.(c)) return c.json({ error: "invalid or expired pairing code" }, 403);
    if (viaCode) pairing = null; // single use
    if (!body.nodeId || !body.url || !body.token) return c.json({ error: "missing fields" }, 400);
    upsertNode(body.nodeId, String(body.name ?? "node"), String(body.url), String(body.token));
    return c.json({ nodeId, name: cfg.nodeName, token: myToken, urls: lanUrls(cfg.port), url: await selfUrl(String(body.url), c.req.header("host")) });
  });

  // Initiate pairing from this side: we call the peer's /complete. With a
  // code this works on any network; without one (pair-direct) the peer must
  // see us as its owner on the tailnet.
  const pairWith = async (peerUrl: string, code: string) => {
    if (!/^https?:\/\//.test(peerUrl)) return { status: 400, body: { error: "url must start with http://" } };
    const myUrl = await selfUrl(peerUrl);
    let res: Response;
    try {
      res = await fetch(`${peerUrl}/api/fleet/pairing/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, nodeId, name: cfg.nodeName, url: myUrl, token: myToken }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { status: 502, body: { error: `could not reach ${peerUrl}: ${err instanceof Error ? err.message : err}` } };
    }
    const peer = await res.json();
    if (!res.ok) return { status: 502, body: { error: peer.error ?? `pairing failed (${res.status})` } };
    const url = typeof peer.url === "string" && peer.url ? peer.url : peerUrl;
    upsertNode(peer.nodeId, String(peer.name ?? "node"), url, String(peer.token));
    return { status: 200, body: { paired: { id: peer.nodeId, name: peer.name, url } } };
  };
  app.post("/api/fleet/pair", async (c) => {
    const body = await c.req.json(); // { url, code }
    const r = await pairWith(String(body.url ?? "").replace(/\/+$/, ""), String(body.code ?? ""));
    return c.json(r.body, r.status as any);
  });
  app.post("/api/fleet/pair-direct", async (c) => {
    const body = await c.req.json(); // { url }
    const r = await pairWith(String(body.url ?? "").replace(/\/+$/, ""), "");
    return c.json(r.body, r.status as any);
  });

  app.get("/api/fleet/nodes", async (c) => {
    const rows = db.query("SELECT id, name, url, added_at, last_seen FROM nodes ORDER BY name").all() as Omit<NodeRow, "token">[];
    // Probe reachability + pull summary stats concurrently. The race timer is
    // a HARD bound: AbortSignal cannot cancel a stuck DNS/mDNS lookup (e.g. an
    // offline peer.local hostname), which would otherwise hang this request.
    const nodes = await Promise.all(
      rows.map(async (r) => {
        try {
          const node = getNode(r.id)!;
          const status = await Promise.race([
            (async () => {
              const res = await peerFetch(node, "/api/status", { signal: AbortSignal.timeout(3000) });
              if (!res.ok) throw new Error(String(res.status));
              return res.json();
            })(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 3500)),
          ]);
          db.query("UPDATE nodes SET last_seen = ? WHERE id = ?").run(Date.now(), r.id);
          // Fleet convergence: a peer on a different commit gets nudged to
          // update (it no-ops if it is not behind origin), and we check
          // ourselves too. Both are rate-limited.
          if (cfg.autoUpdate && status.commit && status.commit !== (await currentCommit())) {
            nudgePeer(getNode(r.id)!);
            maybeSelfUpdate(`peer ${r.name} is on ${status.commit}`);
          }
          return { ...r, online: true, status };
        } catch {
          return { ...r, online: false, status: null };
        }
      })
    );
    return c.json({ self: { nodeId, name: cfg.nodeName, urls: lanUrls(cfg.port), commit: await currentCommit() }, nodes });
  });

  app.delete("/api/fleet/nodes/:id", (c) => {
    db.query("DELETE FROM nodes WHERE id = ?").run(c.req.param("id"));
    return c.json({ removed: true });
  });

  // HTTP proxy: /api/nodes/:id/proxy/<rest> -> peer /api/<rest>
  app.all("/api/nodes/:id/proxy/*", async (c) => {
    const node = getNode(c.req.param("id"));
    if (!node) return c.json({ error: "unknown node" }, 404);
    const rest = c.req.path.split("/proxy/")[1] ?? "";
    const qs = new URL(c.req.url).search;
    // Strip our token from forwarded query strings; peer auth is via header.
    const cleanQs = qs ? "?" + new URLSearchParams([...new URLSearchParams(qs.slice(1))].filter(([k]) => k !== "token")).toString() : "";
    try {
      const fwdHeaders: Record<string, string> = {
        "content-type": c.req.header("content-type") ?? "application/json",
      };
      const range = c.req.header("range");
      if (range) fwdHeaders["range"] = range;
      const res = await peerFetch(node, `/api/${rest}${cleanQs}`, {
        method: c.req.method,
        headers: fwdHeaders,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.arrayBuffer(),
        signal: AbortSignal.timeout(60_000),
      });
      const outHeaders: Record<string, string> = {
        "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      };
      for (const h of ["content-disposition", "content-range", "accept-ranges", "content-length"]) {
        const v = res.headers.get(h);
        if (v) outHeaders[h] = v;
      }
      return new Response(res.body, { status: res.status, headers: outHeaders });
    } catch (err) {
      return c.json({ error: `proxy to ${node.name} failed: ${err instanceof Error ? err.message : err}` }, 502);
    }
  });

  // WebSocket proxies: pipe browser <-> a peer WebSocket endpoint.
  const proxyWs = (peerPath: (c: any, node: NodeRow) => string) =>
    upgradeWebSocket((c: any) => {
      const node = getNode(c.req.param("id"));
      let peer: WebSocket | null = null;
      const pending: string[] = [];
      return {
        onOpen(_ev: unknown, ws: { send: (s: string) => void; close: () => void }) {
          if (!node) {
            ws.send(JSON.stringify({ t: "data", data: "\r\nunknown node\r\n" }));
            ws.close();
            return;
          }
          peer = new WebSocket(node.url.replace(/^http/, "ws") + peerPath(c, node));
          peer.onopen = () => {
            for (const msg of pending.splice(0)) peer!.send(msg);
          };
          peer.onmessage = (m) => ws.send(String(m.data));
          peer.onclose = () => ws.close();
          peer.onerror = () => {
            ws.send(JSON.stringify({ t: "data", data: `\r\ncould not reach ${node.name}\r\n` }));
            ws.close();
          };
        },
        onMessage(ev: { data: unknown }) {
          const msg = String(ev.data);
          if (peer && peer.readyState === WebSocket.OPEN) peer.send(msg);
          else pending.push(msg);
        },
        onClose() {
          try {
            peer?.close();
          } catch {}
          peer = null;
        },
      };
    });
  // Ephemeral terminal on a peer (/api/term) and attach to a peer's live session.
  app.get("/api/nodes/:id/term", proxyWs((c, node) => { const cwd = c.req.query("cwd"); return `/api/term?token=${encodeURIComponent(node.token)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`; }));
  // Remote browser screencast on a peer (frames and input are JSON text frames, so the string pipe is enough).
  app.get("/api/nodes/:id/browser/:profile/stream", proxyWs((c, node) => `/api/browser/${encodeURIComponent(c.req.param("profile"))}/stream?token=${encodeURIComponent(node.token)}`));
  app.get("/api/nodes/:id/sessions/:sid/attach", proxyWs((c, node) => { const q = new URLSearchParams({ token: node.token }); for (const k of ["cols", "rows"]) { const v = c.req.query(k); if (v) q.set(k, v); } return `/api/sessions/${encodeURIComponent(c.req.param("sid"))}/attach?${q}`; }));
}
