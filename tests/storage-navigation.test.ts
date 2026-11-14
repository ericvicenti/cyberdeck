import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";

// Production UI with synthetic read-only disks. No real disk or fleet action.
const errors: string[] = [], mutations: string[] = [], requests: string[] = [];
const pending = new Set<() => void>();
let legacy = false;
let status = 200, malformed = "", heldNode = "", heldStatus = 200, holdFleet = false, fleetStatus = 200, revision = 1;
const encodedNode = "peer /?&";
const filesystem = "tank/data /?&", mount = "/mnt/Shared /?&";
const disk = () => ({ filesystem, mount, totalBytes: 100 * 1024 ** 3, usedBytes: 40 * 1024 ** 3, freeBytes: 60 * 1024 ** 3, percent: 40, paths: [mount], poolHealth: "ONLINE" });
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/api/")) {
    requests.push(path);
    if (req.method !== "GET") { mutations.push(path); return Response.json({error:"No writes"},{status:405}); }
    if (path === "/api/auth/whoami") return Response.json({method:"none"});
    if (path === "/api/fleet/nodes") {
      const responseStatus = fleetStatus;
      if (holdFleet) await new Promise<void>(release => pending.add(release));
      if (responseStatus !== 200) return Response.json({error:"Fixture fleet read failed"},{status:responseStatus});
      return Response.json({self:{nodeId:"local",name:"Local",urls:[]},nodes:[{id:"peer-a",name:"Peer A",online:true},{id:"peer-b",name:"Peer B",online:true},{id:encodedNode,name:"Encoded peer",online:true},{id:"sleeping",name:"Sleeping peer",online:false}]});
    }
    if (path.endsWith("/disks") || path.endsWith("/dashboard")) {
      if (legacy && path.endsWith("/disks")) return Response.json({error:"No such endpoint"},{status:404});
      const node = path.startsWith("/api/nodes/") ? decodeURIComponent(path.split("/")[3]) : "self";
      const responseStatus = node === heldNode ? heldStatus : status, bad = malformed, at = revision;
      if (node === heldNode) await new Promise<void>(release => pending.add(release));
      if (responseStatus !== 200) return Response.json({error:"Fixture disk probe failed"},{status:responseStatus});
      return Response.json(bad === "response" ? null : {at, disks: bad === "disks" ? {} : bad === "entry" ? [{...disk(),paths:null}] : [disk(),{...disk(),filesystem:"other-volume",mount:"/other"}]});
    }
    if (path === "/api/status") return Response.json({nodeName:"Local",roots:[],repos:0});
    if (path === "/api/repos") return Response.json([]);
    if (path === "/api/cmux/tree") return Response.json({available:false,tree:[]});
    if (path.endsWith("/sessions")) return Response.json({sessions:[]});
    if (path === "/api/fs/list") return Response.json({path:"/",home:"/",parent:null,entries:[],users:{},groups:{}});
    return Response.json({error:"Fixture unavailable"},{status:404});
  }
  if (process.env.CYBERDECK_TEST_ORIGIN) {
    const origin = new URL(process.env.CYBERDECK_TEST_ORIGIN);
    if (!["127.0.0.1","localhost"].includes(origin.hostname)) throw new Error("Expected loopback tunnel");
    return fetch(new URL(path,origin));
  }
  const file = Bun.file(join(process.env.CYBERDECK_TEST_UI || join(import.meta.dir,"../dist/ui"),path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found",{status:404});
}});
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { for(const release of pending)release(); await browser.close(); fixture.stop(true); expect(errors).toEqual([]); expect(mutations).toEqual([]); });
async function fresh(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(process.env.CYBERDECK_TEST_ORIGIN ? 30000 : 12000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === fixture.url.origin ? route.continue() : route.abort());
  try { await run(page); } catch(error) { console.error(JSON.stringify({title:await page.title(),body:(await page.locator("body").innerText()).slice(0,2000),requests:requests.slice(-10)}));throw error; }
  finally { legacy=false;status=200;malformed="";heldNode="";heldStatus=200;holdFleet=false;fleetStatus=200;revision=1;for(const release of pending)release();pending.clear();await page.close(); }
}
const href = (node = "self", extra = "", fields: Record<string,string> = {}) => `${fixture.url}#/storage?${new URLSearchParams({filesystem,mount,...(node ? {node} : {}),...fields})}${extra}`;
const title = (page: Page, value: string) => page.waitForFunction(value => document.title === value,value);
const success = (name = "Local", path = mount) => `${path} · Storage · ${name} · Cyberdeck`;
const budget = process.env.CYBERDECK_TEST_ORIGIN ? 90000 : 30000;

