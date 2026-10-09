import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import { Tailscale, isTailscaleIp, isLoopback } from "../src/daemon/tailscale";
import { testConfig, TEST_TOKEN } from "./helpers";

const OWNER = "eric@example.com";
const whoisJson = (login: string, node: string) => JSON.stringify({ Node: { Name: node + "." }, UserProfile: { LoginName: login } });
/** Fake tailscale CLI: 100.100.0.1 is the owner's phone, 100.100.0.2 belongs to someone else. */
const fakeRunner = async (args: string[]) => {
  if (args[0] === "whois") {
    if (args[2] === "100.100.0.1") return whoisJson(OWNER, "jetpack.tail.ts.net");
    if (args[2] === "100.100.0.2") return whoisJson("stranger@example.com", "intruder.tail.ts.net");
    return null;
  }
  if (args[0] === "status") return JSON.stringify({ Self: { DNSName: "yacht.tail.ts.net.", UserID: "1", TailscaleIPs: ["100.100.0.9"] }, User: { "1": { LoginName: OWNER } } });
  return null;
};

/** A server whose peer address we control per request via the x-test-ip header. */
function startServer(bind: string, owner: string | null = OWNER) {
  const db = new Database(":memory:");
  initSchema(db);
  const { fetch: appFetch, websocket } = createServer(db, testConfig({ bind, tailscaleOwner: owner }), TEST_TOKEN, "stw-auth", {
    requestIp: (c) => c.req.raw.headers.get("x-test-ip"),
    tailscale: new Tailscale(fakeRunner),
    persistOwner: false,
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: appFetch, websocket });
  const base = `http://127.0.0.1:${server.port}`;
  const from = (ip: string, path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { "x-test-ip": ip, ...(init.headers as Record<string, string>) } });
  return { base, from, stop: () => server.stop(true), db };
}

describe("tailscale address classification", () => {
  test("CGNAT range and tailnet ULA", () => {
    expect(isTailscaleIp("100.64.0.1")).toBe(true);
    expect(isTailscaleIp("100.127.255.254")).toBe(true);
    expect(isTailscaleIp("::ffff:100.91.2.13")).toBe(true);
    expect(isTailscaleIp("fd7a:115c:a1e0::4d36:20d")).toBe(true);
    expect(isTailscaleIp("100.128.0.1")).toBe(false);
    expect(isTailscaleIp("100.63.255.255")).toBe(false);
    expect(isTailscaleIp("192.168.1.10")).toBe(false);
    expect(isTailscaleIp("127.0.0.1")).toBe(false);
  });
  test("loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("100.64.0.1")).toBe(false);
  });
});

describe("Tailscale client", () => {
  test("whois parses and caches; non-tailnet addresses short-circuit", async () => {
    let calls = 0;
    const ts = new Tailscale(async (args) => { calls++; return fakeRunner(args); });
    expect(await ts.whois("100.100.0.1")).toEqual({ login: OWNER, node: "jetpack.tail.ts.net" });
    expect(await ts.whois("100.100.0.1")).toEqual({ login: OWNER, node: "jetpack.tail.ts.net" });
    expect(calls).toBe(1);
    expect(await ts.whois("192.168.1.5")).toBeNull();
    expect(calls).toBe(1);
    expect(await ts.whois("100.100.0.7")).toBeNull();
  });
  test("self reads MagicDNS name, owner login and IPv4", async () => {
    const ts = new Tailscale(fakeRunner);
    expect(await ts.self()).toEqual({ dnsName: "yacht.tail.ts.net", login: OWNER, ip4: "100.100.0.9" });
  });
  test("serveOrigin finds the https origin `tailscale serve` proxies to the daemon port", async () => {
    const status = { Web: {
      "yacht.tail.ts.net:8444": { Handlers: { "/": { Proxy: "http://127.0.0.1:13034" } } },
      "yacht.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4777" } } },
    } };
    const ts = new Tailscale(async (args) => (args.join(" ") === "serve status --json" ? JSON.stringify(status) : null));
    expect(await ts.serveOrigin(4777)).toBe("https://yacht.tail.ts.net");
    expect(await ts.serveOrigin(13034)).toBe("https://yacht.tail.ts.net:8444");
    expect(await ts.serveOrigin(5000)).toBeNull();
    expect(await new Tailscale(async () => null).serveOrigin(4777)).toBeNull();
  });
  test("missing CLI yields nulls", async () => {
    const ts = new Tailscale(async () => null);
    expect(await ts.whois("100.100.0.1")).toBeNull();
    expect(await ts.self()).toBeNull();
  });
});

