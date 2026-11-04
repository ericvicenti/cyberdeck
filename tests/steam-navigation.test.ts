import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import type { SteamLibrary } from "../src/shared/steam";

// This fixture cannot launch Steam, download a game or address a real machine.
const library: SteamLibrary = { supported: true, available: true, connected: true, reason: null, node: "Fixture", games: [{ id: "42", name: "Navigation game", ready: true }], warnings: [], session: null };
let steam = async (): Promise<Response> => Response.json(library);
const requests: string[] = [], errors: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/api/")) {
    requests.push(req.method + " " + path);
    if (req.method !== "GET") return new Response("Commands forbidden", { status: 405 });
    if (path === "/api/steam") return steam();
    if (path === "/api/auth/whoami") return Response.json({ method: "none" });
    if (path === "/api/fleet/nodes") return Response.json({ self: { nodeId: "fixture", name: "Fixture" }, nodes: [] });
    if (path === "/api/applications") return Response.json({ applications: [] });
    if (path === "/api/vimm/roms") return Response.json({ games: [] });
    return Response.json({ error: "Outside fixture" }, { status: 404 });
  }
  const file = Bun.file(join(import.meta.dir, "../dist/ui", path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
let browser: Browser, page: Page;
const selected = "#/applications?app=vimm&steam=42&tab=steam";
const title = (text: string, target = page) => target.waitForFunction(t => document.title === t, text + " · The Vault · Cyberdeck");
beforeAll(async () => { browser = await chromium.launch(); });
beforeEach(async () => {
  await page?.close(); requests.length = 0; errors.length = 0;
  steam = async () => Response.json(library);
  page = await browser.newPage(); page.setDefaultTimeout(15000);
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => route.request().url().startsWith(server.url.toString()) ? route.continue() : route.abort());
});
afterAll(async () => { await browser?.close(); server.stop(true); });
const safe = () => { expect(errors).toEqual([]); expect(requests.every(r => r.startsWith("GET "))).toBe(true); };

test("Steam details restore on direct link, refresh, new tab and Back/Forward without Play", async () => {
  await page.goto(server.url + selected); await title("Navigation game");
  await page.getByRole("dialog").waitFor();
  await page.reload(); await title("Navigation game");
  const fresh = await browser.newPage();
  await fresh.route("**/*", route => route.request().url().startsWith(server.url.toString()) ? route.continue() : route.abort());
  await fresh.goto(page.url()); await title("Navigation game", fresh); await fresh.close();
  const before = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack(); await title("Navigation game");
  await page.goForward(); await page.getByRole("dialog").waitFor({ state: "detached" });
  safe();
});

for (const status of [403, 503]) test(`Steam ${status} errors keep the requested game, recover and clean up their title`, async () => {
  steam = async () => Response.json({ error: "Fixture library failure" }, { status });
  const expected = status === 403 ? "Access denied · Steam" : "Steam library unavailable";
  await page.goto(server.url + selected); await title(expected);
  await page.getByRole("alert").waitFor();
  await page.reload(); await title(expected);
  expect(new URL(page.url()).hash).toBe(selected);
  const before = await page.evaluate(() => history.length);
  steam = async () => Response.json(library);
  await page.getByRole("button", { name: "Retry Steam library" }).click(); await title("Navigation game");
  expect(await page.evaluate(() => history.length)).toBe(before);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("nav-data").click();
  await page.waitForFunction(() => document.title === "Data · Cyberdeck");
  await page.goBack(); await page.goBack(); await title("Navigation game");
  safe();
});

test("unsupported machines and missing games have distinct reloadable states", async () => {
  steam = async () => Response.json({ ...library, supported: false, games: [] });
  await page.goto(server.url + selected); await title("Steam unavailable");
  expect(await page.getByRole("alert").textContent()).toContain("unavailable on this machine");
  await page.reload(); await title("Steam unavailable");
  steam = async () => Response.json({ ...library, games: [] });
  await page.reload(); await title("Game not found");
  expect(new URL(page.url()).hash).toBe(selected);
  expect(await page.getByRole("alert").textContent()).toContain("Game not found");
  safe();
});

test("a newer focus refresh defeats a late poll and its stale authentication error", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  let first = true;
  steam = async () => { if (first) { first = false; return held; } return Response.json(library); };
  await page.goto(server.url + selected);
  await page.getByRole("status", { name: "" }).filter({ hasText: "Loading Steam library" }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await title("Navigation game");
  release(Response.json({ error: "Stale denial" }, { status: 401 }));
  await page.getByRole("dialog").waitFor();
  await title("Navigation game");
  expect(new URL(page.url()).hash).toBe(selected);
  safe();
});

test("an active authentication failure locks without losing the game link", async () => {
  steam = async () => Response.json({ error: "Unauthorized" }, { status: 401 });
  await page.goto(server.url + selected);
  await page.waitForFunction(() => document.title === "Locked · Cyberdeck");
  expect(new URL(page.url()).hash).toBe(selected);
  expect(await page.getByRole("dialog").count()).toBe(0);
  safe();
});

test("invalid library payloads become recoverable errors without a blank view", async () => {
  steam = async () => Response.json({ supported: true, games: null });
  await page.goto(server.url + selected); await title("Steam library unavailable");
  expect(await page.getByRole("alert").textContent()).toContain("Invalid Steam library response");
  steam = async () => Response.json(library);
  await page.getByRole("button", { name: "Retry Steam library" }).click(); await title("Navigation game");
  safe();
});
