import { afterAll, beforeAll, beforeEach, expect, test as bunTest } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { navigationPdf } from "./fixtures/navigation-pdf";

const test = (name: string, fn: () => Promise<void>) => bunTest(name, fn, 30000);
const ui = process.env.CYBERDECK_TEST_UI || join(import.meta.dir, "../dist/ui");
const requests: { node: string; path: string; authorization: string | null; query: string }[] = [];
const mutations: string[] = [], errors: string[] = [];
let locked = false, retrySucceeds = false;
const delayed = new Map<string, () => void>();
const overview = { fleetDir: "/fixture", status: { host: "Test", hosts: [], repo: {}, handoffOpen: 0, sessionsIndexed: 0 }, projects: [], todo: { sections: [] }, handoff: [], collab: { tasks: [], runs: [], auto: false }, services: { rows: [] } };
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 30, async fetch(req) {
  const url = new URL(req.url), original = url.pathname;
  if (original.startsWith("/api/")) {
    if (req.method !== "GET") { mutations.push(`${req.method} ${original}`); return Response.json({ error: "Writes forbidden" }, { status: 405 }); }
    const node = original.match(/^\/api\/nodes\/([^/]+)\/proxy\//)?.[1] || "";
    const path = original.replace(/^\/api\/nodes\/[^/]+\/proxy\//, "/api/");
    if (path === "/api/auth/whoami") return Response.json({ method: "none" });
    if (path === "/api/fleet/nodes") return Response.json({ self: { nodeId: "self", name: "Test", urls: [] }, nodes: [{ id: "peer-a", name: "Peer A", online: true }, { id: "peer-b", name: "Peer B", online: true }] });
    if (path === "/api/fs/stat") {
      if (node === "unknown") return Response.json({ error: "unknown node" }, { status: 404 });
      if (url.searchParams.get("path") === "/missing-metadata.pdf") return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ type: url.searchParams.get("path") === "/directory.pdf" ? "dir" : "file" });
    }
    if (path === "/api/fs/read") {
      const file = url.searchParams.get("path") || "";
      requests.push({ node, path: file, authorization: req.headers.get("authorization"), query: url.search });
      if (file.includes("slow")) await new Promise<void>(resolve => delayed.set(`${node}:${file}`, resolve));
      const status = file.includes("missing") ? 404 : file.includes("denied") ? 403 : file.includes("locked") ? 401 : file.includes("offline") || file.includes("retry") && !retrySucceeds ? 503 : 200;
      if (status !== 200) return Response.json({ error: "Fixture read failed" }, { status });
      return new Response(file.includes("password") ? Bun.file(join(import.meta.dir, "fixtures/navigation-password.pdf")) : file.includes("invalid") ? "not a pdf" : navigationPdf(), { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
    }
    if (locked) return Response.json({ error: "Locked" }, { status: 401 });
    if (path === "/api/control/overview") return Response.json(overview);
    if (path === "/api/status") return Response.json({ nodeName: "Test", version: "fixture", roots: [], repos: 0 });
    if (path === "/api/sessions") return Response.json({ sessions: [] });
    if (path === "/api/cmux/tree") return Response.json({ available: false, tree: [] });
    if (path === "/api/fs/text") return Response.json({ content: "Original text", size: 13 });
    if (path === "/api/applications") return Response.json({ applications: [] });
    return Response.json({ error: "Fixture endpoint unavailable" }, { status: 404 });
  }
  const file = Bun.file(join(ui, original === "/" ? "index.html" : original));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
let browser: Browser, page: Page;
const route = (path = "/guide.pdf", other: Record<string, string> = {}) => `#/edit?${new URLSearchParams({ path, ...other })}`;
const go = (path?: string, other?: Record<string, string>) => page.goto(`${server.url}${route(path, other)}`);
const rendered = (n: number, target = page) => target.locator(`[data-testid=pdf-page][data-page="${n}"]`).waitFor({ state: "visible" });
const title = (value: string) => page.waitForFunction(value => document.title === value, value);
const param = (key: string) => page.evaluate(key => new URLSearchParams(location.hash.split("?")[1]).get(key), key);
const visit = async (hash: string) => { await page.evaluate(hash => { location.hash = hash; }, hash); };
async function held(key: string) {
  const until = Date.now() + 12000;
  while (!delayed.has(key)) {
    if (Date.now() > until) throw new Error(`Fixture did not receive held read: ${key}`);
    await Bun.sleep(10);
  }
}
beforeAll(async () => { browser = await chromium.launch(); });
beforeEach(async () => {
  for (const release of delayed.values()) release(); delayed.clear();
  await page?.context().close();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem("cyberdeck-token", "fixture-token"));
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on("pageerror", e => errors.push(e.message));
  requests.length = 0; errors.length = 0; mutations.length = 0; locked = false; retrySucceeds = false;
});
afterAll(async () => { for (const release of delayed.values()) release(); await browser?.close(); server.stop(true); });

test("PDF direct links render real pages and restore page, zoom, rotation and node on reload/new tab", async () => {
  await go("/guide.pdf", { node: "peer-a", page: "2", zoom: "100", rotate: "90" }); await rendered(2);
  await title("guide.pdf · Page 2 of 3 · PDF · Peer A · Cyberdeck");
  expect(await page.getByLabel("PDF zoom").inputValue()).toBe("100");
  expect(await page.getByTestId("pdf-page").textContent()).toContain("Navigation fixture page 2");
  const canvas = await page.locator("[data-testid=pdf-page] canvas").evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height, ink: canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 !== 3 && value < 100) }));
  expect(canvas.width).toBeGreaterThan(canvas.height); expect(canvas.ink).toBe(true);
  if (process.env.CYBERDECK_TEST_ARTIFACTS) {
    mkdirSync(process.env.CYBERDECK_TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(process.env.CYBERDECK_TEST_ARTIFACTS, "pdf-rotated.png") });
  }
  const url = page.url(); await page.reload(); await rendered(2);
  const tab = await page.context().newPage(); await tab.goto(url); await rendered(2, tab); expect(await tab.title()).toContain("Peer A"); await tab.close();
  expect(requests.every(req => req.node === "peer-a" && req.authorization === "Bearer fixture-token" && !req.query.includes("token"))).toBe(true);
  expect(mutations).toEqual([]); expect(errors).toEqual([]);
});

