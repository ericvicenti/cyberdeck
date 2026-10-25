import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import { playerTestRom } from "./fixtures/vimm/player-rom";

// Real pinned NES core, original generated homebrew, isolated browser storage.
// Every request stays on this fixture; no catalog downloads or native games.
const game = { id: "42", title: "Navigation homebrew", system: "NES", regions: ["World"] };
const otherGame = { ...game, id: "43", title: "Another fixture" };
const requests: string[] = [], errors: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/api/")) {
    requests.push(req.method + " " + path);
    if (req.method !== "GET") return new Response("No mutations", { status: 405 });
    if (path === "/api/auth/whoami") return Response.json({ method: "none" });
    if (path === "/api/fleet/nodes") return Response.json({ self: { nodeId: "test", name: "Test" }, nodes: [] });
    if (path === "/api/applications") return Response.json({ applications: [] });
    if (path === "/api/vimm/home") return Response.json({ shelves: [{ title: "Fixture games", system: "NES", games: [game, otherGame] }] });
    if (path === "/api/vimm/catalog") return Response.json({ games: [game, otherGame], page: 1, pages: 1 });
    if (path === "/api/vimm/roms") return Response.json({ games: [] });
    if (path.endsWith("/fs/list")) return Response.json({ path: "/", parent: null, home: "/", entries: [], users: {}, groups: {} });
    return Response.json({ error: "Fixture endpoint unavailable" }, { status: 404 });
  }
  const file = Bun.file(join(import.meta.dir, "../dist/ui", path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
let browser: Browser, page: Page;
const detail = "#/applications?app=vimm&game=42&system=NES";
const title = (value: string) => page.waitForFunction(value => document.title === value, value);
beforeAll(async () => { browser = await chromium.launch(); });
beforeEach(async () => {
  await page?.close(); requests.length=0;errors.length=0;
  page = await browser.newPage({viewport:{width:1200,height:900}});page.setDefaultTimeout(15000);
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(server.url.toString()) || /^(blob:|data:)/.test(route.request().url()) ? route.continue() : route.abort());
  await page.goto(`${server.url}#/applications`);
  await page.evaluate(async ({game, bytes}) => {
    const db = await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open("cyberdeck-vault-player-v1",1);
      request.onupgradeneeded=()=>{request.result.createObjectStore("roms",{keyPath:"id"});request.result.createObjectStore("states",{keyPath:"id"});};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction("roms","readwrite");
      tx.objectStore("roms").put({id:game.id,game,name:"navigation.nes",digest:"navigation-fixture",file:new Blob([new Uint8Array(bytes)]),addedAt:1});
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
    }); db.close();
  },{game,bytes:[...playerTestRom()]});
});
afterAll(async()=>{await browser?.close();server.stop(true);});
async function start() {
  await page.evaluate(hash=>location.hash=hash,detail);
  await page.getByRole("button",{name:"Play",exact:true}).click();
  await page.locator('.vault-player-dialog[data-started="true"]').waitFor();
  await title("Navigation homebrew · The Vault · Cyberdeck");
}

test("Vault direct game links reload and open fresh without replaying Play",async()=>{
  await page.evaluate(hash=>location.hash=hash,detail);
  await page.getByRole("button",{name:"Play",exact:true}).waitFor();await title("Navigation homebrew · The Vault · Cyberdeck");
  await page.reload();await page.getByRole("button",{name:"Play",exact:true}).waitFor();
  const fresh=await browser.newPage();await fresh.goto(page.url());await fresh.getByRole("button",{name:"Play",exact:true}).waitFor();
  expect(await fresh.locator(".vault-player-frame").count()).toBe(0);await fresh.close();
  expect(await page.locator(".vault-player-frame").count()).toBe(0);
  expect(requests.some(r=>r.includes("download")||!r.startsWith("GET "))).toBe(false);
});

test("Vault keeps the real emulator through apps, primary views, node URLs and browser history",async()=>{
  await start();
  const frame = page.frames().find(frame=>frame.url().endsWith("/vault-player.html"))!;
  await frame.locator("canvas").waitFor();
  await frame.evaluate(()=>{(window as any).navigationProof=crypto.randomUUID();});
  const proof = await frame.evaluate(()=>(window as any).navigationProof);
  expect(new URL(page.url()).hash).toContain("game=42");
  const rendered=await frame.locator("canvas").screenshot();
  expect(rendered.length).toBeGreaterThan(500);
  await page.evaluate(()=>location.hash="#/files?node=fixture-peer");await page.getByTestId("files-table").waitFor();
  expect(await page.locator(".vault-player-dialog").getAttribute("open")).toBe(null);
  expect(await page.locator(".vault-player-frame").count()).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.hasAttribute("data-vault-playing"))).toBe(false);
  // Hidden game messages cannot open a modal, steal focus or retitle Files.
  await frame.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  await page.keyboard.press("Escape");await page.waitForTimeout(50);
  expect(await page.locator(".vault-player-dialog").getAttribute("open")).toBe(null);
  await page.evaluate(()=>location.hash="#/applications");await title("Applications · Cyberdeck");
  await page.evaluate(()=>location.hash="#/remote");await title("Screen remote · Cyberdeck");
  await page.goBack();await page.goBack();await page.goBack();
  await page.locator('.vault-player-dialog[open][data-started="true"]').waitFor();
  expect(await frame.evaluate(()=>(window as any).navigationProof)).toBe(proof);
  expect(await page.locator(".vault-player-frame").count()).toBe(1);
  // Saving proves the retained core remains responsive, with its original state.
  await page.keyboard.press("Escape");await page.getByRole("button",{name:"Save progress",exact:true}).click();
  await page.getByText("Progress saved in this browser",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Save & exit",exact:true}).click();
  await page.locator(".vault-player-dialog").waitFor({state:"detached"});
  await page.getByRole("button",{name:"Play",exact:true}).waitFor();
  expect(requests.some(r=>r.includes("download")||!r.startsWith("GET "))).toBe(false);expect(errors).toEqual([]);
},30000);

test("Vault resumes from its shelf without starting twice and releases its player at authentication",async()=>{
  await start();
  await page.evaluate(()=>location.hash="#/applications?app=vimm");
  await page.getByRole("button",{name:"Resume Navigation homebrew",exact:true}).click();
  await page.locator('.vault-player-dialog[open][data-started="true"]').waitFor();
  expect(await page.locator(".vault-player-frame").count()).toBe(1);
  await page.evaluate(()=>location.hash="#/applications?app=vimm&game=43");
  await page.getByRole("heading",{name:"Another fixture",exact:true}).waitFor();
  expect(await page.getByRole("button",{name:"Play",exact:true}).isEnabled()).toBe(false);
  await page.getByRole("button",{name:"Resume and exit it before starting another game",exact:true}).click();
  await page.locator('.vault-player-dialog[open][data-started="true"]').waitFor();
  expect(await page.locator(".vault-player-frame").count()).toBe(1);
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
  await page.evaluate(()=>location.hash="#/files");await title("Locked · Cyberdeck");
  expect(await page.locator(".vault-player-frame").count()).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.hasAttribute("data-vault-playing"))).toBe(false);
},30000);
