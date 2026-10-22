import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";

// Production React bundle, fake read-only telemetry. No fleet benchmark runs.
const mutations: string[] = [], errors: string[] = [], requests: string[] = [];
const names = ["yacht", "sentinel", "peer / & café"];
const ids = [null, "peer-s", "peer/encoded"];
const snapshot = (source: string) => ({ source, nodes: names.map((name, i) => ({
  name, id: name === source ? null : ids[i] || "peer-y", local: name === source,
  kind: i ? "server" : "laptop", roles: ["cyberdeck"], services: [],
})), samples: [{ source: "yacht", target: "sentinel", at: Date.now() - 120_000, uploadMbps: 30, downloadMbps: 15, latencyMs: 4, bytes: 1 }], running: null, automatic: false });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const url = new URL(req.url), path = url.pathname;
  if (path.startsWith("/api/")) {
    requests.push(path);
    if (req.method !== "GET") { mutations.push(path); return Response.json({error:"No test actions allowed"}, {status:405}); }
    if (path === "/api/auth/whoami") return Response.json({method:"none"});
    if (path === "/api/fleet/nodes") return Response.json({self:{nodeId:"local",name:"yacht",urls:[]},nodes:[]});
    if (path === "/api/status") return Response.json({nodeName:"yacht",version:"fixture",roots:[],repos:0});
    if (path === "/api/network") return Response.json(snapshot("yacht"));
    if (path === "/api/nodes/peer-s/proxy/network") return Response.json(snapshot("sentinel"));
    if (path === "/api/nodes/peer%2Fencoded/proxy/network") return Response.json(snapshot(names[2]));
    if (path === "/api/cmux/tree") return Response.json({available:false,tree:[]});
    if (path === "/api/repos") return Response.json([]);
    if (path === "/api/sessions") return Response.json({sessions:[]});
    if (path === "/api/control/overview") return Response.json({fleetDir:"/deck",status:{host:"yacht",hosts:[],handoffOpen:0,repo:{branch:"fixture",dirty:0},sessionsIndexed:0},projects:[],todo:{sections:[]},handoff:[],collab:{tasks:[],runs:[],auto:false},services:{rows:[]}});
    return Response.json({error:"Fixture unavailable"},{status:404});
  }
  const file = Bun.file(join(process.env.CYBERDECK_TEST_UI || join(import.meta.dir,"../dist/ui"), path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found",{status:404});
}});
let browser: Browser;
beforeAll(async()=> { browser = await chromium.launch(); });
afterAll(async()=> { await browser?.close(); server.stop(true); expect(errors).toEqual([]); expect(mutations).toEqual([]); });
async function fresh(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  page.setDefaultTimeout(8000);
  page.on("pageerror", e => errors.push(e.message));
  try { await run(page); } catch (error) { console.error(JSON.stringify({title:await page.title(),body:(await page.locator("body").innerText()).slice(0,2500),errors,requests:requests.slice(-20)})); throw error; } finally { await page.close(); }
}
const title = (page: Page, value: string) => page.waitForFunction(value => document.title === value, value);
const pair = async (page: Page, from: string, to: string) => {
  await page.waitForFunction(([from,to]) => (document.querySelector('[aria-label="Network source"]') as HTMLSelectElement)?.value === from && (document.querySelector('[aria-label="Network target"]') as HTMLSelectElement)?.value === to, [from,to]);
};
const href = (from: string, to: string) => `${server.url}#/fleet?${new URLSearchParams({networkFrom:from,networkTo:to})}`;

test("Network selections make one canonical history step; direct links, new tabs and reload restore the pair", () => fresh(async page => {
  await page.goto(`${server.url}#/fleet`); await pair(page,"yacht","sentinel"); await title(page,"Home · Cyberdeck");
  expect(new URL(page.url()).hash).toBe("#/fleet");
  const before = await page.evaluate(()=>history.length);
  await page.getByRole("button",{name:`Inspect ${names[2]}`,exact:true}).click();
  await pair(page,"yacht",names[2]); await title(page,`yacht → ${names[2]} · Network · Cyberdeck`);
  expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.getByRole("button",{name:`Inspect ${names[2]}`,exact:true}).click();
  expect(await page.evaluate(()=>history.length)).toBe(before+1);
  const url = page.url();
  await page.getByLabel("Network source",{exact:true}).selectOption(names[2]);
  await pair(page,names[2],"yacht");
  expect(await page.evaluate(()=>history.length)).toBe(before+2);
  await page.goBack(); await pair(page,"yacht",names[2]);
  await page.goBack(); await pair(page,"yacht","sentinel"); await title(page,"Home · Cyberdeck");
  await page.goForward(); await pair(page,"yacht",names[2]);
  await page.reload(); await pair(page,"yacht",names[2]);
  await fresh(async tab => { await tab.goto(url); await pair(tab,"yacht",names[2]); await title(tab,`yacht → ${names[2]} · Network · Cyberdeck`); });
  expect(requests).toContain("/api/nodes/peer%2Fencoded/proxy/network");
}), 30000);

