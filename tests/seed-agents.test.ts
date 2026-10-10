// Seed agents UI host routes (src/daemon/api/seed-agents.ts): the browser signs through the daemon
// and reaches the agents server through its cookie-gated proxy. A fake agents server verifies every
// envelope the way the real one does, and echoes WebSocket frames byte for byte.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import * as blobs from "@seed-hypermedia/client/blobs";
import * as cbor from "@seed-hypermedia/client/cbor";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import { Tailscale } from "../src/daemon/tailscale";
import { agentsEnvelopeProblem, seedAgentsCookieAuth, seedAgentsCookieValue } from "../src/daemon/api/seed-agents";
import { testConfig, TEST_TOKEN, tmpHomeDir } from "./helpers";

const SEED_HEX = "5e".repeat(32);
process.env.CYBERDECK_SEED_KEY_SEED = SEED_HEX;
const KEY = blobs.nobleKeyPairFromSeed(Uint8Array.from(Buffer.from(SEED_HEX, "hex")));
const PRINCIPAL = blobs.principalToString(KEY.principal);
const PAIRING_KEY = "casework-pairing-key-for-seed-agents-tests";

/** What the agents UI builds before asking for a signature: an AgentsAction with a zeroed signature. */
function unsigned(action: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { type: "AgentsAction", signer: KEY.principal, sig: new Uint8Array(64), account: KEY.principal, protocol: 3, action: { ...action, ts: Date.now() }, ...over };
}
const encode = (value: unknown) => new Uint8Array(cbor.encode(value as any));

function fakeUpstreams() {
  const actions: any[] = [];
  const hm = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => Response.json({ path: new URL(req.url).pathname, search: new URL(req.url).search }),
  });
  const agents = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/agents/ws") return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      if (url.pathname === "/agents/api/health") return Response.json({ status: "ok", protocol: 3, hmServerUrl: `http://127.0.0.1:${hm.port}` });
      if (url.pathname === "/api/health") return Response.json({ status: "ok", protocol: 3 });
      if (url.pathname !== "/api/message" || req.method !== "POST") return new Response("nope", { status: 404 });
      const env: any = cbor.decode(new Uint8Array(await req.arrayBuffer()));
      await blobs.nativeCryptoReady;
      if (!blobs.verify(env)) return new Response(cbor.encode({ _: "Error", message: "Invalid signature" }) as unknown as BodyInit, { status: 401 });
      actions.push(env.action);
      return new Response(cbor.encode({ _: `${env.action._}Response`, echoed: env.action._ }) as unknown as BodyInit, { headers: { "content-type": "application/cbor", "x-agents-protocol": "3" } });
    },
    websocket: { message: (ws, message) => void ws.send(message) },
  });
  return { url: `http://127.0.0.1:${agents.port}`, actions, stop: () => { agents.stop(true); hm.stop(true); } };
}

let up: ReturnType<typeof fakeUpstreams>;
let base: string, wsBase: string, stop: () => void, cleanup: () => void;
beforeAll(() => {
  up = fakeUpstreams();
  const home = tmpHomeDir("seed-agents");
  cleanup = home.cleanup;
  const db = new Database(":memory:");
  initSchema(db);
  const s = createServer(db, testConfig({ seed: { agentsUrl: up.url } }), TEST_TOKEN, "stw-test", {
    caseworkKey: PAIRING_KEY,
    caseworkExperiencesDir: join(import.meta.dir, "fixtures", "casework"),
    persistOwner: false,
    cloudSync: false,
    tailscale: new Tailscale(async () => null),
    seed: { home: home.dir, companionFile: join(home.dir, "companion.json"), runtimeFile: join(home.dir, "runtime.json") },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: s.fetch, websocket: s.websocket });
  base = `http://127.0.0.1:${server.port}`;
  wsBase = `ws://127.0.0.1:${server.port}`;
  stop = () => { s.sessions.close(); void server.stop(true); };
});
afterAll(() => { stop(); up.stop(); cleanup(); });

const authed = (path: string, init: RequestInit = {}, token = TEST_TOKEN) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
const cookie = () => `cyberdeck-seed-agents=${seedAgentsCookieValue(TEST_TOKEN)}`;
const sign = (data: Uint8Array, token = TEST_TOKEN) => authed("/api/seed-agents/sign", { method: "POST", body: JSON.stringify({ data: Buffer.from(data).toString("base64") }) }, token);