test("PDF controls create one history entry; no-op, Back/Forward and page renders never fetch again", async () => {
  await go(); await rendered(1); const start = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Next page", exact: true }).click(); await rendered(2);
  expect(await page.evaluate(() => history.length)).toBe(start + 1);
  await page.getByRole("button", { name: "Go", exact: true }).click(); expect(await page.evaluate(() => history.length)).toBe(start + 1);
  await page.getByLabel("PDF zoom").selectOption("150"); await rendered(2);
  await page.getByRole("button", { name: "Rotate clockwise" }).click(); await rendered(2);
  expect(await page.evaluate(() => history.length)).toBe(start + 3);
  await page.goBack(); await rendered(2); expect(await param("rotate")).toBe(null);
  await page.goBack(); await rendered(2); expect(await param("zoom")).toBe(null);
  await page.goBack(); await rendered(1); await title("guide.pdf · Page 1 of 3 · PDF · Cyberdeck");
  await page.goForward(); await rendered(2); expect(requests.filter(r => r.path === "/guide.pdf")).toHaveLength(1);
  if (process.env.CYBERDECK_TEST_ARTIFACTS) await page.screenshot({ path: join(process.env.CYBERDECK_TEST_ARTIFACTS, "pdf-fit-width.png") });
  expect(await page.locator("iframe").count()).toBe(0); expect(errors).toEqual([]);
});

