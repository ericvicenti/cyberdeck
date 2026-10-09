// Casework Desk workflow-server protocol: the iPad app pairs with a key, fetches the scene and
// compiled experiences over HTTP, and talks over the /control WebSocket (hello -> welcome).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import { testConfig, TEST_TOKEN, tmpHomeDir } from "./helpers";
import { qrMatrix, qrSvg } from "../src/daemon/casework/qr";
import { caseworkAllows } from "../src/daemon/api/casework";
import { Tailscale } from "../src/daemon/tailscale";

const KEY = "casework-pairing-key-for-tests";
const FIXTURES = join(import.meta.dir, "fixtures", "casework");
// Voice is off here: a deterministic signer (never the Seed vault) and an agents URL nothing listens on.
process.env.CYBERDECK_SEED_KEY_SEED ??= "7f".repeat(32);
const seedHome = tmpHomeDir("casework-seed");
let server: ReturnType<typeof Bun.serve>;
let base = "", wsBase = "";
let sessions: { close: () => void };

beforeAll(() => {
  const db = new Database(":memory:");
  initSchema(db);
  const s = createServer(db, testConfig({ seed: { agentsUrl: "http://127.0.0.1:1" } }), TEST_TOKEN, "stw-test", { caseworkKey: KEY, caseworkExperiencesDir: FIXTURES, persistOwner: false, cloudSync: false, tailscale: new Tailscale(async () => null), seed: { home: seedHome.dir, companionFile: join(seedHome.dir, "none.json") } });
  sessions = s.sessions;
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: s.fetch, websocket: s.websocket });
  base = `http://127.0.0.1:${server.port}`;
  wsBase = `ws://127.0.0.1:${server.port}`;
});
afterAll(() => { sessions.close(); void server.stop(true); seedHome.cleanup(); });

const withKey = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, ...init.headers } });
const withToken = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${TEST_TOKEN}`, ...init.headers } });

/** Open /control, send hello, resolve with the first frame and a message queue. */
function connectDevice(token: string): Promise<{ ws: WebSocket; first: any; next: () => Promise<any>; closed: Promise<CloseEvent> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/control`);
    const queue: any[] = []; const waiters: ((m: any) => void)[] = [];
    const closed = new Promise<CloseEvent>((r) => { ws.onclose = (e) => r(e); });
    let first: any = null;
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (!first) { first = m; resolve({ ws, first, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)), closed }); } else { const w = waiters.shift(); if (w) w(m); else queue.push(m); } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "device", token, info: { name: "Test iPad", model: "iPad", os: "iOS", capabilities: [] } }));
    ws.onerror = () => reject(new Error("socket error"));
    closed.then((e) => { if (!first) resolve({ ws, first: { type: "closed", code: e.code }, next: () => Promise.reject(new Error("closed")), closed }); });
  });
}

