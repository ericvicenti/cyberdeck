// Casework example apps: the kitchen sink is served by the node as a scene around a native experience,
// a device or the web console navigates to it, calls are relayed between device and console, and the
// owner's own device keeps full access even when its WebView carries the scoped pairing key.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import { testConfig, TEST_TOKEN, tmpHomeDir } from "./helpers";
import { caseworkAllows, compileExperience, CASEWORK_APPS, NATIVE_MODULES } from "../src/daemon/api/casework";
import { Tailscale } from "../src/daemon/tailscale";

const KEY = "casework-apps-key-for-tests";
const OWNER = "eric@example.com";
process.env.CYBERDECK_SEED_KEY_SEED ??= "7f".repeat(32);
const seedHome = tmpHomeDir("casework-apps-seed");
const whois = (login: string) => JSON.stringify({ Node: { Name: "buoy.tail.ts.net." }, UserProfile: { LoginName: login } });
const tailscale = new Tailscale(async (args) => args[0] === "whois" ? (args[2] === "100.100.0.1" ? whois(OWNER) : args[2] === "100.100.0.2" ? whois("stranger@example.com") : null) : null);
let server: ReturnType<typeof Bun.serve>, bridge: ReturnType<typeof Bun.serve>;
let base = "", wsBase = "";
let sessions: { close: () => void };
const bridgeCalls: { path: string; auth: string | null; body: string }[] = [];

beforeAll(async () => {
  // A stand-in for the Casework Seed bridge behind the kitchen sink's Agent tab.
  bridge = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { const u = new URL(req.url); bridgeCalls.push({ path: u.pathname, auth: req.headers.get("authorization"), body: await req.text() }); return u.pathname === "/workspace" ? Response.json({ agent: { name: "Companion" } }) : u.pathname === "/voice/context" ? Response.json({ ok: true }) : Response.json({ error: "no such route" }, { status: 404 }); } });
  const tokenFile = join(seedHome.dir, "bridge-token");
  await Bun.write(tokenFile, "bridge-secret\n");
  const db = new Database(":memory:");
  initSchema(db);
  const cfg = testConfig({ seed: { agentsUrl: "http://127.0.0.1:1" }, tailscaleOwner: OWNER, applications: [{ id: "afterglow", name: "Afterglow", description: "Films", url: "http://127.0.0.1:13031/" }], casework: { url: `http://127.0.0.1:${bridge.port}`, tokenFile } });
  const s = createServer(db, cfg, TEST_TOKEN, "stw-test", { caseworkKey: KEY, persistOwner: false, cloudSync: false, tailscale, requestIp: (c) => c.req.raw.headers.get("x-test-ip") ?? "127.0.0.1", seed: { home: seedHome.dir, companionFile: join(seedHome.dir, "none.json") } });
  sessions = s.sessions;
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: s.fetch, websocket: s.websocket });
  base = `http://127.0.0.1:${server.port}`;
  wsBase = `ws://127.0.0.1:${server.port}`;
});
afterAll(() => { sessions.close(); void server.stop(true); void bridge.stop(true); seedHome.cleanup(); });

const withKey = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, ...init.headers } });
const withToken = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${TEST_TOKEN}`, ...init.headers } });
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type Peer = { ws: WebSocket; welcome: any; next: (type?: string) => Promise<any> };
/** Join /control as a device or a console; `next(type)` skips frames of other types. */
function join_(role: "device" | "console", name = "Test iPad"): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/control`);
    const queue: any[] = []; let waiter: (() => void) | null = null;
    const next = async (type?: string): Promise<any> => { for (;;) { const i = queue.findIndex((m) => !type || m.type === type); if (i >= 0) return queue.splice(i, 1)[0]; await new Promise<void>((r) => { waiter = r; }); } };
    ws.onmessage = (ev) => { queue.push(JSON.parse(String(ev.data))); waiter?.(); waiter = null; };
    ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", role, token: KEY, info: { name, model: "iPad" } })); void next("welcome").then((welcome) => resolve({ ws, welcome, next })); };
    ws.onerror = () => reject(new Error("socket error"));
  });
}

