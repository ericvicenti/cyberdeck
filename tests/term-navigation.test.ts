import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";

// Production UI, synthetic session lists and inert terminal sockets. No shell,
// Seed message, media, real fleet or user data is touched.
const shell = (id: string, title = id) => ({ id, title, cwd: "/fixture", cmd: null, tool: "shell", runner: "pty", state: "running", createdAt: 1, clients: 0 });
type Answer = { sessions?: ReturnType<typeof shell>[]; error?: string; seedError?: string; status?: number };
let answers: Record<string, Answer>;
let fleetStatus = 200;
let allowCreate = false, holdCreate = false;
const creations: { node: string; cwd?: string; cmd?: string }[] = [];
const createWaiters = new Set<() => void>();
let heldNode: string | null = null;
const held = new Set<() => void>();
const sockets = new Set<any>(), attachments = new Set<any>();
const writes: string[] = [], errors: string[] = [], inputs: string[] = [];
let attaches = 0;
const peers = [{ id: "peer-a", name: "Peer A", online: true }, { id: "peer-b", name: "Peer B", online: true }];
const server = Bun.serve<{ events: boolean }>({ hostname: "127.0.0.1", port: 0, async fetch(req, server) {
  const u = new URL(req.url), path = u.pathname;
  if (req.headers.get("upgrade") === "websocket") {
    if (path.endsWith("/attach")) attaches++;
    if (server.upgrade(req, { data: { events: path === "/api/events" } })) return;
  }
  if (path.startsWith("/api/")) {
    if (allowCreate && req.method === "POST" && path.endsWith("/sessions")) {
      const node = path.match(/^\/api\/nodes\/([^/]+)\/proxy\/sessions$/)?.[1] || "";
      const body = await req.json() as { cwd?: string; cmd?: string };
      creations.push({ node, ...body });
      if (holdCreate) await new Promise<void>(release => createWaiters.add(release));
      const created = shell("created", "Created fixture");
      answers[node] = { sessions: [...(answers[node].sessions ?? []), created] };
      return Response.json(created);
    }
    if (req.method !== "GET") { writes.push(`${req.method} ${path}`); return Response.json({ error: "No writes" }, { status: 405 }); }
    if (path === "/api/auth/whoami") return Response.json({ method: "none" });
    if (path === "/api/fleet/nodes") return fleetStatus === 200
      ? Response.json({ self: { nodeId: "local", name: "Local", urls: [] }, nodes: peers })
      : Response.json({ error: "Fleet could not be read" }, { status: fleetStatus });
    if (path.endsWith("/sessions")) {
      const node = path.match(/^\/api\/nodes\/([^/]+)\/proxy\/sessions$/)?.[1] || "";
      const { status = 200, ...answer } = structuredClone(answers[node]);
      if (heldNode === node) await new Promise<void>(release => held.add(release));
      return Response.json(answer, { status });
    }
    if (path === "/api/status") return Response.json({ nodeName: "Local", roots: [], repos: 0 });
    if (path.endsWith("/repos")) return Response.json([]);
    return Response.json({ error: "Fixture unavailable" }, { status: 404 });
  }
  const file = Bun.file(join(process.env.CYBERDECK_TEST_UI || join(import.meta.dir, "../dist/ui"), path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
}, websocket: {
  open(ws) { if (ws.data.events) sockets.add(ws); else attachments.add(ws); },
  message(_ws, raw) { const data = JSON.parse(String(raw)); if (data.t === "input") inputs.push(data.data); },
  close(ws) { sockets.delete(ws); attachments.delete(ws); },
}});
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { release(); await browser.close(); server.stop(true); expect(writes).toEqual([]); expect(inputs).toEqual([]); expect(errors).toEqual([]); });
function release() { for (const resolve of createWaiters) resolve(); createWaiters.clear(); heldNode = null; for (const resolve of held) resolve(); held.clear(); }
function event() { for (const ws of sockets) ws.send(JSON.stringify({ kind: "sessions" })); }
async function waitAttachment(page: Page) { for (let i = 0; i < 200 && !attachments.size; i++) await page.waitForTimeout(10); expect(attachments.size).toBeGreaterThan(0); }
async function fresh(fn: (page: Page) => Promise<void>) {
  answers = { "": { sessions: [shell("local", "Local shell")] }, "peer-a": { sessions: [shell("a", "A shell")] }, "peer-b": { sessions: [shell("b", "B shell")] } };
  fleetStatus = 200; attaches = 0; attachments.clear(); allowCreate = false; holdCreate = false; creations.length = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(10000);
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", r => new URL(r.request().url()).origin === server.url.origin ? r.continue() : r.abort());
  try { await fn(page); }
  catch (e) { console.error(JSON.stringify({ title: await page.title(), hash: new URL(page.url()).hash, body: (await page.locator("body").innerText()).slice(-2200) })); throw e; }
  finally { release(); await page.close(); }
}
let visit = 0;
const href = (query = "") => `${server.url}?visit=${++visit}#/term${query ? `?${query}` : ""}`;
const title = (page: Page, value: string) => page.waitForFunction(value => document.title === `${value} · Cyberdeck`, value);
const param = (page: Page, key: string) => page.evaluate(key => new URLSearchParams(location.hash.split("?")[1]).get(key), key);
const waitHeld = async (page: Page) => { for (let i = 0; i < 200 && !held.size; i++) await page.waitForTimeout(10); expect(held.size).toBeGreaterThan(0); };

test("filtered direct links default to that machine once and restore through reload, fresh tabs and history", () => fresh(async page => {
  await page.goto(href("filter=peer-b")); await title(page, "B shell · Peer B · Sessions");
  expect(await param(page, "session")).toBe("b"); expect(await param(page, "node")).toBe("peer-b");
  await page.reload(); await title(page, "B shell · Peer B · Sessions");
  const tab = await browser.newPage(); try { await tab.goto(page.url()); await title(tab, "B shell · Peer B · Sessions"); } finally { await tab.close(); }
  const before = await page.evaluate(() => history.length);
  await page.getByTestId("term-filter-node").selectOption("");
  await page.getByTestId("term-tab").getByRole("button", { name: "Local shell", exact: true }).click(); await title(page, "Local shell · Local · Sessions");
  await page.goBack(); await title(page, "B shell · Peer B · Sessions");
  await page.goBack(); expect(await param(page, "filter")).toBe("peer-b");
  await page.goForward(); await page.goForward(); await title(page, "Local shell · Local · Sessions");
  expect(await page.evaluate(() => history.length)).toBe(before + 2);
}), 30000);

test("an empty filtered machine offers its own New form without starting anything", () => fresh(async page => {
  answers["peer-b"] = { sessions: [] };
  await page.goto(href("filter=peer-b")); await title(page, "New session on Peer B");
  expect(await param(page, "target")).toBe("peer-b"); expect(await param(page, "session")).toBe(null);
  expect(await page.getByTestId("term-new-node").inputValue()).toBe("peer-b");
  await page.reload(); await title(page, "New session on Peer B"); expect(attaches).toBe(0);
}), 30000);

test("unknown and unavailable filters preserve shareable errors instead of selecting another machine", () => fresh(async page => {
  await page.goto(href("filter=unknown")); await title(page, "Machine not found · Sessions");
  await page.getByTestId("term-filter-error").waitFor(); expect(await param(page, "new")).toBe(null);
  await page.reload(); await title(page, "Machine not found · Sessions");
  answers["peer-b"] = { status: 503, error: "Peer temporarily unavailable" };
  await page.goto(href("filter=peer-b")); await title(page, "Sessions unavailable · Peer B");
  expect(await param(page, "session")).toBe(null); expect(attaches).toBe(0);
  answers["peer-b"] = { sessions: [shell("b", "Recovered shell")] };
  const before = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await title(page, "Recovered shell · Peer B · Sessions");
  expect(await page.evaluate(() => history.length)).toBe(before);
}), 30000);

test("an explicit session owner remains independent of its filter, including an unknown filter", () => fresh(async page => {
  await page.goto(href("session=a&node=peer-a&filter=unknown")); await title(page, "A shell · Peer A · Sessions");
  await page.getByTestId("term-filter-error").waitFor();
  await page.getByTestId("terminal-host").evaluate(el => el.setAttribute("data-retained", "yes"));
  const count = attaches;
  await page.getByTestId("term-filter-node").selectOption("peer-b");
  await page.goBack(); await title(page, "A shell · Peer A · Sessions");
  expect(await page.getByTestId("terminal-host").getAttribute("data-retained")).toBe("yes"); expect(attaches).toBe(count);
}), 30000);

test("a disconnected terminal has an honest title, then reconnects without a URL or history change", () => fresh(async page => {
  await page.goto(href("session=local")); await title(page, "Local shell · Local · Sessions");
  await waitAttachment(page);
  const url = page.url(), historyLength = await page.evaluate(() => history.length), count = attaches;
  for (const ws of attachments) ws.close();
  await title(page, "Disconnected · Local shell · Local · Sessions");
  expect(await page.getByText("disconnected (the session is still running on Local)").isVisible()).toBe(true);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await title(page, "Local shell · Local · Sessions");
  expect(attaches).toBe(count + 1);
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.getByTestId("nav-data").click(); await title(page, "Data");
  await page.goBack(); await title(page, "Local shell · Local · Sessions");
  expect(page.url()).toBe(url);
}), 30000);

test("a terminal exit retitles its exact session and cannot retitle another view", () => fresh(async page => {
  await page.goto(href("session=local")); await title(page, "Local shell · Local · Sessions");
  await waitAttachment(page);
  const url = page.url(), historyLength = await page.evaluate(() => history.length);
  for (const ws of attachments) ws.send(JSON.stringify({ t: "exit", code: 3 }));
  await title(page, "Exited · Local shell · Local · Sessions");
  await page.getByTestId("term-exited").getByText("session exited (3)").waitFor();
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.getByTestId("nav-data").click(); await title(page, "Data");
  for (const ws of attachments) ws.send(JSON.stringify({ t: "exit", code: 5 }));
  await page.waitForTimeout(100); await title(page, "Data");
}), 30000);

test("saved exited and lost sessions keep distinct titles on direct links and reload", () => fresh(async page => {
  answers[""] = { sessions: [{ ...shell("old-exit", "Old shell"), state: "exited" }, { ...shell("lost", "Lost shell"), state: "lost" }] };
  await page.goto(href("session=old-exit")); await title(page, "Exited · Old shell · Local · Sessions");
  await page.reload(); await title(page, "Exited · Old shell · Local · Sessions");
  await page.goto(href("session=lost")); await title(page, "Lost · Lost shell · Local · Sessions");
  await page.reload(); await title(page, "Lost · Lost shell · Local · Sessions");
}), 30000);

test("a delayed filtered peer cannot be replaced by an available local session", () => fresh(async page => {
  heldNode = "peer-b";
  await page.goto(href("filter=peer-b")); await waitHeld(page); await title(page, "Loading sessions · Peer B");
  expect(await param(page, "session")).toBe(null); expect(await param(page, "new")).toBe(null);
  const before = await page.evaluate(() => history.length);
  release(); await title(page, "B shell · Peer B · Sessions"); expect(await page.evaluate(() => history.length)).toBe(before);
}), 30000);

test("total session failures never turn into an empty New form and can recover in place", () => fresh(async page => {
  for (const node of Object.keys(answers)) answers[node] = { status: 503, error: "Temporarily unavailable" };
  await page.goto(href()); await title(page, "Sessions unavailable"); await page.getByTestId("term-unavailable").waitFor();
  expect(await param(page, "new")).toBe(null); await page.reload(); await title(page, "Sessions unavailable");
  answers[""] = { sessions: [shell("local", "Recovered local")] };
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await title(page, "Recovered local · Local · Sessions");
}), 30000);

test("peer links show a fleet lookup error while local sessions remain usable", () => fresh(async page => {
  fleetStatus = 503;
  await page.goto(href("node=peer-b&session=b")); await title(page, "Sessions unavailable · peer-b");
  await page.getByTestId("term-fleet-error").waitFor(); expect(await param(page, "session")).toBe("b");
  await page.goto(href()); await title(page, "Local shell · local · Sessions");
}), 30000);

test("a local 401 locks even when its message does not say Unauthorized; a peer 401 does not", () => fresh(async page => {
  answers["peer-a"] = { status: 401, error: "Sign in again" };
  await page.goto(href("session=a&node=peer-a")); await title(page, "Access denied · Peer A");
  expect(await page.getByPlaceholder("access token").count()).toBe(0);
  answers[""] = { status: 401, error: "Sign in again" };
  event(); await title(page, "Locked"); await page.getByPlaceholder("access token").waitFor();
}), 30000);

test("fleet authentication failures lock with the original URL intact", () => fresh(async page => {
  fleetStatus = 401;
  await page.goto(href("filter=peer-b")); await title(page, "Locked");
  expect(await param(page, "filter")).toBe("peer-b"); expect(attaches).toBe(0);
}), 30000);

for (const oldStatus of [200, 401, 503]) test(`late session result ${oldStatus} cannot replace a newer list, title or authentication state`, () => fresh(async page => {
  await page.goto(href("session=local")); await title(page, "Local shell · Local · Sessions");
  answers[""] = oldStatus === 200 ? { sessions: [shell("local", "Stale title")] } : { status: oldStatus, error: "Stale failure" };
  heldNode = ""; event(); await waitHeld(page);
  heldNode = null; answers[""] = { sessions: [shell("local", "Latest title")] }; event(); await title(page, "Latest title · Local · Sessions");
  const before = await page.evaluate(() => history.length);
  release(); await page.waitForTimeout(150);
  expect(await page.title()).toBe("Latest title · Local · Sessions · Cyberdeck");
  expect(await page.getByTestId("term-node-errors").count()).toBe(0); expect(await page.evaluate(() => history.length)).toBe(before);
  expect(attaches).toBe(1);
}), 30000);

test("late failures cannot retitle another primary view or rewrite its route", () => fresh(async page => {
  answers["peer-a"] = { status: 503, error: "Late peer failure" }; heldNode = "peer-a";
  await page.goto(href("node=peer-a&session=a")); await waitHeld(page);
  await page.getByTestId("nav-data").click(); await title(page, "Data"); const url = page.url();
  release(); await page.waitForTimeout(150); expect(page.url()).toBe(url); expect(await page.title()).toBe("Data · Cyberdeck");
}), 30000);


test("regular polling does not starve a slow session response", () => fresh(async page => {
  heldNode = "peer-b";
  await page.goto(href("filter=peer-b")); await waitHeld(page);
  // Sessions and the persistent prompt strip each own a poller. Wait for both
  // initial reads before measuring; under load the second can arrive later.
  for (let i = 0; i < 200 && held.size < 2; i++) await page.waitForTimeout(10);
  expect(held.size).toBe(2);
  const count = held.size;
  await page.waitForTimeout(4400); expect(held.size).toBe(count);
  release(); await title(page, "B shell · Peer B · Sessions");
}), 30000);

const cwdInput = (page: Page) => page.locator('[data-testid="term-new-form"] input[list="cwd-options"]');
const cmdInput = (page: Page) => page.getByPlaceholder("startup command (optional), e.g. claude --dangerously-skip-permissions");

test("New-session drafts stay scoped to the machine and prefill through history and primary views", () => fresh(async page => {
  await page.goto(href("new=1&node=peer-a&cwd=%2Fprefilled")); await title(page, "New session on Peer A");
  await cwdInput(page).fill("/a-draft"); await cmdInput(page).fill("private command A");
  const url = page.url(), before = await page.evaluate(() => history.length);
  await page.getByTestId("term-new-node").selectOption("peer-b"); await title(page, "New session on Peer B");
  expect(await cwdInput(page).inputValue()).toBe("/prefilled"); expect(await cmdInput(page).inputValue()).toBe("");
  await cwdInput(page).fill("/b-draft"); await cmdInput(page).fill("private command B");
  await page.goBack(); await title(page, "New session on Peer A");
  expect(await cwdInput(page).inputValue()).toBe("/a-draft"); expect(await cmdInput(page).inputValue()).toBe("private command A");
  await page.goForward(); await title(page, "New session on Peer B");
  expect(await cwdInput(page).inputValue()).toBe("/b-draft"); expect(await cmdInput(page).inputValue()).toBe("private command B");
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.getByTestId("nav-data").click(); await title(page, "Data");
  await page.goBack(); await title(page, "New session on Peer B");
  expect(await cmdInput(page).inputValue()).toBe("private command B");
  await page.evaluate(() => { location.hash = "#/term?new=1&node=peer-a&cwd=%2Fanother"; });
  await title(page, "New session on Peer A"); expect(await cwdInput(page).inputValue()).toBe("/another"); expect(await cmdInput(page).inputValue()).toBe("");
  await page.goBack(); await title(page, "New session on Peer B"); expect(await cmdInput(page).inputValue()).toBe("private command B");
  const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state, url: location.href }));
  expect(persisted).not.toContain("private command"); expect(persisted).not.toContain("/b-draft");
  await page.reload(); await title(page, "New session on Peer B"); expect(await cmdInput(page).inputValue()).toBe(""); expect(await cwdInput(page).inputValue()).toBe("/prefilled");
  const tab = await browser.newPage(); try { await tab.goto(url); await title(tab, "New session on Peer A"); expect(await cmdInput(tab).inputValue()).toBe(""); expect(await cwdInput(tab).inputValue()).toBe("/prefilled"); } finally { await tab.close(); }
  expect(creations).toEqual([]); expect(attaches).toBe(0);
}), 30000);