test("PDF canonical defaults replace invalid parameters without extra history", async () => {
  await go("/guide.pdf", { page: "0001", zoom: "width", rotate: "0" }); await rendered(1);
  expect(await param("page")).toBe(null); expect(await param("zoom")).toBe(null); expect(await param("rotate")).toBe(null);
  const length = await page.evaluate(() => history.length);
  await visit(route("/guide.pdf", { page: "-2", zoom: "9999", rotate: "12" })); await rendered(1);
  await page.waitForFunction(() => !new URLSearchParams(location.hash.split("?")[1]).has("page"));
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await visit(route("/guide.pdf", { page: "0002", zoom: "0100", rotate: "0090" })); await rendered(2);
  expect(await param("page")).toBe("2"); expect(await param("zoom")).toBe("100"); expect(await param("rotate")).toBe("90");
});

test("PDF out-of-range pages preserve requested URLs and recover through history", async () => {
  await go("/guide.pdf", { page: "999" }); await page.getByTestId("pdf-error").waitFor();
  await title("guide.pdf · PDF page not found · Cyberdeck"); expect(await param("page")).toBe("999");
  await page.reload(); await title("guide.pdf · PDF page not found · Cyberdeck");
  await page.getByRole("button", { name: "First page", exact: true }).click(); await rendered(1);
  await page.goBack(); await title("guide.pdf · PDF page not found · Cyberdeck");
  await page.goForward(); await rendered(1); expect(errors).toEqual([]);
});

for (const [path, message] of [["/missing.pdf", "PDF not found"], ["/denied.pdf", "PDF access denied"], ["/offline.pdf", "PDF unavailable"], ["/invalid.pdf", "Invalid PDF"]]) {
  test(`${message} retains its selected file/node and never leaves a blank iframe`, async () => {
    await go(path, { node: "peer-a", page: "2" }); await page.getByTestId("pdf-error").waitFor();
    await title(`${path.slice(1)} · ${message} · Peer A · Cyberdeck`);
    expect(await param("path")).toBe(path); expect(await param("node")).toBe("peer-a");
    await page.reload(); await page.getByTestId("pdf-error").waitFor();
    await page.getByTestId("nav-services").click(); await title("Services · Cyberdeck");
    expect(errors).toEqual([]); expect(mutations).toEqual([]);
  });
}

test("PDF retry recovers the same selected page without adding history", async () => {
  await go("/retry.pdf", { page: "2" }); await page.getByTestId("pdf-error").waitFor();
  const url = page.url(), length = await page.evaluate(() => history.length); retrySucceeds = true;
  await page.getByRole("button", { name: "Retry preview" }).click(); await rendered(2);
  await title("retry.pdf · Page 2 of 3 · PDF · Cyberdeck");
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
});

test("retained PDFs and unsaved editors survive primary views and node changes with distinct owners", async () => {
  await page.goto(`${server.url}#/edit?path=%2Fdraft.txt`); await page.locator(".cm-content").fill("Unsaved draft");
  await visit(route("/guide.pdf", { page: "2", node: "peer-a" })); await rendered(2);
  await page.getByTestId("nav-services").click(); await title("Services · Cyberdeck");
  await visit(route("/guide.pdf", { page: "3", node: "peer-b" })); await rendered(3);
  await title("guide.pdf · Page 3 of 3 · PDF · Peer B · Cyberdeck");
  await page.goBack(); await title("Services · Cyberdeck"); await page.goBack(); await rendered(2);
  await title("guide.pdf · Page 2 of 3 · PDF · Peer A · Cyberdeck");
  expect(requests.filter(r => r.path === "/guide.pdf")).toHaveLength(2);
  await page.goBack(); expect(await page.locator(".cm-content").textContent()).toBe("Unsaved draft"); expect(errors).toEqual([]);
});

test("late PDF loads/errors cannot rename another route or steal a newer page selection", async () => {
  await go("/slow.pdf", { page: "2" }); await held(":/slow.pdf");
  await visit(route("/slow.pdf", { page: "3" })); delayed.get(":/slow.pdf")?.();
  await rendered(3); await title("slow.pdf · Page 3 of 3 · PDF · Cyberdeck");
  await visit(route("/slow-missing.pdf", { node: "peer-a", page: "2" }));
  await held("peer-a:/slow-missing.pdf");
  await page.getByTestId("nav-services").click(); delayed.get("peer-a:/slow-missing.pdf")?.();
  await page.waitForFunction(() => document.querySelector('[data-testid="pdf-error"]')?.textContent?.includes("no longer available"));
  await title("Services · Cyberdeck");
  await page.goBack(); await title("slow-missing.pdf · PDF not found · Peer A · Cyberdeck"); expect(errors).toEqual([]);
});

