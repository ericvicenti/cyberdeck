import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";

// Production bundle, synthetic console/device signalling and microphone tracks.
// Never connects to the fleet or a physical device.
let browser: Browser, page: Page;
const sockets = new Set<any>();
const signals: any[] = [], mutations: string[] = [];
let connections = 0;
const devices = [{ id: "device-a", info: { name: "Device A" } }, { id: "device-b", info: { name: "Device B" } }];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req, server) {
  const path = new URL(req.url).pathname.replace(/^\/api\/nodes\/[^/]+\/proxy\//, "/api/");
  if (path === "/control" && server.upgrade(req)) return;
  if (path.startsWith("/api/")) {
    if (req.method !== "GET") { mutations.push(path); return new Response("Forbidden", { status: 405 }); }
    if (path === "/api/auth/whoami") return Response.json({ method: "none" });
    if (path === "/api/applications") return Response.json({ applications: [], casework: {
      apps: [{ id: "kitchen-sink", name: "Kitchen sink", description: "Fixture console" }], devices, kiosk: false,
    } });
    if (path === "/api/fleet/nodes") return Response.json({ self: { nodeId: "test", name: "Test" }, nodes: [] });
    if (path === "/api/casework/pairing") return Response.json({ url: "http://fixture.invalid", key: "fixture-key", qr: "<svg/>" });
    if (path === "/api/casework/demo-qr") return Response.json({ text: "fixture", qr: "<svg/>" });
    if (path === "/api/fs/list") return Response.json({ path: "/", home: "/", parent: null, entries: [], users: {}, groups: {} });
    return Response.json({ error: "Fixture endpoint unavailable" }, { status: 404 });
  }
  const file = Bun.file(join(import.meta.dir, "../dist/ui", path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
}, websocket: {
  open(ws) { sockets.add(ws); connections++; },
  message(ws, raw) {
    const message = JSON.parse(String(raw));
    if (message.type === "hello") ws.send(JSON.stringify({ type: "welcome", devices }));
    else signals.push(message);
  },
  close(ws) { sockets.delete(ws); },
} });
let visit = 0;
const url = (device = "device-a") => `${server.url}?visit=${++visit}#/applications?app=kitchen-sink&device=${device}`;
const title = (value: string) => page.waitForFunction(value => document.title === value, value);
beforeAll(async () => { browser = await chromium.launch(); });
beforeEach(async () => {
  await page?.close(); signals.length = 0; mutations.length = 0; connections = 0;
  page = await browser.newPage(); page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    const state = { created: 0, closed: 0, stopped: 0, mediaRequests: 0, hold: false, release: undefined as undefined | (() => void) };
    (window as any).callFixture = state;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      state.mediaRequests++;
      if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
      const stream = new MediaStream();
      stream.getTracks = () => [{ stop: () => { state.stopped++; } } as MediaStreamTrack];
      return stream;
    } });
    (window as any).RTCPeerConnection = class {
      localDescription: any; connectionState = "new";
      constructor() { state.created++; }
      addTrack() {}
      async createOffer() { return { type: "offer", sdp: "synthetic" }; }
      async setLocalDescription(value: any) { this.localDescription = value; }
      close() { state.closed++; }
    };
  });
});
afterAll(async () => { await browser?.close(); server.stop(true); });