describe("qr", () => {
  test("version 1 for short text, square matrix with finder patterns", () => {
    const m = qrMatrix("hello");
    expect(m.length).toBe(21);
    expect(m.every((row) => row.length === 21)).toBe(true);
    // Top-left finder: 7x7 ring with a dark centre and dark border.
    expect(m[0].slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    expect(m[1].slice(0, 7)).toEqual([true, false, false, false, false, false, true]);
    expect(m[3].slice(0, 7)).toEqual([true, false, true, true, true, false, true]);
    // Dark module next to the bottom-left finder is always set.
    expect(m[21 - 8][8]).toBe(true);
  });
  test("grows to a larger version for a pairing link and renders SVG", () => {
    const link = `remotecontrol://?url=${encodeURIComponent("https://yacht.tail0bb35a.ts.net")}&token=${"a".repeat(48)}`;
    expect(qrMatrix(link).length).toBeGreaterThan(21);
    const svg = qrSvg(link);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<path");
  });
});

describe("casework key scope", () => {
  test("allows app routes and nothing else", () => {
    expect(caseworkAllows("GET", "/api/state")).toBe(true);
    expect(caseworkAllows("GET", "/api/modules/cyberdeck")).toBe(true);
    expect(caseworkAllows("POST", "/api/command")).toBe(true);
    expect(caseworkAllows("GET", "/api/control/overview")).toBe(true);
    expect(caseworkAllows("POST", "/api/control/collab/tick")).toBe(true);
    expect(caseworkAllows("POST", "/api/control/collab/add")).toBe(false);
    expect(caseworkAllows("GET", "/api/fs/list")).toBe(false);
    expect(caseworkAllows("GET", "/api/casework/pairing")).toBe(false);
    expect(caseworkAllows("POST", "/api/casework/rotate")).toBe(false);
    expect(caseworkAllows("POST", "/api/system/update")).toBe(false);
    expect(caseworkAllows("GET", "/api/voice/config")).toBe(true);
    expect(caseworkAllows("POST", "/api/voice/livekit")).toBe(true);
    expect(caseworkAllows("POST", "/api/voice/setup")).toBe(false);
  });
});

describe("casework server", () => {
  test("health needs no auth", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
  test("state is 401 without a key, 200 with the pairing key, and advertises the cyberdeck scene", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const r = await withKey("/api/state");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.scene.title).toBe("Cyberdeck");
    expect(j.scene.tree).toEqual({ type: "RemoteModule", props: { name: "cyberdeck" } });
    expect(typeof j.revision).toBe("number");
    expect(j.devices).toEqual([]);
    expect(j.voice.configured).toBe(false);
    expect(j.voice.provider).toBe("none");
    expect(j.voice.reason).toContain("unreachable");
  });
  test("the pairing key cannot reach routes outside the app's scope", async () => {
    expect((await withKey("/api/fs/list?path=/")).status).toBe(403);
    expect((await withKey("/api/casework/pairing")).status).toBe(403);
    expect((await withKey("/api/casework/rotate", { method: "POST" })).status).toBe(403);
  });
  test("main token also works as a pairing key and sees the pairing card data", async () => {
    expect((await withToken("/api/state")).status).toBe(200);
    const r = await withToken(`/api/casework/pairing?url=${encodeURIComponent("https://yacht.example.ts.net")}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.url).toBe("https://yacht.example.ts.net");
    expect(j.key).toBe(KEY);
    expect(j.link).toBe(`remotecontrol://?url=${encodeURIComponent("https://yacht.example.ts.net")}&token=${encodeURIComponent(KEY)}`);
    expect(j.qr.startsWith("<svg")).toBe(true);
    // Beside it, the web Desk link for a phone browser: https here, so the microphone works.
    expect(j.desk).toMatchObject({ url: "https://yacht.example.ts.net/#/desk", secure: true });
    expect(j.desk.qr.startsWith("<svg")).toBe(true);
  });
  test("a plain-http Desk link (no tailnet serve) is flagged insecure", async () => {
    const j = await (await withToken(`/api/casework/pairing?url=${encodeURIComponent("http://192.168.1.20:4777")}`)).json();
    expect(j.desk).toMatchObject({ url: "http://192.168.1.20:4777/#/desk", secure: false });
  });
  test("experiences compile to CommonJS with only native requires and an error boundary", async () => {
    const r = await withKey("/api/modules/hello?v=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/javascript");
    const src = await r.text();
    expect(src).toMatch(/require\(["']react["']\)/); // the boundary wrapper; the fixture itself only needs the JSX runtime
    expect(src).toContain('require("react-native")');
    expect(src).toContain('require("@remote/runtime")');
    expect(src).not.toContain("jsx-dev-runtime");
    expect(src).toContain("module.exports");
    expect(src).toContain("ExperienceBoundary");
    expect((await withKey("/api/modules/nope")).status).toBe(404);
    expect((await withKey("/api/modules/..%2Fx")).status).toBe(400);
    const status = await (await withKey("/api/experience-status")).json();
    expect(status.modules.map((m: any) => m.name)).toContain("hello");
    expect(status.nativeModules).toContain("@remote/runtime");
  });
  test("device WebSocket: bad key closes 4001, good key gets welcome, commands are delivered", async () => {
    const bad = await connectDevice("wrong");
    expect(bad.first.type).toBe("closed");
    expect(bad.first.code).toBe(4001);

    const dev = await connectDevice(KEY);
    expect(dev.first.type).toBe("welcome");
    expect(dev.first.scene.tree.props.name).toBe("cyberdeck");
    expect(dev.first.voice).toMatchObject({ configured: false, provider: "none" });
    expect(typeof dev.first.id).toBe("string");

    const state = await (await withKey("/api/state")).json();
    expect(state.devices.length).toBe(1);
    expect(state.devices[0].info.name).toBe("Test iPad");

    dev.ws.send(JSON.stringify({ type: "ping", at: 123 }));
    const pong = await dev.next();
    expect(pong).toEqual({ type: "pong", at: 123 });

    const cmd = await withToken("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: { name: "speech.say", args: { text: "hi" } } }) });
    expect(cmd.status).toBe(202);
    const delivered = await dev.next();
    expect(delivered.type).toBe("command");
    expect(delivered.action).toEqual({ name: "speech.say", args: { text: "hi" } });
    dev.ws.send(JSON.stringify({ type: "result", id: delivered.id, ok: true, result: null }));

    dev.ws.close();
    await dev.closed;
    await Bun.sleep(20);
    expect((await withToken("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: { name: "device.info" } }) })).status).toBe(409);
  });
  test("run executes a bounded command in a directory", async () => {
    const r = await withKey("/api/casework/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "~", cmd: "echo casework-ok" }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.code).toBe(0);
    expect(j.output).toContain("casework-ok");
    expect((await withKey("/api/casework/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/definitely/not/here", cmd: "true" }) })).status).toBe(400);
  });
});