test("rapid PDF page/zoom/history transitions settle on the requested page with no render races", async () => {
  await go(); await rendered(1);
  await page.evaluate(() => {
    const next = document.querySelectorAll("[data-testid=pdf-preview] button")[2] as HTMLButtonElement;
    next.click(); next.click();
  });
  await rendered(3); expect(await param("page")).toBe("3");
  await page.goBack(); await page.goBack(); await page.goForward(); await rendered(2);
  await page.getByLabel("PDF zoom").selectOption("fit"); await rendered(2);
  await page.setViewportSize({ width: 800, height: 750 }); await rendered(2);
  expect(errors).toEqual([]); expect(requests).toHaveLength(1);
});

test("PDF local authentication failure locks, retains its route and disposes retained document owners", async () => {
  await go(); await rendered(1);
  await visit(route("/locked.pdf"));
  await title("Locked · Cyberdeck"); expect(await param("path")).toBe("/locked.pdf");
  expect(await page.getByTestId("pdf-preview").count()).toBe(0); expect(errors).toEqual([]);
});

test("a peer's denied PDF and a hidden local denial cannot lock the active serving view", async () => {
  await go("/locked.pdf", { node: "peer-a" }); await title("locked.pdf · PDF access denied · Peer A · Cyberdeck");
  await visit(route("/slow-locked.pdf"));
  await held(":/slow-locked.pdf");
  await page.getByTestId("nav-services").click(); delayed.get(":/slow-locked.pdf")?.();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="pdf-error"]')].some(el => el.textContent?.includes("denied")));
  await title("Services · Cyberdeck"); await page.goBack(); await title("Locked · Cyberdeck");
});

test("PDF metadata errors and directories have honest titles before reading file contents", async () => {
  await go("/missing-metadata.pdf"); await title("missing-metadata.pdf · PDF not found · Cyberdeck");
  await visit(route("/directory.pdf")); await title("directory.pdf · PDF unavailable · Cyberdeck");
  expect(await page.getByTestId("pdf-error").filter({ visible: true }).textContent()).toContain("directory");
  expect(requests).toHaveLength(0);
});

test("PDF links to an unknown machine retain their destination and distinguish it from a missing file", async () => {
  await go("/guide.pdf", { node: "unknown", page: "2" });
  await title("guide.pdf · Machine not found · PDF · unknown · Cyberdeck");
  expect(await param("node")).toBe("unknown"); expect(requests).toHaveLength(0);
  await page.reload(); await title("guide.pdf · Machine not found · PDF · unknown · Cyberdeck");
});

test("password-protected PDFs retain the requested page, keep passwords out of URLs and relock on refresh", async () => {
  await go("/password.pdf", { page: "2" }); await title("password.pdf · PDF password required · Cyberdeck");
  const url = page.url(), length = await page.evaluate(() => history.length);
  await page.getByLabel("PDF password", { exact: true }).fill("wrong"); await page.getByRole("button", { name: "Unlock PDF" }).click();
  await page.getByText("Incorrect password. Try again:").waitFor();
  await page.getByLabel("PDF password", { exact: true }).fill("fixture-password"); await page.getByRole("button", { name: "Unlock PDF" }).click();
  await rendered(2); await title("password.pdf · Page 2 of 3 · PDF · Cyberdeck");
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
  await page.getByTestId("nav-services").click(); await page.goBack(); await rendered(2);
  await page.reload(); await title("password.pdf · PDF password required · Cyberdeck");
  expect(await page.getByLabel("PDF password", { exact: true }).inputValue()).toBe(""); expect(errors).toEqual([]);
});