test("Casework device links restore with history and retain calls across apps, views and node URLs", async () => {
  await page.goto(url()); await title("Device A · Kitchen sink · Cyberdeck");
  await page.getByRole("button", { name: "Audio call", exact: true }).click();
  await page.getByText("connecting to the device…", { exact: true }).waitFor();
  expect(signals.filter(x => x.signal?.type === "offer").map(x => x.to)).toEqual(["device-a"]);
  const before = await page.evaluate(() => history.length);
  await page.getByLabel("Device", { exact: true }).selectOption("device-b");
  await title("Device B · Kitchen sink · Cyberdeck");
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack(); await title("Device A · Kitchen sink · Cyberdeck");
  await page.goForward(); await title("Device B · Kitchen sink · Cyberdeck");
  await page.getByTestId("nav-applications").click(); await title("Applications · Cyberdeck");
  for (const ws of sockets) ws.send(JSON.stringify({ type: "devices", devices: [devices[0]] }));
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => location.hash)).toBe("#/applications");
  await page.evaluate(() => { location.hash = "#/files?node=another-node"; });
  await page.getByTestId("files-table").waitFor();
  await page.evaluate(() => { location.hash = "#/remote"; }); await title("Screen remote · Cyberdeck");
  expect(await page.evaluate(() => ({ created: (window as any).callFixture.created, closed: (window as any).callFixture.closed, stopped: (window as any).callFixture.stopped }))).toEqual({ created: 1, closed: 0, stopped: 0 });
  for (const ws of sockets) ws.send(JSON.stringify({ type: "devices", devices }));
  await page.evaluate(() => { location.hash = "#/applications?app=kitchen-sink&device=device-a"; });
  await title("Device A · Kitchen sink · Cyberdeck");
  expect(connections).toBe(1);
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.getByText("call ended", { exact: true }).waitFor();
  expect(signals.filter(x => x.signal?.type === "hangup").map(x => x.to)).toEqual(["device-a"]);
  const fresh = await browser.newPage(); await fresh.goto(url("device-b"));
  await fresh.waitForFunction(() => document.title === "Device B · Kitchen sink · Cyberdeck");
  await fresh.reload(); await fresh.waitForFunction(() => document.title === "Device B · Kitchen sink · Cyberdeck");
  await fresh.close();
  expect(mutations).toEqual([]);
});

test("hidden Casework defaults cannot write another route, and missing devices keep honest titles", async () => {
  await page.goto(`${server.url}#/applications?app=kitchen-sink`);
  await title("Device A · Kitchen sink · Cyberdeck");
  await page.getByTestId("nav-files").click(); await page.getByTestId("files-table").waitFor();
  const hash = await page.evaluate(() => location.hash);
  for (const ws of sockets) ws.send(JSON.stringify({ type: "devices", devices: [devices[1]] }));
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  expect(await page.title()).toBe("Files · Cyberdeck");
  await page.goBack(); await title("Device not found · Kitchen sink · Cyberdeck");
  await page.getByRole("alert").filter({ hasText: "Device not found: device-a" }).waitFor();
  expect(signals).toEqual([]);
});

test("authentication cleanup ends a Casework call and releases a late microphone grant", async () => {
  await page.goto(url()); await title("Device A · Kitchen sink · Cyberdeck");
  await page.getByRole("button", { name: "Audio call", exact: true }).click();
  await page.getByText("connecting to the device…", { exact: true }).waitFor();
  await page.route("**/api/fs/list**", route => route.fulfill({ status: 401, json: { error: "Locked" } }));
  await page.getByTestId("nav-files").click(); await title("Locked · Cyberdeck");
  expect(await page.getByTestId("casework-console").count()).toBe(0);
  expect(await page.evaluate(() => [(window as any).callFixture.closed, (window as any).callFixture.stopped])).toEqual([1, 1]);
  await page.unroute("**/api/fs/list**");
  await page.goto(url()); await title("Device A · Kitchen sink · Cyberdeck");
  await page.evaluate(() => { (window as any).callFixture.hold = true; });
  await page.getByRole("button", { name: "Audio call", exact: true }).click();
  await page.waitForFunction(() => !!(window as any).callFixture.release);
  await page.route("**/api/fs/list**", route => route.fulfill({ status: 401, json: { error: "Locked" } }));
  await page.getByTestId("nav-files").click(); await title("Locked · Cyberdeck");
  await page.evaluate(() => (window as any).callFixture.release());
  await page.waitForFunction(() => (window as any).callFixture.stopped === 1);
  expect(await page.evaluate(() => (window as any).callFixture.created)).toBe(0);
});