test("drafts clear at authentication lock without entering links or starting a session", () => fresh(async page => {
  await page.goto(href("new=1")); await title(page, "New session on Local");
  await cmdInput(page).fill("discard on lock");
  answers[""] = { status: 401, error: "Sign in again" }; event(); await title(page, "Locked");
  answers[""] = { sessions: [] };
  await page.getByPlaceholder("access token").fill("synthetic-token"); await page.getByRole("button", { name: /unlock/i }).click();
  await title(page, "New session on Local"); expect(await cmdInput(page).inputValue()).toBe(""); expect(creations).toEqual([]);
}), 30000);

test("an explicit pending Open stays on its original machine, cannot duplicate, and preserves newer drafts", () => fresh(async page => {
  allowCreate = true; holdCreate = true;
  await page.goto(href("new=1&node=peer-a&filter=peer-b")); await title(page, "New session on Peer A");
  await cwdInput(page).fill("/submitted-a"); await cmdInput(page).fill("submitted A");
  await page.getByTestId("term-new-open").click();
  for (let i = 0; i < 200 && !createWaiters.size; i++) await page.waitForTimeout(10);
  expect(createWaiters.size).toBe(1); expect(await page.getByTestId("term-new-open").isDisabled()).toBe(true);
  await cmdInput(page).fill("newer A");
  await page.getByTestId("term-new-node").selectOption("peer-b"); await title(page, "New session on Peer B");
  await cmdInput(page).fill("newer B"); const destination = page.url();
  release(); await page.waitForTimeout(150); expect(page.url()).toBe(destination); expect(await cmdInput(page).inputValue()).toBe("newer B");
  await page.goBack(); await title(page, "New session on Peer A"); expect(await cmdInput(page).inputValue()).toBe("newer A");
  expect(creations.length).toBe(1); expect(creations[0].node).toBe("peer-a"); expect(creations[0].cmd).toBe("submitted A"); expect(creations[0].cwd).toBe("/submitted-a");
}), 30000);

