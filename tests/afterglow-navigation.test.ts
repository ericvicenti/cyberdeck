import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const errors: string[] = [];
const childRequests: { method: string; path: string }[] = [];

const fixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Afterglow</title></head>
<body>
  <nav>
    <button id="series">Series</button>
    <button id="episode">Episode 1</button>
    <button id="player">Open player</button>
  </nav>
  <h1 id="heading"></h1><output id="route"></output>
  <script>
    (() => {
      const clean = value => typeof value === "string" && value.length <= 4096 && !/[\\u0000-\\u001f]/.test(value)
        ? value.replace(/^#\\/?/, "") || "discover" : "discover";
      const route = () => clean(location.hash);
      let parentOrigin = null;
      try {
        const candidate = new URLSearchParams(location.search).get("cyberdeck");
        if (window.parent !== window && candidate && new URL(candidate).origin === candidate) parentOrigin = candidate;
      } catch {}
      const title = value => value.startsWith("watch/") ? "Playing Episode 2 · Afterglow"
        : value.startsWith("title/series/") ? "Example Show · Season " + (new URLSearchParams(value.split("?")[1]).get("season") || "1") + " · Episode " + (new URLSearchParams(value.split("?")[1]).get("episode") || "1") + " · Afterglow"
        : value === "series" ? "Series · Afterglow" : "Discover · Afterglow";
      const paint = () => {
        const value = route();
        document.querySelector("#route").textContent = value;
        document.querySelector("#heading").textContent = title(value).replace(" · Afterglow", "");
        document.title = title(value);
        if (parentOrigin) parent.postMessage({type:"afterglow:title", route:value, title:document.title}, parentOrigin);
      };
      const go = (value, mode = "push") => {
        value = clean(value);
        history[parentOrigin || mode === "replace" ? "replaceState" : "pushState"](null, "", "#" + value);
        paint();
        if (parentOrigin) parent.postMessage({type:"afterglow:navigation", route:value, title:document.title, mode}, parentOrigin);
      };
      addEventListener("message", event => {
        if (!parentOrigin || event.source !== parent || event.origin !== parentOrigin) return;
        if (event.data?.type === "cyberdeck:reload") return location.reload();
        if (event.data?.type === "cyberdeck:navigate" && typeof event.data.route === "string") go(event.data.route, "replace");
      });
      document.querySelector("#series").onclick = () => go("series");
      document.querySelector("#episode").onclick = () => go("title/series/tt999?season=2&episode=1&q=" + encodeURIComponent("A & B? #/ ü"));
      document.querySelector("#player").onclick = () => go("watch/42/3?playlist=evening&entry=episode-2");
      paint();
      if (parentOrigin) parent.postMessage({type:"afterglow:ready", route:route(), title:document.title}, parentOrigin);
    })();
  </script>
</body></html>`;

const otherHtml = `<!doctype html><html><body><h1>Other application</h1></body></html>`;

const child = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    childRequests.push({ method: request.method, path: url.pathname });
    return new Response(url.pathname === "/other" ? otherHtml : fixtureHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

const hostile = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("<!doctype html><html><body>Wrong origin</body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  }),
});

const parent = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/applications") {
      return Response.json({
        applications: [
          { id: "afterglow", name: "Afterglow", description: "Private cinema", url: `${child.url}?relay=fixture` },
          { id: "other", name: "Other", description: "Another app", url: `${child.url}other` },
        ],
      });
    }
    if (path === "/api/fleet/nodes") return Response.json({ self: { nodeId: "test", name: "Test" }, nodes: [] });
    if (path.startsWith("/api/")) return Response.json({ error: "Not part of fixture" }, { status: 404 });
    const file = Bun.file(join(import.meta.dir, "../dist/ui", path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});

let browser: Browser;
let page: Page;
const afterglow = () => page.frameLocator('iframe[title="Afterglow"]');
const nestedRoute = "title/series/tt999?season=2&episode=2&q=" + encodeURIComponent("A & B? #/ ü");
const outerUrl = (route: string) => `${parent.url}#/applications?${new URLSearchParams({ app: "afterglow", route })}`;
const currentRoute = () => page.evaluate(() => new URLSearchParams(location.hash.split("?")[1]).get("route"));

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
});

afterAll(async () => {
  await browser?.close();
  parent.stop(true);
  child.stop(true);
  hostile.stop(true);
});

test("deep links preserve encoded title state through refresh", async () => {
  await page.goto(outerUrl(nestedRoute));
  await afterglow().getByRole("heading", { name: "Example Show · Season 2 · Episode 2" }).waitFor();
  expect(await currentRoute()).toBe(nestedRoute);
  expect(await afterglow().locator("#route").textContent()).toBe(nestedRoute);
  expect(await page.title()).toBe("Example Show · Season 2 · Episode 2 · Afterglow · Cyberdeck");

  const frameSrc = await page.locator('[data-testid="afterglow-frame"]').getAttribute("src");
  const parsedSrc = new URL(frameSrc!);
  expect(parsedSrc.searchParams.get("relay")).toBe("fixture");
  expect(parsedSrc.searchParams.get("cyberdeck")).toBe(parent.url.origin);
  expect(parsedSrc.hash.slice(1)).toBe(nestedRoute);
  expect(page.url()).not.toContain("relay=fixture");

  await page.reload();
  await afterglow().getByRole("heading", { name: "Example Show · Season 2 · Episode 2" }).waitFor();
  expect(await currentRoute()).toBe(nestedRoute);
});

