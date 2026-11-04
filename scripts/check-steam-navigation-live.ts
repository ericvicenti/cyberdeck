/** Installed UI smoke test; Steam responses are fixtures, all commands are blocked. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const origin = new URL(process.env.CYBERDECK_TEST_ORIGIN || "http://127.0.0.1:4777").origin;
const host = process.env.CYBERDECK_TEST_TOKEN_HOST;
const token = host ? (() => {
  const r = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "cat ~/.cyberdeck/token"]);
  if (r.exitCode) throw new Error("Cannot read selected host token");
  return r.stdout.toString().trim();
})() : readFileSync(join(homedir(), ".cyberdeck/token"), "utf8").trim();
assert(token, "Missing token");
const browser = await chromium.launch();
const context = await browser.newContext();
const writes: string[] = [], errors: string[] = [];
let status = 503;
const library = { supported: true, available: true, connected: true, reason: null, node: "Navigation fixture", games: [{ id: "42", name: "Navigation fixture game", ready: true }], warnings: [], session: null };
await context.addInitScript(({ origin, token }) => {
  if (location.origin === origin) localStorage.setItem("cyberdeck-token", token);
}, { origin, token });
await context.routeWebSocket("**/*", socket => socket.close());
await context.route("**/*", async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.origin !== origin) return route.abort();
  if (req.method() !== "GET") { writes.push(req.method() + " " + url.pathname); return route.abort(); }
  if (url.pathname === "/api/steam") return route.fulfill({ status, json: status === 200 ? library : { error: "Read-only Steam fixture" } });
  if (url.pathname.startsWith("/api/steam/")) { writes.push("Unexpected Steam action path"); return route.abort(); }
  if (url.pathname.startsWith("/api/vimm/")) return route.fulfill({ json: { games: [], shelves: [] } });
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(15000);
page.on("pageerror", e => errors.push(e.message));
const hash = "#/applications?app=vimm&steam=42&tab=steam";
const wait = (text: string, target = page) => target.waitForFunction(t => document.title === t + " · The Vault · Cyberdeck", text);
try {
  await page.goto(origin + "/" + hash); await wait("Steam library unavailable");
  assert.equal(new URL(page.url()).hash, hash);
  await page.reload(); await wait("Steam library unavailable");
  const length = await page.evaluate(() => history.length);
  status = 403;
  await page.getByRole("button", { name: "Retry Steam library" }).click(); await wait("Access denied · Steam");
  status = 200;
  await page.getByRole("button", { name: "Retry Steam library" }).click(); await wait("Navigation fixture game");
  assert.equal(await page.evaluate(() => history.length), length);
  const fresh = await context.newPage();
  await fresh.goto(page.url()); await wait("Navigation fixture game", fresh); await fresh.close();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => history.length), length + 1);
  await page.goBack(); await wait("Navigation fixture game");
  await page.goForward(); await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByTestId("nav-data").click();
  await page.waitForFunction(() => document.title === "Data · Cyberdeck");
  await page.goBack(); await page.goBack(); await wait("Navigation fixture game");
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log(JSON.stringify({ checks: ["503 direct/reload", "403 retry", "recovery without history", "new tab", "detail Back/Forward", "primary title cleanup"], pageErrors: 0, apiWrites: 0, steamServerRequests: 0 }));
} finally { await context.unrouteAll({ behavior: "ignoreErrors" }); await browser.close(); }