test("successful explicit Open selects its session once, keeps the filter and clears only the submitted draft", () => fresh(async page => {
  allowCreate = true;
  await page.goto(href("new=1&node=peer-a&filter=peer-b")); await title(page, "New session on Peer A");
  await cmdInput(page).fill("explicit fixture command"); const before = await page.evaluate(() => history.length);
  await page.getByTestId("term-new-open").click(); await title(page, "Created fixture · Peer A · Sessions");
  expect(await param(page, "filter")).toBe("peer-b"); expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack(); await title(page, "New session on Peer A"); expect(await cmdInput(page).inputValue()).toBe("");
  await page.goForward(); await title(page, "Created fixture · Peer A · Sessions"); expect(creations.length).toBe(1);
}), 30000);

test("an empty machine with a failed Seed listing is unavailable rather than silently empty", () => fresh(async page => {
  answers["peer-b"] = { sessions: [], seedError: "Seed list unavailable" };
  await page.goto(href("filter=peer-b")); await title(page, "Sessions unavailable · Peer B"); expect(await param(page, "new")).toBe(null);
}), 30000);

test("a genuinely empty fleet still defaults to New without replaying a command", () => fresh(async page => {
  for (const node of Object.keys(answers)) answers[node] = { sessions: [] };
  await page.goto(href()); await title(page, "New session on Local"); expect(await param(page, "new")).toBe("1"); expect(creations).toEqual([]);
}), 30000);