test("Storage links restore the exact volume and encoded node across reload, new tabs and history", () => fresh(async page => {
  await page.addInitScript(() => localStorage.setItem("cyberdeck-node","peer-b"));
  await page.goto(href(encodedNode));await title(page,success("Encoded peer"));
  await page.getByRole("region",{name:"Storage identity"}).getByText(filesystem,{exact:true}).waitFor();
  const link=page.url();await page.reload();await title(page,success("Encoded peer"));
  await fresh(async tab=>{await tab.goto(link);await title(tab,success("Encoded peer"));});
  await page.evaluate(url=>location.hash=new URL(url).hash,href());await title(page,success());
  await page.goBack();await title(page,success("Encoded peer"));await page.goForward();await title(page,success());
  expect(requests).toContain(`/api/nodes/${encodeURIComponent(encodedNode)}/proxy/disks`);
}), budget);

test("Storage canonical defaults and duplicate values replace once while invalid, absent and unpaired links stay honest", () => fresh(async page => {
  await page.goto(`${fixture.url}#/data`);const before=await page.evaluate(()=>history.length);
  await page.evaluate(url=>location.hash=new URL(url).hash,href("", "&mount=%2Fwrong"));await title(page,success());
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).getAll("mount")).toEqual([mount]);
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("node")).toBe("self");
  expect(await page.evaluate(()=>history.length)).toBe(before+1);await page.goBack();await title(page,"Data · Cyberdeck");
  const count=requests.filter(path=>path.endsWith("/disks")).length;
  await page.goto(`${fixture.url}#/storage`);await title(page,"No storage item selected · Storage · Local · Cyberdeck");
  await page.goto(href("not-paired"));await title(page,"Machine not paired · Storage · not-paired · Cyberdeck");
  await page.goto(href("sleeping"));await title(page,"Machine offline · Storage · Sleeping peer · Cyberdeck");
  await page.goto(href("self","",{filesystem:"bad\u0000link"}));await title(page,"Invalid storage link · Cyberdeck");
  expect(requests.filter(path=>path.endsWith("/disks")).length).toBe(count);
}), budget);

test("Storage denied, unavailable and malformed reads retry at the same URL and missing volume titles survive reload", () => fresh(async page => {
  for(const problem of [403,503,"response","disks","entry"]){
    await page.goto("about:blank");status=typeof problem === "number" ? problem : 200;malformed=typeof problem === "string" ? problem : "";
    await page.goto(href("peer-a"));await title(page,`${problem === 403 ? "Storage access denied" : "Storage unavailable"} · Peer A · Cyberdeck`);
    const link=page.url();status=200;malformed="";
    await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,success("Peer A"));expect(page.url()).toBe(link);
  }
  await page.goto(href("peer-a","",{mount:"/missing"}));
  await title(page,"Storage item not found · Peer A · Cyberdeck");await page.reload();await title(page,"Storage item not found · Peer A · Cyberdeck");
}), budget);

test("Storage node transitions discard old errors and late reads cannot rename a later machine or view", () => fresh(async page => {
  status=503;await page.goto(href("peer-b"));await title(page,"Storage unavailable · Peer B · Cyberdeck");
  status=200;heldNode="peer-a";heldStatus=200;
  await page.evaluate(url=>location.hash=new URL(url).hash,href("peer-a"));await title(page,"Loading storage · Peer A · Cyberdeck");
  expect(await page.getByText(/Fixture disk probe failed/).count()).toBe(0);
  await page.evaluate(url=>location.hash=new URL(url).hash,href());await title(page,success());
  heldNode="";for(const release of pending)release();pending.clear();await page.waitForTimeout(150);expect(await page.title()).toBe(success());
  await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
}), budget);