test("cancelling a pending Casework call releases the eventual grant without starting a connection", async () => {
  await page.goto(url()); await title("Device A · Kitchen sink · Cyberdeck");
  await page.evaluate(() => { (window as any).callFixture.hold = true; });
  await page.getByRole("button", { name: "Audio call", exact: true }).click();
  await page.waitForFunction(() => !!(window as any).callFixture.release);
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.getByText("call ended", { exact: true }).waitFor();
  await page.evaluate(() => (window as any).callFixture.release());
  await page.waitForFunction(() => (window as any).callFixture.stopped === 1);
  expect(await page.evaluate(() => (window as any).callFixture.created)).toBe(0);
  expect(await page.getByRole("button", { name: "Audio call", exact: true }).isEnabled()).toBe(true);
  expect(signals).toEqual([]);
});


const mediaUrl = (name: string, device = "device-a") => url(device) + "&media=" + encodeURIComponent(name);
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFekAAAAASUVORK5CYII=", "base64");

test("Casework received-media links restore in new tabs, reload and history without replaying device actions", async () => {
  await page.route("**/api/media/**", route => route.fulfill({contentType:"image/png",body:pixel}));
  await page.goto(mediaUrl("fixture-photo.png"));
  await title("fixture-photo.png · Device A · Kitchen sink · Cyberdeck");
  await page.getByRole("img",{name:"fixture-photo.png",exact:true}).waitFor();
  await page.reload();await title("fixture-photo.png · Device A · Kitchen sink · Cyberdeck");
  const fresh = await browser.newPage();
  await fresh.route("**/api/media/**",route => route.fulfill({contentType:"image/png",body:pixel}));
  await fresh.goto(page.url());await fresh.getByRole("img",{name:"fixture-photo.png",exact:true}).waitFor();await fresh.close();
  await page.getByRole("button",{name:"Close preview",exact:true}).click();await title("Device A · Kitchen sink · Cyberdeck");
  expect(new URL(page.url()).hash).not.toContain("media=");
  await page.goBack();await title("fixture-photo.png · Device A · Kitchen sink · Cyberdeck");
  await page.goForward();await title("Device A · Kitchen sink · Cyberdeck");
  expect(signals).toEqual([]);expect(mutations).toEqual([]);
});

test("Casework media errors and unsafe URLs are honest and never fetch arbitrary paths", async () => {
  const fetched: string[] = [];
  await page.route("**/api/media/**",route=>{fetched.push(route.request().url());return route.fulfill({status:404,json:{error:"not found"}});});
  await page.goto(mediaUrl("missing.png"));await title("missing.png unavailable · Device A · Kitchen sink · Cyberdeck");
  await page.getByRole("alert").filter({hasText:"Media not found"}).waitFor();
  await page.evaluate(()=>location.hash="#/applications?app=kitchen-sink&device=device-a&media=https%3A%2F%2Fevil.invalid%2Fsecret");
  await title("Invalid media link · Device A · Kitchen sink · Cyberdeck");
  expect(fetched).toHaveLength(1);
  await page.getByTestId("nav-files").click();await title("Files · Cyberdeck");
  await page.goBack();await title("Invalid media link · Device A · Kitchen sink · Cyberdeck");
});

test("Casework incoming media pushes one canonical link and hidden receipts cannot navigate", async () => {
  await page.route("**/api/media/**",route=>route.fulfill({contentType:"image/png",body:pixel}));
  await page.goto(url());await title("Device A · Kitchen sink · Cyberdeck");
  const before=await page.evaluate(()=>history.length);
  const receipt={type:"event",event:{deviceId:"device-a",name:"files.upload",at:1,data:{path:"/api/media/received.png"}}};
  for(const ws of sockets){ws.send(JSON.stringify(receipt));ws.send(JSON.stringify(receipt));}
  await title("received.png · Device A · Kitchen sink · Cyberdeck");
  expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.getByTestId("nav-files").click();await title("Files · Cyberdeck");
  for(const ws of sockets)ws.send(JSON.stringify({...receipt,event:{...receipt.event,data:{path:"/api/media/later.png"}}}));
  await page.waitForTimeout(60);expect(new URL(page.url()).hash).toBe("#/files");
  await page.goBack();await title("received.png · Device A · Kitchen sink · Cyberdeck");
  await page.getByRole("button",{name:"View later.png",exact:true}).click();await title("later.png · Device A · Kitchen sink · Cyberdeck");
  expect(signals).toEqual([]);expect(mutations).toEqual([]);
});