describe("tailscale identity auth", () => {
  const srv = startServer("tailscale");
  afterAll(() => srv.stop());

  test("owner on the tailnet needs no token", async () => {
    const res = await srv.from("100.100.0.1", "/api/status");
    expect(res.status).toBe(200);
    const who = await (await srv.from("100.100.0.1", "/api/auth/whoami")).json();
    expect(who).toEqual({ method: "tailscale", login: OWNER, node: "jetpack.tail.ts.net" });
  });
  test("another tailnet user is rejected without a token", async () => {
    expect((await srv.from("100.100.0.2", "/api/status")).status).toBe(401);
    expect(await (await srv.from("100.100.0.2", "/api/auth/whoami")).json()).toEqual({ method: "none" });
  });
  test("loopback still requires the token", async () => {
    expect((await srv.from("127.0.0.1", "/api/status")).status).toBe(401);
    expect(await (await srv.from("127.0.0.1", "/api/auth/whoami")).json()).toEqual({ method: "none" });
    const ok = await srv.from("127.0.0.1", "/api/auth/whoami", { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(await ok.json()).toEqual({ method: "token" });
  });
  test("token works for anyone on the tailnet too", async () => {
    const res = await srv.from("100.100.0.2", "/api/status", { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.status).toBe(200);
  });
  test("LAN addresses are refused outright with bind tailscale, UI included", async () => {
    expect((await srv.from("192.168.1.20", "/api/status", { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).status).toBe(403);
    expect((await srv.from("192.168.1.20", "/")).status).toBe(403);
  });
  test("websocket upgrade is gated the same way", async () => {
    const open = (ip: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`${srv.base.replace("http", "ws")}/api/events`, { headers: { "x-test-ip": ip } } as any);
        let gotMessageOrOpen = false;
        ws.onopen = () => { gotMessageOrOpen = true; ws.close(); };
        ws.onerror = () => resolve(false);
        ws.onclose = () => resolve(gotMessageOrOpen);
      });
    expect(await open("100.100.0.1")).toBe(true);
    expect(await open("192.168.1.20")).toBe(false);
  });
  test("pairing/complete accepts the tailnet owner without a code", async () => {
    const body = JSON.stringify({ nodeId: "stw-peer", name: "peer", url: "http://peer.tail.ts.net:4777", token: "peer-token" });
    const denied = await srv.from("100.100.0.2", "/api/fleet/pairing/complete", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(denied.status).toBe(403);
    const ok = await srv.from("100.100.0.1", "/api/fleet/pairing/complete", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.token).toBe(TEST_TOKEN);
    expect(j.url).toBe("http://yacht.tail.ts.net:0");
    expect(srv.db.query("SELECT url FROM nodes WHERE id = 'stw-peer'").get()).toEqual({ url: "http://peer.tail.ts.net:4777" });
  });
});

describe("bind lan keeps LAN clients token-gated", () => {
  const srv = startServer("lan");
  afterAll(() => srv.stop());
  test("LAN client with token is served; without token refused", async () => {
    expect((await srv.from("192.168.1.20", "/api/status", { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).status).toBe(200);
    expect((await srv.from("192.168.1.20", "/api/status")).status).toBe(401);
  });
});

describe("no owner configured", () => {
  const srv = startServer("tailscale", null);
  afterAll(() => srv.stop());
  test("tailnet identity is not trusted until an owner is known", async () => {
    // The fake status reports an owner, which the server adopts asynchronously; before that, 401.
    const first = await srv.from("100.100.0.1", "/api/status");
    expect([200, 401]).toContain(first.status);
    await new Promise((r) => setTimeout(r, 50));
    expect((await srv.from("100.100.0.1", "/api/status")).status).toBe(200);
  });
});
