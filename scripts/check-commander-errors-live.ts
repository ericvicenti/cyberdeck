/** Installed client checks. All child APIs and game sockets are local browser fixtures. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const transport = new URL(process.env.CYBERDECK_TEST_ORIGIN || "http://127.0.0.1:4777").origin;
const origin = new URL(process.env.CYBERDECK_PARENT_ORIGIN || transport).origin;
const childTransport = process.env.CYBERDECK_CHILD_TRANSPORT
  ? new URL(process.env.CYBERDECK_CHILD_TRANSPORT).origin : null;
const host = process.env.CYBERDECK_TEST_TOKEN_HOST;
const token = host ? (() => {
  const result = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "cat ~/.cyberdeck/token"]);
  if (result.exitCode) throw new Error("Cannot read selected host token");
  return result.stdout.toString().trim();
})() : readFileSync(join(homedir(), ".cyberdeck/token"), "utf8").trim();
assert(token, "Missing token");
const response = await fetch(transport + "/api/applications", { headers: { Authorization: "Bearer " + token } });
assert(response.ok, "Applications unavailable");
const listing = await response.json() as { applications: { id: string; url: string }[] };
const app = listing.applications.find(app => app.id === "commander");
assert(app, "Commander is not configured");
const childOrigin = new URL(app.url).origin;
const browser = await chromium.launch();
const context = await browser.newContext();
const errors: string[] = [], mutations: string[] = [];
let fixtureAccounts = 0, directoryStatus = 503;
let accountStatus = 200, libraryStatus = 200, versionStatus = 200, runsStatus = 200;
let overviewStatus = 200, logStatus = 200, batchStatus = 200;
const tactic = { id: "navigation-tactic", name: "Navigation tactic", version: 2, parameters: [], source: "function turn() { return {}; }", description: "Read-only fixture", hash: "navigation", createdAt: 1 };
const overview = { updatedAt: 1, coach: { status: "idle", daily: {} }, online: { status: "idle" }, policies: [], totals: { batches: 0, promotions: 0, ranked: {}, local: {}, private: {} }, batches: [], humanMatches: [], remoteMatches: [], storage: { archiveBytes: 0, freeBytes: 1e10 } };
const batch = { id: "navigation-batch", name: "Navigation experiment", status: "rejected", reasons: [], trainingSeeds: [], validationSeeds: [], candidates: [], policies: [], matches: [] };
await context.grantPermissions(["local-network-access"], { origin });
await context.addInitScript(({ origin, token }) => {
  if (location.origin === origin) localStorage.setItem("cyberdeck-token", token);
}, { origin, token });
// Never attach to a real game, including Socket.IO's HTTP polling fallback.
await context.routeWebSocket("**/*", socket => socket.close());
await context.route("**/*", async route => {
  const req = route.request(), u = new URL(req.url());
  if (![origin, childOrigin].includes(u.origin)) return route.abort();
  if (u.origin === childOrigin && u.pathname.startsWith("/socket.io"))
    return route.fulfill({ status: 403, json: { error: "No game connections in this fixture" } });
  if (u.origin === childOrigin && u.pathname.startsWith("/api/")) {
    if (u.pathname === "/api/account" && req.method() === "POST") {
      fixtureAccounts++;
      return route.fulfill({ json: { account: { id: "navigation-fixture", username: "Navigation fixture" }, token: "navigation-fixture" } });
    }
    if (req.method() !== "GET") { mutations.push(req.method() + " " + u.pathname); return route.abort(); }
    if (u.pathname === "/api/account") return route.fulfill({ status: accountStatus, body: accountStatus === 200 ? JSON.stringify({ id: "navigation-fixture", username: "Navigation fixture" }) : "Read failed", contentType: accountStatus === 200 ? "application/json" : "text/plain" });
    if (u.pathname === "/api/tactics") return route.fulfill({ status: libraryStatus, json: libraryStatus === 200 ? [tactic] : {} });
    if (u.pathname === "/api/tactics/navigation-tactic/versions") return route.fulfill({ status: versionStatus, json: versionStatus === 200 ? [tactic, { ...tactic, version: 1 }] : {} });
    if (u.pathname === "/api/runs") return route.fulfill({ status: runsStatus, json: runsStatus === 200 ? [] : {} });
    if (u.pathname === "/api/trainer/overview") return route.fulfill({ status: overviewStatus, json: overviewStatus === 200 ? overview : {} });
    if (u.pathname === "/api/trainer/live") return route.fulfill({ json: { local: null, remote: null } });
    if (u.pathname.startsWith("/api/trainer/logs/")) return route.fulfill({ status: logStatus, json: logStatus === 200 ? { text: "Read-only fixture logs" } : {} });
    if (u.pathname === "/api/trainer/batches/navigation-batch") return route.fulfill({ status: batchStatus, json: batchStatus === 200 ? batch : {} });
    if (u.pathname.startsWith("/api/replays/navigation-")) {
      const kind = u.pathname.split("navigation-")[1];
      const status = kind === "denied" ? 403 : kind === "missing" ? 404 : kind === "invalid" ? 200 : 503;
      return route.fulfill({ status, json: kind === "invalid" ? {} : { error: "Read-only replay fixture" } });
    }
    if (u.pathname.startsWith("/api/generals/main/"))
      return route.fulfill({ status: directoryStatus, json: directoryStatus === 200 ? { replays: [], players: [] } : { error: "Read-only directory fixture" } });
    if (u.pathname === "/api/replays") return route.fulfill({ json: { replays: [], total: 0 } });
    if (u.pathname === "/api/bot/status") return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: "Outside read-only fixture" } });
  }
  if (req.method() !== "GET") { mutations.push(req.method() + " " + u.pathname); return route.abort(); }
  try {
    const result = u.origin === childOrigin
      ? await route.fetch({ url: (childTransport || childOrigin) + u.pathname + u.search })
      : await route.fetch({ url: transport + u.pathname + u.search, headers: { ...req.headers(), Authorization: "Bearer " + token } });
    return await route.fulfill({ response: result });
  } catch { await route.abort().catch(() => {}); } // Fetch errors can contain private headers.
});
const page = await context.newPage();
page.setDefaultNavigationTimeout(30000);
page.setDefaultTimeout(15000);
page.on("pageerror", e => errors.push(e.message));
const href = (route: string) => origin + "/#/applications?" + new URLSearchParams({ app: "commander", route });
const waitTitle = (title: string) => page.waitForFunction(t => document.title === t, title + " · Commander · Cyberdeck");
const passed: string[] = [];
try {
  for (const [kind, title] of [["denied", "Access denied · Replay"], ["missing", "Replay not found"], ["unavailable", "Replay unavailable"], ["invalid", "Invalid replay"]]) {
    const route = "/?replay=navigation-" + kind;
    await page.goto(href(route)); await waitTitle(title);
    assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1]).get("route")), route);
    await page.reload(); await waitTitle(title);
    passed.push(kind + " replay/direct/reload/title");
  }
  assert.equal(fixtureAccounts, 0, "Replay links initialized an account");
  await page.goto(href("/?q=Fixture&source=main"));
  await waitTitle("Directory unavailable");
  const before = await page.evaluate(() => history.length);
  const child = page.frameLocator('iframe[title="Commander"]');
  directoryStatus = 403;
  await child.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitTitle("Access denied · Directory");
  directoryStatus = 200;
  await child.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitTitle("Replays: Fixture");
  assert.equal(await page.evaluate(() => history.length), before);
  await page.getByTestId("nav-data").click();
  await page.waitForFunction(() => document.title === "Data · Cyberdeck");
  await page.goBack(); await waitTitle("Replays: Fixture");
  passed.push("directory error/denied/retry/no-extra-entry/title cleanup/Back");
  const cases: { route: string; title: string; fail: () => void; recover: () => void; retry?: string }[] = [
    { route: "/?tactics=account", title: "Account access denied", fail: () => { accountStatus = 403; }, recover: () => { accountStatus = 200; } },
    { route: "/?tactics=library", title: "Tactics library unavailable", fail: () => { libraryStatus = 503; }, recover: () => { libraryStatus = 200; } },
    { route: "/?tactic=navigation-tactic&tactics=library&version=1", title: "Version access denied", fail: () => { versionStatus = 403; }, recover: () => { versionStatus = 200; } },
    { route: "/?history=1&tactic=navigation-tactic&tactics=library&version=2", title: "Version history access denied", fail: () => { versionStatus = 403; }, recover: () => { versionStatus = 200; } },
    { route: "/?tactics=runs", title: "Run history unavailable", fail: () => { runsStatus = 503; }, recover: () => { runsStatus = 200; } },
    { route: "/?tab=Logs&trainer=1&worker=coach", title: "Logs access denied · Training", fail: () => { logStatus = 403; }, recover: () => { logStatus = 200; }, retry: "Retry logs" },
    { route: "/?batch=navigation-batch&tab=Experiments&trainer=1", title: "Experiment not found", fail: () => { batchStatus = 404; }, recover: () => { batchStatus = 200; }, retry: "Retry experiment" },
    { route: "/?tab=Matches&trainer=1", title: "Training access denied", fail: () => { overviewStatus = 403; }, recover: () => { overviewStatus = 200; }, retry: "Retry training" },
  ];
  for (const item of cases) {
    item.fail();
    await page.goto(href(item.route)); await waitTitle(item.title);
    await page.reload(); await waitTitle(item.title);
    assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1]).get("route")), item.route);
    const panel = child.locator(item.retry ? '.trainer-shell' : 'aside[aria-label="Tactics workshop"]:visible');
    if (item.route.includes("tactics=runs")) assert.equal(await panel.getByText("No runs yet.", { exact: false }).count(), 0);
    const position = await page.evaluate(() => history.length);
    item.recover();
    await panel.getByRole("button", { name: item.retry || "Retry workshop" }).click();
    await panel.getByRole("alert").waitFor({ state: "hidden" });
    await page.waitForFunction(t => !document.title.includes(t), item.title);
    assert.equal(await page.evaluate(() => history.length), position);
    assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1]).get("route")), item.route);
    passed.push(item.title + "/direct/reload/retry/no-extra-entry");
  }
  assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
  console.log(JSON.stringify({ passed, pageErrors: 0, productionApiWrites: 0, childApiNetworkRequests: 0, gameConnections: 0, syntheticAccountResponses: fixtureAccounts }));
} finally { await context.unrouteAll({ behavior: "ignoreErrors" }); await browser.close(); }