describe("kitchen sink experience", () => {
  test("is listed as an example app next to the configured web applications", async () => {
    const r = await (await withKey("/api/applications")).json();
    expect(r.applications.map((a: any) => a.id)).toEqual(["afterglow"]);
    expect(r.casework.apps.map((a: any) => a.id)).toEqual(["kitchen-sink"]);
    expect(r.casework.apps[0].name).toBe("Kitchen sink");
    expect(r.casework.kiosk).toBe(false);
    expect((await (await withKey("/api/state")).json()).presets).toEqual(["cyberdeck", "kitchen-sink"]);
  });
  test("compiles with every tab and only modules the shipped app has", async () => {
    const r = await compileExperience("kitchen-sink");
    for (const tab of ["Agent", "Overview", "Camera + QR", "Audio + calls", "Video", "Graphics", "Device", "Files + OS", "Web + forms"]) expect(r.source).toContain(tab);
    const required = [...r.source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(3);
    for (const name of required) expect(NATIVE_MODULES).toContain(name);
    // Its pieces are bundled in, not fetched: the GL game and the Seed workspace.
    expect(r.source).toContain("createDrift");
    expect(r.source).toContain("/api/seed/");
    const served = await withKey("/api/modules/kitchen-sink");
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("ProtectedExperience");
  });
  test("the home scene compiles with the Deck and Apps tabs", async () => {
    const r = await compileExperience("cyberdeck");
    expect(r.source).toContain("react-native-webview");
    expect(r.source).toContain("/api/applications");
    expect(r.source).toContain("onMessage");
  });
  test("sample media is served without a token and with byte ranges for the native player", async () => {
    const whole = await fetch(`${base}/samples/motion.mp4`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    const size = (await whole.arrayBuffer()).byteLength;
    expect(size).toBeGreaterThan(100_000);
    const part = await fetch(`${base}/samples/motion.mp4`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const tail = await fetch(`${base}/samples/motion.mp4`, { headers: { range: "bytes=-50" } });
    expect(tail.headers.get("content-range")).toBe(`bytes ${size - 50}-${size - 1}/${size}`);
    expect((await fetch(`${base}/samples/motion.mp4`, { headers: { range: `bytes=${size}-` } })).status).toBe(416);
    expect((await fetch(`${base}/samples/chime.wav`)).headers.get("content-type")).toBe("audio/wav");
    expect((await fetch(`${base}/samples/..%2Fcyberdeck.tsx`)).status).toBe(404);
    expect((await fetch(`${base}/samples/nope.mp4`)).status).toBe(404);
  });
  test("the demo QR is for the dashboard, not the pairing key", async () => {
    expect((await withKey("/api/casework/demo-qr")).status).toBe(403);
    const r = await (await withToken("/api/casework/demo-qr")).json();
    expect(r.text).toContain("CYBERDECK");
    expect(r.qr.startsWith("<svg")).toBe(true);
  });
});

describe("scenes", () => {
  test("a device opens the kitchen sink and comes back; the console sees where it is", async () => {
    const dev = await join_("device");
    expect(dev.welcome.scene.tree).toEqual({ type: "RemoteModule", props: { name: "cyberdeck" } });
    dev.ws.send(JSON.stringify({ type: "event", name: "scene", data: { name: "kitchen-sink" } }));
    const kitchen = await dev.next("scene");
    expect(kitchen.scene.title).toBe(CASEWORK_APPS[0].title);
    expect(kitchen.scene.tree).toEqual({ type: "RemoteModule", props: { name: "kitchen-sink" } });
    expect((await (await withKey("/api/state")).json()).devices[0].scene).toBe("kitchen-sink");
    // The original experience's alias, and the name its back button used to send.
    dev.ws.send(JSON.stringify({ type: "event", name: "scene", data: { name: "kitchen" } }));
    expect((await dev.next("scene")).scene.tree.props.name).toBe("kitchen-sink");
    dev.ws.send(JSON.stringify({ type: "event", name: "scene", data: { name: "casework" } }));
    expect((await dev.next("scene")).scene.tree.props.name).toBe("cyberdeck");
    dev.ws.send(JSON.stringify({ type: "event", name: "scene", data: { name: "nope" } }));
    dev.ws.send(JSON.stringify({ type: "ping", at: 1 }));
    expect((await dev.next()).type).toBe("pong");
    dev.ws.close();
    await Bun.sleep(30);
  });
  test("the web console sends an app to one device or to all, with full auth only", async () => {
    const a = await join_("device", "buoy"), b = await join_("device", "Simulator");
    expect((await withKey("/api/preset/kitchen-sink", json({}))).status).toBe(403);
    expect((await withToken("/api/preset/nope", json({}))).status).toBe(404);
    const one = await (await withToken("/api/preset/kitchen-sink", json({ deviceId: a.welcome.id }))).json();
    expect(one).toMatchObject({ scene: "kitchen-sink", sent: 1 });
    expect((await a.next("scene")).scene.tree.props.name).toBe("kitchen-sink");
    const all = await (await withToken("/api/preset/cyberdeck", json({}))).json();
    expect(all.sent).toBe(2);
    expect((await a.next("scene")).scene.tree.props.name).toBe("cyberdeck");
    expect((await b.next("scene")).scene.tree.props.name).toBe("cyberdeck");
    a.ws.close(); b.ws.close();
    await Bun.sleep(30);
    expect((await (await withToken("/api/preset/kitchen-sink", json({}))).json()).sent).toBe(0);
  });
});

describe("calls between a device and the web console", () => {
  test("a call request needs a console; signals are relayed only across roles", async () => {
    const dev = await join_("device");
    dev.ws.send(JSON.stringify({ type: "event", name: "call.request", data: { video: true } }));
    expect((await dev.next("error")).error).toContain("Kitchen sink");

    const con = await join_("console");
    expect(con.welcome.devices.map((d: any) => d.id)).toEqual([dev.welcome.id]);
    dev.ws.send(JSON.stringify({ type: "event", name: "call.request", data: { video: true } }));
    expect(await con.next("call.request")).toEqual({ type: "call.request", from: dev.welcome.id, video: true });
    // The device's events reach the console's activity feed.
    expect((await con.next("event")).event).toMatchObject({ deviceId: dev.welcome.id, name: "call.request" });

    con.ws.send(JSON.stringify({ type: "signal", to: dev.welcome.id, signal: { type: "offer", description: { type: "offer", sdp: "v=0" }, video: true } }));
    expect(await dev.next("signal")).toEqual({ type: "signal", from: con.welcome.id, signal: { type: "offer", description: { type: "offer", sdp: "v=0" }, video: true } });
    dev.ws.send(JSON.stringify({ type: "signal", to: con.welcome.id, signal: { type: "answer", description: { type: "answer", sdp: "v=0" } } }));
    expect((await con.next("signal")).signal.type).toBe("answer");

    const other = await join_("device", "other");
    dev.ws.send(JSON.stringify({ type: "signal", to: other.welcome.id, signal: { type: "hangup" } }));
    expect((await dev.next("error")).error).toBe("Call peer is unavailable");
    dev.ws.close(); other.ws.close();
    expect((await con.next("peer.left")).id).toBeDefined();
    con.ws.close();
    await Bun.sleep(30);
  });
});

describe("Seed bridge for the Agent tab", () => {
  test("is in the pairing key's scope and keeps the bridge credential on the node", async () => {
    expect(caseworkAllows("GET", "/api/seed/workspace")).toBe(true);
    expect(caseworkAllows("POST", "/api/seed/message")).toBe(true);
    expect(caseworkAllows("DELETE", "/api/seed/workspace")).toBe(false);
    const r = await withKey("/api/seed/workspace");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ agent: { name: "Companion" } });
    expect(bridgeCalls.at(-1)).toMatchObject({ path: "/workspace", auth: "Bearer bridge-secret" });
    const missing = await withKey("/api/seed/nope");
    expect(missing.status).toBe(502);
    expect((await missing.json()).error).toBe("no such route");
    expect((await withKey("/api/seed/..%2F..%2Fsecret")).status).toBe(400);
  });
  test("the app's screen context goes to the voice room", async () => {
    expect((await withKey("/api/seed/screen-context", json({ room: "seed-voice-1234567890", scene: "" }))).status).toBe(400);
    const r = await withKey("/api/seed/screen-context", json({ room: "seed-voice-1234567890", scene: "The possibility lab.", section: "Video" }));
    expect(r.status).toBe(200);
    const sent = bridgeCalls.at(-1)!;
    expect(sent.path).toBe("/voice/context");
    expect(JSON.parse(JSON.parse(sent.body).context)).toMatchObject({ scene: "The possibility lab.", section: "Video" });
  });
});

describe("the owner's device", () => {
  const from = (ip: string, path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { "x-test-ip": ip, ...headers } });
  test("keeps full access when its page also carries the pairing key", async () => {
    // Safari on the owner's tailnet device: full access with no token.
    expect((await (await from("100.100.0.1", "/api/auth/whoami")).json()).method).toBe("tailscale");
    // The Casework WebView stores the pairing key as the page token; that must not narrow the owner.
    expect((await (await from("100.100.0.1", "/api/auth/whoami", { authorization: `Bearer ${KEY}` })).json()).method).toBe("tailscale");
    expect((await from("100.100.0.1", "/api/casework/devices", { authorization: `Bearer ${KEY}` })).status).toBe(200);
  });
  test("anyone else holding the key stays inside the app's scope", async () => {
    expect((await (await from("100.100.0.2", "/api/auth/whoami", { authorization: `Bearer ${KEY}` })).json()).method).toBe("casework");
    expect((await from("100.100.0.2", "/api/casework/devices", { authorization: `Bearer ${KEY}` })).status).toBe(403);
    expect((await from("100.100.0.2", "/api/casework/devices")).status).toBe(401);
    expect((await from("100.100.0.2", "/api/state", { authorization: `Bearer ${KEY}` })).status).toBe(200);
  });
});
