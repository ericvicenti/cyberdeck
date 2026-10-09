import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initSchema } from "../src/daemon/db";
import { registerNetworkRoutes, readNetworkBytes } from "../src/daemon/api/network";
import { NETWORK_BYTES } from "../src/shared/network";
import { testConfig, startTestServer } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });
function node(name: string, broken = false) {
  const db = new Database(":memory:"); initSchema(db);
  const app = new Hono();
  app.use("*", async (c, next) => { if (c.req.header("authorization") !== "Bearer private-test") return c.json({ error: "unauthorized" }, 401); await next(); });
  if (broken) app.get("/api/network/payload", () => new Response("short", { headers: { "content-type": "application/octet-stream" } }));
  const network = registerNetworkRoutes(app, db, testConfig({ nodeName: name, fleetDir: null }));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  cleanup.push(() => { network.stop(); server.stop(true); db.close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}api/network${path}`, { ...init, headers: { authorization: "Bearer private-test", ...init.headers } });
  return { db, server, api, network };
}
function pair(a: ReturnType<typeof node>, b: ReturnType<typeof node>) {
  a.db.query("INSERT INTO nodes (id,name,url,token,added_at) VALUES (?,?,?,?,?)").run("peer", "Sentinel", b.server.url.toString().replace(/\/$/, ""), "private-test", Date.now());
}
async function finished(n: ReturnType<typeof node>) {
  const deadline = Date.now() + 5000;
  while (n.network.snapshot().running && Date.now() < deadline) await Bun.sleep(10);
  expect(n.network.snapshot().running).toBeNull();
  return n.network.snapshot().samples[0];
}
test("measures both directions from source, persists samples, hides credentials and enforces cooldown", async () => {
  const a = node("Yacht"), b = node("Sentinel"); pair(a, b);
  const res = await a.api("/test", { method: "POST", body: JSON.stringify({ target: "peer" }) });
  expect(res.status).toBe(202);
  const sample = await finished(a);
  expect(sample.source).toBe("yacht"); expect(sample.target).toBe("sentinel");
  expect(sample.bytes).toBe(NETWORK_BYTES * 2);
  expect(sample.uploadMbps).toBeGreaterThan(0); expect(sample.downloadMbps).toBeGreaterThan(0);
  expect(sample.latencyMs).toBeGreaterThan(0); expect(sample.error).toBeUndefined();
  expect(await (await a.api("")).text()).not.toContain("private-test");
  expect((await a.api("/test", { method: "POST", body: JSON.stringify({ target: "peer" }) })).status).toBe(429);
  const restarted = registerNetworkRoutes(new Hono(), a.db, testConfig({ nodeName: "Yacht" }));
  expect(restarted.snapshot().samples[0]).toEqual(sample);
});
test("partial transfer records a failure without inventing throughput", async () => {
  const a = node("Yacht"), b = node("Sentinel", true); pair(a, b);
  await a.api("/test", { method: "POST", body: JSON.stringify({ target: "peer" }) });
  const s = await finished(a);
  expect(s.error).toBe("incomplete transfer");
  expect(s.downloadMbps).toBeNull(); expect(s.uploadMbps).toBeNull(); expect(s.bytes).toBe(0);
});
test("rejects arbitrary destinations and malformed bodies", async () => {
  const a = node("Yacht");
  for (const body of ['{', JSON.stringify({ target: "https://example.com" })]) {
    expect((await a.api("/test", { method: "POST", body })).status).toBe(400);
  }
});
test("receiver caps payload size and minute budget", async () => {
  const a = node("Yacht");
  expect((await a.api("/payload", { method: "POST", body: "small" })).status).toBe(413);
  for (let i = 0; i < 8; i++) {
    const r = await a.api("/payload"); expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store");
    await r.arrayBuffer();
  }
  expect((await a.api("/payload")).status).toBe(429);
});
test("bounded reader rejects oversized and incomplete streams", async () => {
  await expect(readNetworkBytes(new Response("oversized").body, 3)).rejects.toThrow("unexpected transfer size");
  await expect(readNetworkBytes(new Response("x").body, 3)).rejects.toThrow("incomplete transfer");
});
test("automatic scheduler has a staggered start and clean stop", () => {
  const a = node("Yacht"); a.network.start();
  const s = a.network.snapshot(); expect(s.automatic).toBe(true);
  expect(s.nextCheckAt!).toBeGreaterThan(Date.now() + 29_000);
  expect(s.nextCheckAt!).toBeLessThanOrEqual(Date.now() + 120_000);
  a.network.stop(); expect(a.network.snapshot().nextCheckAt).toBeNull();
});
test("production auth protects measurements, payloads and triggers", async () => {
  const a = startTestServer(); cleanup.push(a.stop);
  for (const path of ["", "/ping", "/payload", "/test"]) {
    const r = await fetch(`${a.base}/api/network${path}`, { method: path === "/test" ? "POST" : "GET" });
    expect(r.status).toBe(401);
  }
});