test("Casework late media and access failures cannot replace another selected preview or title", async () => {
  let release:(()=>void)|undefined;
  await page.route("**/api/media/**",async route=>{
    if(route.request().url().endsWith("slow.png"))await new Promise<void>(r=>release=r);
    return route.request().url().endsWith("private.png") ? route.fulfill({status:403,json:{error:"Forbidden"}}) : route.fulfill({contentType:"image/png",body:pixel});
  });
  try {
    await page.goto(mediaUrl("slow.png"));await page.waitForFunction(()=>!!document.querySelector('[data-casework-media="slow.png"]'));
    while(!release)await page.waitForTimeout(5);
    await page.evaluate(()=>location.hash="#/applications?app=kitchen-sink&device=device-b&media=private.png");
    await title("private.png unavailable · Device B · Kitchen sink · Cyberdeck");release();
    await page.getByRole("alert").filter({hasText:"Media access denied"}).waitFor();
    await page.waitForTimeout(60);expect(await page.title()).toBe("private.png unavailable · Device B · Kitchen sink · Cyberdeck");
    await page.goBack();await title("slow.png · Device A · Kitchen sink · Cyberdeck");
    await page.getByRole("img",{name:"slow.png",exact:true}).waitFor();
  } finally {release?.();}
});


test("Casework received audio keeps its player across views and releases it on lock", async () => {
  const bytes = new Uint8Array(44+32000), data=new DataView(bytes.buffer);
  for(const [offset,text] of [[0,"RIFF"],[8,"WAVE"],[12,"fmt "],[36,"data"]] as const)for(let i=0;i<text.length;i++)bytes[offset+i]=text.charCodeAt(i);
  data.setUint32(4,bytes.length-8,true);data.setUint32(16,16,true);data.setUint16(20,1,true);data.setUint16(22,1,true);data.setUint32(24,8000,true);data.setUint32(28,16000,true);data.setUint16(32,2,true);data.setUint16(34,16,true);data.setUint32(40,bytes.length-44,true);
  await page.route("**/api/media/**",route=>route.fulfill({contentType:"audio/wav",body:Buffer.from(bytes)}));
  await page.goto(mediaUrl("fixture-audio.wav"));await title("fixture-audio.wav · Device A · Kitchen sink · Cyberdeck");
  const audio=page.locator('[data-casework-media="fixture-audio.wav"] audio');await audio.waitFor();
  expect(await audio.evaluate((audio:HTMLAudioElement)=>audio.paused)).toBe(true);
  const source=await audio.getAttribute("src");
  await audio.evaluate(async(audio:HTMLAudioElement)=>{audio.loop=true;await audio.play();});
  await page.getByTestId("nav-files").click();await title("Files · Cyberdeck");
  expect(await audio.evaluate((audio:HTMLAudioElement)=>audio.paused)).toBe(false);
  await page.goBack();await title("fixture-audio.wav · Device A · Kitchen sink · Cyberdeck");
  expect(await audio.getAttribute("src")).toBe(source);
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
  await page.getByTestId("nav-files").click();await title("Locked · Cyberdeck");
  expect(await page.locator("[data-casework-media]").count()).toBe(0);
  expect(await page.evaluate(url=>fetch(url!).then(()=>false,()=>true),source)).toBe(true);
});