describe("envelope check", () => {
  test("accepts exactly an unsigned AgentsAction for this identity", () => {
    expect(agentsEnvelopeProblem(encode(unsigned({ _: "ListAgents" })), KEY.principal)).toBeNull();
  });
  test("refuses anything else", () => {
    const other = blobs.nobleKeyPairFromSeed(new Uint8Array(32).fill(9)).principal;
    expect(agentsEnvelopeProblem(encode({ ...unsigned({ _: "X" }), type: "Change" }), KEY.principal)).toContain("only AgentsAction");
    expect(agentsEnvelopeProblem(encode(unsigned({ _: "X" }, { account: other })), KEY.principal)).toContain("account");
    expect(agentsEnvelopeProblem(encode(unsigned({ _: "X" }, { signer: other })), KEY.principal)).toContain("signer");
    expect(agentsEnvelopeProblem(encode(unsigned({ _: "X" }, { sig: new Uint8Array(64).fill(1) })), KEY.principal)).toContain("zero");
    expect(agentsEnvelopeProblem(encode(unsigned({})), KEY.principal)).toContain("action");
    expect(agentsEnvelopeProblem(new Uint8Array([1, 2, 3]), KEY.principal)).not.toBeNull();
    const trailing = new Uint8Array([...encode(unsigned({ _: "X" })), 0]);
    expect(agentsEnvelopeProblem(trailing, KEY.principal)).not.toBeNull();
  });
  test("the cookie opens only the proxy paths", () => {
    const c = cookie();
    expect(seedAgentsCookieAuth("/api/seed-agents/proxy/api/message", c, TEST_TOKEN)).toBe(true);
    expect(seedAgentsCookieAuth("/api/seed-agents/hm/api/Resource", c, TEST_TOKEN)).toBe(true);
    expect(seedAgentsCookieAuth("/api/seed-agents/sign", c, TEST_TOKEN)).toBe(false);
    expect(seedAgentsCookieAuth("/api/seed-agents/proxyx", c, TEST_TOKEN)).toBe(false);
    expect(seedAgentsCookieAuth("/api/term", c, TEST_TOKEN)).toBe(false);
    expect(seedAgentsCookieAuth("/api/seed-agents/proxy/x", `${c}x`, TEST_TOKEN)).toBe(false);
    expect(seedAgentsCookieAuth("/api/seed-agents/proxy/x", c, "another-token")).toBe(false);
  });
});

describe("session", () => {
  test("names the signing account and sets the proxy cookie", async () => {
    const r = await authed("/api/seed-agents/session");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ available: true, accountUid: PRINCIPAL, reachable: true, serverPath: "/api/seed-agents/proxy", hmPath: "/api/seed-agents/hm" });
    const set = r.headers.get("set-cookie") ?? "";
    expect(set).toContain(cookie());
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/api/seed-agents/");
  });
  test("is not for the Casework pairing key or anonymous callers", async () => {
    expect((await authed("/api/seed-agents/session", {}, PAIRING_KEY)).status).toBe(403);
    expect((await fetch(`${base}/api/seed-agents/session`)).status).toBe(401);
  });
});

describe("signing", () => {
  test("signs an agents envelope the agents server accepts, through the proxy", async () => {
    const env = unsigned({ _: "ListAgents" });
    const data = encode(env);
    const r = await sign(data);
    expect(r.status).toBe(200);
    const sig = new Uint8Array(Buffer.from((await r.json()).sig, "base64"));
    expect(sig.length).toBe(64);
    const res = await fetch(`${base}/api/seed-agents/proxy/api/message`, { method: "POST", headers: { cookie: cookie(), "content-type": "application/cbor" }, body: cbor.encode({ ...env, sig }) as unknown as BodyInit });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-agents-protocol")).toBe("3");
    expect(cbor.decode(new Uint8Array(await res.arrayBuffer()))).toMatchObject({ _: "ListAgentsResponse" });
    expect(up.actions.at(-1)).toMatchObject({ _: "ListAgents" });
  });
  test("refuses other blobs, other accounts, and callers without full auth", async () => {
    expect((await sign(encode({ ...unsigned({ _: "X" }), type: "Comment" }))).status).toBe(400);
    expect((await sign(encode(unsigned({ _: "X" }, { account: new Uint8Array(34) })))).status).toBe(400);
    expect((await sign(encode(unsigned({ _: "ListAgents" })), PAIRING_KEY)).status).toBe(403);
    const viaCookie = await fetch(`${base}/api/seed-agents/sign`, { method: "POST", headers: { cookie: cookie(), "content-type": "application/json" }, body: JSON.stringify({ data: "" }) });
    expect(viaCookie.status).toBe(401);
  });
});

describe("proxy", () => {
  test("needs the cookie (or full auth)", async () => {
    expect((await fetch(`${base}/api/seed-agents/proxy/agents/api/health`)).status).toBe(401);
    expect((await fetch(`${base}/api/seed-agents/proxy/agents/api/health`, { headers: { cookie: cookie() } })).status).toBe(200);
    expect((await authed("/api/seed-agents/proxy/agents/api/health")).status).toBe(200);
    expect((await fetch(`${base}/api/status`, { headers: { cookie: cookie() } })).status).toBe(401);
  });
  test("forwards the Seed API to the server the agents server publishes to", async () => {
    const r = await fetch(`${base}/api/seed-agents/hm/api/Resource?id=hm%3A%2F%2Fz6Mk`, { headers: { cookie: cookie() } });
    expect(await r.json()).toEqual({ path: "/api/Resource", search: "?id=hm%3A%2F%2Fz6Mk" });
  });
  test("relays the live-update socket's binary frames unchanged", async () => {
    const ws = new WebSocket(`${wsBase}/api/seed-agents/proxy/agents/ws`, { headers: { cookie: cookie() } } as any);
    ws.binaryType = "arraybuffer";
    const frame = encode(unsigned({ _: "Subscribe" }));
    const echoed = await new Promise<Uint8Array>((resolve, reject) => {
      ws.onopen = () => ws.send(frame);
      ws.onmessage = (m) => resolve(new Uint8Array(m.data as ArrayBuffer));
      ws.onerror = () => reject(new Error("socket error"));
      setTimeout(() => reject(new Error("no echo")), 5000);
    });
    ws.close();
    expect(Array.from(echoed)).toEqual(Array.from(frame));
  });
  test("refuses the socket without the cookie", async () => {
    const closed = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${wsBase}/api/seed-agents/proxy/agents/ws`);
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("error");
      ws.onclose = () => resolve("closed");
    });
    expect(closed).not.toBe("open");
  });
});