test("child navigation adds one outer entry and Back/Forward keeps the iframe alive", async () => {
  await page.goto(outerUrl(nestedRoute));
  await afterglow().locator("#route").waitFor();
  const before = await page.evaluate(() => history.length);
  const frame = page.frames().find(candidate => candidate.url().startsWith(child.url.href))!;
  await frame.evaluate(() => ((window as Window & { fixtureIdentity?: string }).fixtureIdentity = "same-document"));

  await afterglow().getByRole("button", { name: "Series" }).click();
  await page.waitForFunction(() => new URLSearchParams(location.hash.split("?")[1]).get("route") === "series");
  expect(await page.evaluate(() => history.length)).toBe(before + 1);

  await page.goBack();
  await afterglow().getByRole("heading", { name: "Example Show · Season 2 · Episode 2" }).waitFor();
  expect(await currentRoute()).toBe(nestedRoute);
  await page.goForward();
  await afterglow().getByRole("heading", { name: "Series" }).waitFor();
  expect(await frame.evaluate(() => (window as Window & { fixtureIdentity?: string }).fixtureIdentity)).toBe("same-document");
});

test("episode and player routes are history-only and never trigger an action", async () => {
  await page.goto(outerUrl(nestedRoute));
  await afterglow().getByRole("button", { name: "Episode 1" }).click();
  const episode = "title/series/tt999?season=2&episode=1&q=" + encodeURIComponent("A & B? #/ ü");
  await page.waitForFunction(value => new URLSearchParams(location.hash.split("?")[1]).get("route") === value, episode);
  await afterglow().getByRole("button", { name: "Open player" }).click();
  const player = "watch/42/3?playlist=evening&entry=episode-2";
  await page.waitForFunction(value => new URLSearchParams(location.hash.split("?")[1]).get("route") === value, player);
  expect(await page.title()).toBe("Playing Episode 2 · Afterglow · Cyberdeck");

  await page.goBack();
  expect(await currentRoute()).toBe(episode);
  await page.goForward();
  expect(await currentRoute()).toBe(player);
  await page.reload();
  await afterglow().getByRole("heading", { name: "Playing Episode 2" }).waitFor();
  expect(await currentRoute()).toBe(player);
  expect(childRequests.every(request => request.method === "GET")).toBe(true);
});

test("wrapper Reload retains the nested URL and does not add history", async () => {
  await page.goto(outerUrl(nestedRoute));
  await afterglow().locator("#route").waitFor();
  const before = await page.evaluate(() => ({ length: history.length, href: location.href }));
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await afterglow().getByRole("heading", { name: "Example Show · Season 2 · Episode 2" }).waitFor();
  expect(await page.evaluate(() => ({ length: history.length, href: location.href }))).toEqual(before);
});

test("selecting another app clears nested state and Back restores Afterglow", async () => {
  await page.goto(outerUrl(nestedRoute));
  await afterglow().locator("#route").waitFor();
  await page.getByRole("button", { name: "← Applications", exact: true }).click();
  await page.getByRole("heading", { name: "Applications", exact: true }).waitFor();
  await page.getByRole("button", { name: /Open Other/ }).click();
  await page.frameLocator('iframe[title="Other"]').getByRole("heading", { name: "Other application" }).waitFor();
  expect(new URLSearchParams(page.url().split("?")[1]).has("route")).toBe(false);

  await page.goBack();
  await page.getByRole("heading", { name: "Applications", exact: true }).waitFor();
  await page.goBack();
  await afterglow().getByRole("heading", { name: "Example Show · Season 2 · Episode 2" }).waitFor();
  expect(await currentRoute()).toBe(nestedRoute);
  expect(await page.title()).toBe("Example Show · Season 2 · Episode 2 · Afterglow · Cyberdeck");
});

test("wrong source and wrong origin messages cannot change URL or title", async () => {
  await page.goto(outerUrl(nestedRoute));
  await afterglow().locator("#route").waitFor();
  const before = { url: page.url(), title: await page.title() };

  await page.evaluate(() => window.postMessage({ type: "afterglow:navigation", route: "forged", title: "Forged" }, location.origin));
  const sibling = await page.evaluate(origin => {
    const iframe = document.createElement("iframe");
    iframe.src = origin;
    iframe.name = "sibling-forger";
    document.body.append(iframe);
    return iframe.name;
  }, child.url.href);
  await page.waitForFunction(() => Array.from(document.querySelectorAll("iframe")).some(frame => frame.name === "sibling-forger" && frame.contentWindow));
  const siblingFrame = page.frames().find(candidate => candidate.name() === sibling)!;
  await siblingFrame.evaluate(() => parent.postMessage({ type: "afterglow:navigation", route: "forged", title: "Forged" }, "*"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  expect(page.url()).toBe(before.url);
  expect(await page.title()).toBe(before.title);

  const realFrame = page.frames().find(candidate => candidate.url().startsWith(child.url.href))!;
  await realFrame.goto(hostile.url.href);
  await realFrame.evaluate(() => parent.postMessage({ type: "afterglow:navigation", route: "forged", title: "Forged" }, "*"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(page.url()).toBe(before.url);
  expect(await page.title()).toBe(before.title);
  expect(errors).toEqual([]);
});
