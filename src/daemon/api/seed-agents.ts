// Seed agents UI host: everything the browser needs to run Seed's own agents UI
// (@seed-hypermedia/agents-ui) against this node's agents server, without ever holding a key.
//
//   GET  /api/seed-agents/session        who signs (the bridge's vault identity) + where to send requests;
//                                        sets the cookie that opens the two proxies below
//   POST /api/seed-agents/sign           Ed25519 signature over an unsigned AgentsAction envelope, nothing else
//   *    /api/seed-agents/proxy/*        reverse proxy to the agents server (HTTP + the /agents/ws socket)
//   *    /api/seed-agents/hm/*           reverse proxy to the Seed HTTP API the agents server publishes to
//
// The agents UI calls the proxies with plain fetch/WebSocket (no Authorization header), so they
// accept a same-origin HttpOnly cookie as well as the normal auth; see `seedAgentsCookieAuth`.
import { createHmac, timingSafeEqual } from "crypto";
import type { Hono } from "hono";
import * as blobs from "@seed-hypermedia/client/blobs";
import * as cbor from "@seed-hypermedia/client/cbor";
import type { SeedBridge } from "../seed";

export const SEED_AGENTS_PREFIX = "/api/seed-agents";
const PROXY = `${SEED_AGENTS_PREFIX}/proxy`;
const HM = `${SEED_AGENTS_PREFIX}/hm`;
const COOKIE = "cyberdeck-seed-agents";
const PUBLIC_HM_API = "https://hyper.media";
const HM_URL_TTL_MS = 60_000;
const PROXY_TIMEOUT_MS = 120_000;

/** Request headers worth passing upstream; everything else (cookies, auth, hop-by-hop) stays here. */
const FORWARD_REQUEST = ["content-type", "accept", "x-agents-protocol", "range", "if-none-match"];
// No content-length/encoding: fetch hands us the decoded body, so the upstream length would be wrong.
const FORWARD_RESPONSE = ["content-type", "cache-control", "etag", "x-agents-protocol", "content-range", "accept-ranges", "last-modified"];

/** The cookie value: derived from the node token, so it rotates with it and needs no storage. */
export function seedAgentsCookieValue(token: string): string {
  return createHmac("sha256", token).update("cyberdeck seed agents proxy").digest("base64url");
}

/** True when a request to one of the proxies carries the cookie this node issued. */
export function seedAgentsCookieAuth(path: string, cookieHeader: string | undefined, token: string): boolean {
  if (!path.startsWith(`${PROXY}/`) && !path.startsWith(`${HM}/`) && path !== PROXY && path !== HM) return false;
  const value = cookieHeader?.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) return false;
  const expected = Buffer.from(seedAgentsCookieValue(token));
  const given = Buffer.from(value);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Checks that `data` is exactly an unsigned AgentsAction envelope for `principal` (signature
 * zeroed, signer and account both this identity) and returns the reason it is not, or null.
 * The signing route signs nothing else: not documents, not capabilities, not other accounts.
 */
