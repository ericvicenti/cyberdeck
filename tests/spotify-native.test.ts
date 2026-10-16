import { test, expect } from "bun:test";
import { Hono } from "hono";
import { registerNativeSpotifyRoutes } from "../src/daemon/api/spotify-native";
function setup() {
  let time = 0; const app = new Hono();
  registerNativeSpotifyRoutes(app, c => c.req.header("Authorization") === "Bearer owner", 4777, () => time);
  app.get("/", c => c.text("existing browser app"));
  const req = (path: string, method = "GET", owner = true) => app.request("http://127.0.0.1:4777" + path, { method, headers: owner ? { Authorization: "Bearer owner" } : {} });
  return { req, app, expire: () => { time += 600001; }, start: async () => (await req("/api/spotify/native/start", "POST")).json() };
}
test("owner-only handoff, independent claim secret, one-time code, clean redirect", async () => {
  const { req, start } = setup();
  expect((await req("/api/spotify/native/start", "POST", false)).status).toBe(403);
  const p = await start(); expect(p.id).not.toBe(p.state);
  expect(await (await req(`/api/spotify/native/${p.id}`)).json()).toEqual({ pending: true });
  expect((await req(`/?state=${p.state}&code=test-code`, "GET", false)).headers.get("location")).toBe("/spotify-native-complete");
  expect((await req(`/api/spotify/native/${p.id}`, "GET", false)).status).toBe(403);
  expect((await req(`/?state=${p.state}&code=replay`)).status).toBe(400);
  const claim = await req(`/api/spotify/native/${p.id}`);
  expect(claim.headers.get("cache-control")).toBe("no-store");
  expect(await claim.json()).toEqual({ code: "test-code" });
  expect((await req(`/api/spotify/native/${p.id}`)).status).toBe(404);
});
test("expiry, cancel, bounds, and ordinary browser OAuth remain independent", async () => {
  const { req, start, expire } = setup();
  expect(await (await req("/?state=browser-state&code=browser-code")).text()).toBe("existing browser app");
  const p = await start(); expire();
  expect((await req(`/?state=${p.state}&code=expired`)).status).toBe(400);
  const q = await start(); await req(`/api/spotify/native/${q.id}/cancel`, "POST");
  expect((await req(`/?state=${q.state}&code=cancelled`)).status).toBe(400);
  for (let i = 0; i < 8; i++) await start();
  expect((await req("/api/spotify/native/start", "POST")).status).toBe(429);
});
test("callback rejects wrong origin and sanitizes provider errors", async () => {
  const { req, start, app } = setup(); const p = await start();
  expect((await app.request(`http://example.com/?state=${p.state}&code=wrong-host`)).status).toBe(400);
  await req(`/?state=${p.state}&error=untrusted-provider-text`);
  const result = await (await req(`/api/spotify/native/${p.id}`)).json();
  expect(result.error).toContain("not completed"); expect(JSON.stringify(result)).not.toContain("untrusted-provider-text");
});