test("Partial and whitespace links replace defaults without an extra Back entry; orientation is retained", () => fresh(async page => {
  await page.goto(`${server.url}#/data`);
  const before = await page.evaluate(()=>history.length);
  await page.evaluate(()=>location.hash="#/fleet?networkFrom=+sentinel+");
  await pair(page,"sentinel","peer / & café");
  await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).get("networkFrom")==="sentinel" && new URLSearchParams(location.hash.split("?")[1]).get("networkTo")==="peer / & café");
  expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.goBack(); await title(page,"Data · Cyberdeck");
  await page.goto(href("sentinel","yacht")); await pair(page,"sentinel","yacht");
  await title(page,"sentinel → yacht · Network · Cyberdeck");
  expect(await page.getByTestId("network-map").textContent()).toContain("15.0 Mbps");
}), 30000);

test("Missing and identical endpoints retain honest selection/error titles and never offer a benchmark", () => fresh(async page => {
  await page.goto(href("missing","sentinel")); await pair(page,"missing","sentinel");
  await title(page,"Network host not found: missing · Cyberdeck");
  expect(await page.getByRole("button",{name:"Test connection ↗"}).isDisabled()).toBe(true);
  await page.reload(); await title(page,"Network host not found: missing · Cyberdeck");
  await page.getByRole("button",{name:"Clear selection"}).click(); await title(page,"Home · Cyberdeck");
  await page.goBack(); await title(page,"Network host not found: missing · Cyberdeck");
  await page.goto(href("yacht","yacht")); await pair(page,"yacht","yacht");
  await title(page,"Choose two different network hosts · Cyberdeck");
  expect(await page.getByRole("button",{name:"Test connection ↗"}).isDisabled()).toBe(true);
  await page.getByTestId("nav-data").click(); await title(page,"Data · Cyberdeck");
}), 30000);

test("Unavailable telemetry and recovery retain the requested pair and title ownership", () => fresh(async page => {
  await page.route("**/api/network",route=>route.fulfill({status:503,json:{error:"Fixture network offline"}}));
  await page.goto(href("yacht","sentinel")); await title(page,"Network unavailable · Cyberdeck");
  await page.getByRole("alert").filter({hasText:"Fixture network offline"}).waitFor();
  await page.unroute("**/api/network");
  await page.getByTestId("network-map").getByRole("button",{name:"Retry",exact:true}).click();
  await pair(page,"yacht","sentinel"); await title(page,"yacht → sentinel · Network · Cyberdeck");
  await page.route("**/api/nodes/peer-s/proxy/network",route=>route.fulfill({status:503,json:{error:"Offline peer"}}));
  await page.goto(href("sentinel","yacht")); await page.reload(); await pair(page,"sentinel","yacht");
  await title(page,"sentinel → yacht · Network · Cyberdeck");
  expect(await page.getByRole("button",{name:"Test connection ↗"}).isDisabled()).toBe(true);
  await page.getByText("Source telemetry unavailable.",{exact:false}).waitFor();
}), 30000);

test("Late telemetry cannot restore an old selection or replace another view's title", () => fresh(async page => {
  let release: (() => void) | undefined;
  await page.route("**/api/network",async route=> { await new Promise<void>(resolve=>release=resolve); await route.fulfill({json:snapshot("yacht")}); });
  try {
    await page.goto(href("yacht","sentinel"));
    await page.waitForFunction(()=>document.title==="yacht → sentinel · Network · Cyberdeck");
    while(!release) await page.waitForTimeout(10);
    await page.evaluate(()=>location.hash="#/fleet?networkFrom=sentinel&networkTo=yacht");
    release(); await pair(page,"sentinel","yacht"); await title(page,"sentinel → yacht · Network · Cyberdeck");
    await page.unroute("**/api/network");
    await page.getByTestId("nav-data").click(); await title(page,"Data · Cyberdeck");
    await page.route("**/api/network",async route=> { await new Promise<void>(resolve=>release=resolve); await route.fulfill({status:503,json:{error:"Late offline"}}); });
    release=undefined;
    await page.evaluate(()=>location.hash="#/fleet?networkTo=sentinel");
    while(!release) await page.waitForTimeout(10);
    await page.getByTestId("nav-data").click(); await title(page,"Data · Cyberdeck");
    release(); await page.waitForTimeout(100); expect(await page.title()).toBe("Data · Cyberdeck");
  } finally { release?.(); }
}), 30000);


test("Authentication owns the title and keeps the network destination for unlock", () => fresh(async page => {
  await page.route("**/api/status",route=>route.fulfill({status:401,json:{error:"Locked"}}));
  await page.goto(href("yacht","sentinel")); await page.getByPlaceholder("access token").waitFor();
  await title(page,"Locked · Cyberdeck");
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("networkTo")).toBe("sentinel");
  await page.waitForTimeout(100); expect(await page.title()).toBe("Locked · Cyberdeck");
  await page.unroute("**/api/status");
  await page.reload(); await pair(page,"yacht","sentinel"); await title(page,"yacht → sentinel · Network · Cyberdeck");
}), 30000);