export function agentsEnvelopeProblem(data: Uint8Array, principal: Uint8Array): string | null {
  let envelope: any;
  try {
    envelope = cbor.decode(data);
  } catch {
    return "not DAG-CBOR";
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return "not an envelope";
  if (envelope.type !== "AgentsAction") return "only AgentsAction envelopes are signed";
  const same = (a: unknown) => a instanceof Uint8Array && a.length === principal.length && a.every((b, i) => b === principal[i]);
  if (!same(envelope.signer)) return "signer is not this node's Seed identity";
  if (!same(envelope.account)) return "account is not this node's Seed identity";
  if (!(envelope.sig instanceof Uint8Array) || envelope.sig.length !== 64 || envelope.sig.some((b: number) => b !== 0)) return "signature field must be 64 zero bytes";
  if (!envelope.action || typeof envelope.action !== "object" || typeof envelope.action._ !== "string") return "missing action";
  // Byte-exact: what we sign must be what the server will re-encode and verify.
  const canonical = new Uint8Array(cbor.encode(envelope));
  if (canonical.length !== data.length || canonical.some((b, i) => b !== data[i])) return "not canonical DAG-CBOR";
  return null;
}

type Deps = {
  token: string;
  upgradeWebSocket: any;
  isFullAuth: (c: any) => boolean;
  fetch?: typeof fetch;
};

export function registerSeedAgentsRoutes(app: Hono, seed: SeedBridge, deps: Deps) {
  const doFetch = deps.fetch ?? fetch;
  const agentsUrl = () => seed.config.agentsUrl.replace(/\/+$/, "");
  let hmUrl: { url: string; at: number } | null = null;
  // The agents server says which Seed HTTP API it publishes to (on a laptop: the desktop app's).
  // Names, avatars and documents the UI shows resolve there, so local content shows up too.
  const hmApiUrl = async (): Promise<string> => {
    if (hmUrl && Date.now() - hmUrl.at < HM_URL_TTL_MS) return hmUrl.url;
    let url = PUBLIC_HM_API;
    try {
      const res = await doFetch(`${agentsUrl()}/agents/api/health`, { signal: AbortSignal.timeout(3000) });
      const health = (await res.json()) as { hmServerUrl?: string };
      if (health.hmServerUrl && /^https?:\/\//.test(health.hmServerUrl)) url = health.hmServerUrl.replace(/\/+$/, "");
    } catch {}
    hmUrl = { url, at: Date.now() };
    return url;
  };

  app.get(`${SEED_AGENTS_PREFIX}/session`, async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const signer = await seed.signer();
    const health = await seed.health();
    const error = signer ? undefined : (await seed.status().catch(() => null))?.identity.error ?? "Seed identity unavailable";
    const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
    c.header(
      "set-cookie",
      `${COOKIE}=${seedAgentsCookieValue(deps.token)}; Path=${SEED_AGENTS_PREFIX}/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
    );
    return c.json({
      available: Boolean(signer),
      accountUid: signer ? blobs.principalToString(signer.principal) : null,
      identity: seed.config.identity,
      agentsUrl: agentsUrl(),
      error,
      reachable: health.ok,
      serverPath: PROXY,
      hmPath: HM,
    });
  });

  app.post(`${SEED_AGENTS_PREFIX}/sign`, async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || typeof body.data !== "string" || body.data.length > 8_000_000) return c.json({ error: "data (base64) required" }, 400);
    const signer = await seed.signer();
    if (!signer) return c.json({ error: "Seed identity unavailable" }, 503);
    const data = new Uint8Array(Buffer.from(body.data, "base64"));
    const problem = agentsEnvelopeProblem(data, signer.principal);
    if (problem) return c.json({ error: `refused to sign: ${problem}` }, 400);
    const sig = await signer.sign(data);
    return c.json({ sig: Buffer.from(sig).toString("base64") });
  });

  // The agents server's live-update socket. Frames are binary DAG-CBOR both ways (signed Subscribe up, events down).
  app.get(
    `${PROXY}/agents/ws`,
    deps.upgradeWebSocket(() => {
      let upstream: WebSocket | null = null;
      const pending: (string | ArrayBuffer | Uint8Array)[] = [];
      return {
        onOpen(_ev: unknown, ws: { send: (d: string | ArrayBuffer | Uint8Array) => void; close: (code?: number, reason?: string) => void }) {
          upstream = new WebSocket(`${agentsUrl().replace(/^http/, "ws")}/agents/ws`);
          upstream.binaryType = "arraybuffer";
          upstream.onopen = () => {
            for (const frame of pending.splice(0)) upstream!.send(frame);
          };
          upstream.onmessage = (m) => ws.send(m.data as string | ArrayBuffer);
          upstream.onclose = (e) => ws.close(e.code === 1005 || e.code === 1006 ? 1011 : e.code, e.reason);
          upstream.onerror = () => ws.close(1011, "agents server unreachable");
        },
        onMessage(ev: { data: unknown }) {
          const frame = ev.data instanceof ArrayBuffer || ev.data instanceof Uint8Array ? ev.data : String(ev.data);
          if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(frame);
          else pending.push(frame);
        },
        onClose() {
          try {
            upstream?.close();
          } catch {}
          upstream = null;
        },
      };
    }),
  );

  const proxy = (base: () => string | Promise<string>, prefix: string) => async (c: any) => {
    const url = new URL(c.req.url);
    const target = `${await base()}${url.pathname.slice(prefix.length) || "/"}${url.search}`;
    const headers = new Headers();
    for (const name of FORWARD_REQUEST) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const method = c.req.method;
    let res: Response;
    try {
      res = await doFetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer(),
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
    } catch (e) {
      return c.json({ error: `upstream unreachable: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
    const out = new Headers();
    for (const name of FORWARD_RESPONSE) {
      const value = res.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(res.body, { status: res.status, headers: out });
  };
  app.all(`${PROXY}/*`, proxy(agentsUrl, PROXY));
  app.all(`${HM}/*`, proxy(hmApiUrl, HM));
}