test("Storage overlapping polls retain the newest reading and failed refreshes keep the last volume with an honest title", () => fresh(async page => {
  await page.clock.install();await page.goto(href());await title(page,success());
  heldNode="self";heldStatus=503;await page.clock.fastForward(60001);
  while(!pending.size)await page.waitForTimeout(10);
  heldNode="";revision=2;await page.clock.fastForward(60001);await title(page,success());
  for(const release of pending)release();pending.clear();await page.waitForTimeout(150);expect(await page.title()).toBe(success());
  expect(await page.getByText(/Latest reading unavailable/).count()).toBe(0);
  status=503;await page.clock.fastForward(60001);await title(page,"Storage unavailable · Local · Cyberdeck");
  await page.getByRole("region",{name:"Storage capacity"}).waitFor();await page.getByText(/Showing last reading/).waitFor();
  const link=page.url();status=200;await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,success());expect(page.url()).toBe(link);
}), budget);

test("Storage late local denial cannot lock a different node while an active local denial owns Locked", () => fresh(async page => {
  heldNode="self";heldStatus=401;await page.goto(href());
  while(!pending.size)await page.waitForTimeout(10);
  await page.evaluate(url=>location.hash=new URL(url).hash,href("peer-a"));await title(page,success("Peer A"));
  heldNode="";for(const release of pending)release();pending.clear();await page.waitForTimeout(150);expect(await page.title()).toBe(success("Peer A"));
  status=401;await page.evaluate(url=>location.hash=new URL(url).hash,href());await title(page,"Locked · Cyberdeck");
}), budget);

test("Storage error and missing states fit phone and desktop with cleanup in both browser color schemes", () => fresh(async page => {
  for(const width of [390,1280])for(const colorScheme of ["light","dark"] as const){
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});status=503;
    await page.goto("about:blank");await page.goto(href("peer-a"));await title(page,"Storage unavailable · Peer A · Cyberdeck");
    expect(await page.locator("body").evaluate(el=>el.scrollWidth <= innerWidth)).toBe(true);
    if(process.env.CYBERDECK_NAV_SHOTS)await page.screenshot({path:join(process.env.CYBERDECK_NAV_SHOTS,`storage-${width}-${colorScheme}.png`)});
  }
  await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
}), budget);


test("Storage waits for paired-node discovery and fleet read failures retry without probing an unknown machine", () => fresh(async page => {
  holdFleet=true;const before=requests.filter(path=>path.endsWith("/disks")).length;
  await page.goto(href("peer-a"));await title(page,"Loading machine · Storage · Cyberdeck");
  expect(requests.filter(path=>path.endsWith("/disks")).length).toBe(before);
  holdFleet=false;for(const release of pending)release();pending.clear();await title(page,success("Peer A"));
  await page.goto("about:blank");fleetStatus=503;await page.goto(href("peer-a"));await title(page,"Machine list unavailable · Storage · Cyberdeck");
  // Let all initial shared discovery reads finish before recovering the fake
  // backend; Retry must not join an earlier request that already failed.
  await page.waitForLoadState("networkidle");
  const link=page.url(), retry=page.getByRole("button",{name:"Retry",exact:true});await retry.waitFor();fleetStatus=200;
  // Fleet polling may recover before the click reaches the renderer. Dispatch
  // against the current DOM so either recovery retains this exact selection.
  await retry.evaluateAll(buttons=>(buttons[0] as HTMLButtonElement | undefined)?.click());
  await title(page,success("Peer A"));expect(page.url()).toBe(link);
}), budget);


test("Storage legacy daemons restore dashboard disk readings without replacing links or bypassing denial", () => fresh(async page => {
  legacy=true;await page.goto(href("peer-a"));await title(page,success("Peer A"));
  expect(requests).toContain("/api/nodes/peer-a/proxy/dashboard");
  const link=page.url();await page.reload();await title(page,success("Peer A"));expect(page.url()).toBe(link);
  const count=requests.filter(path=>path.endsWith("/dashboard")).length;
  legacy=false;status=403;await page.goto("about:blank");await page.goto(href("peer-a"));await title(page,"Storage access denied · Peer A · Cyberdeck");
  expect(requests.filter(path=>path.endsWith("/dashboard")).length).toBe(count);
  legacy=true;status=200;heldNode="self";heldStatus=401;await page.evaluate(url=>location.hash=new URL(url).hash,href());
  while(!pending.size)await page.waitForTimeout(10);
  await page.evaluate(url=>location.hash=new URL(url).hash,href("peer-b"));await title(page,success("Peer B"));
  heldNode="";for(const release of pending)release();pending.clear();await page.waitForTimeout(150);expect(await page.title()).toBe(success("Peer B"));
}), budget);
