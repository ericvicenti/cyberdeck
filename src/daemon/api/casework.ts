// Casework Desk workflow server: makes the Casework Desk iPad/iPhone app (Eric's
// server-driven Expo client, repo ~/Code/remote-control) a native client of this node.
//
// Wire protocol (fixed by the shipped app, TestFlight 1.0.0 (2)):
//   GET  /health                      liveness (no auth)
//   GET  /api/state                   scene + revision + devices + events + voice (Bearer pairing key)
//   GET  /api/voice/config, POST /api/voice/livekit   AI call flow (api/voice.ts, docs/VOICE.md)
//   GET  /api/modules/:name?v=rev     compiled CommonJS experience (TSX bundled here with Bun.build)
//   POST /api/experiences/validate    recompile; GET /api/experience-status; POST /api/experiences/error
//   POST /api/command                 {deviceId?, action:{name,args}} -> delivered over the socket
//   PUT  /api/media/:name             uploads from the device; GET /api/media/:name
//   WS   /control                     first frame {type:"hello", role:"device"|"console", token, info}
//                                     -> {type:"welcome", id, scene, revision, voice, devices}; then
//                                     ping/pong, scene, command/result, event, modules.changed, peer.left,
//                                     signal (WebRTC call relay between a device and a console), call.request
// On top of the home scene the node serves example apps (CASEWORK_APPS): the Casework kitchen sink is
// `casework/kitchen-sink.tsx`, its web half is the Applications view (ui/views/CaseworkConsole.tsx).
// The app authenticates with a pairing key. We accept a dedicated key stored at
// ~/.cyberdeck/casework-key (so the phone never holds the main token) or the
// main bearer token; the key is scoped to the routes the app needs (see caseworkAllows).
import type { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { CYBERDECK_HOME } from "../config";
import { qrSvg } from "../casework/qr";

export type Scene = { title: string; subtitle?: string; accent?: string; tree: unknown };
type Peer = { id: string; role: "device" | "console"; info?: unknown; scene: string; send: (msg: unknown) => void; close: () => void };
type Compiled = { source: string; hash: string; updatedAt: number };

// Modules the app's native registry can resolve (src/runtime/modules.ts in remote-control).
export const NATIVE_MODULES = [
  "react", "react/jsx-runtime", "react-native", "@shopify/react-native-skia", "react-native-reanimated", "react-native-worklets",
  "react-native-gesture-handler", "react-native-webrtc", "@livekit/react-native-webrtc", "@livekit/react-native", "livekit-client",
  "expo-gl", "expo-camera", "expo-audio", "expo-video", "expo-sensors", "expo-location", "expo-haptics", "expo-file-system",
  "expo-notifications", "expo-speech", "expo-device", "expo-battery", "expo-brightness", "expo-clipboard", "expo-screen-orientation",
  "expo-image-picker", "expo-media-library", "expo-document-picker", "expo-sharing", "expo-secure-store", "expo-keep-awake",
  "expo-router", "expo-linear-gradient", "react-native-svg", "react-native-webview", "@react-native-async-storage/async-storage", "@remote/runtime",
];
const NATIVE = new Set(NATIVE_MODULES);
export const EXPERIENCES_DIR = join(import.meta.dir, "../../../casework");

/** Example apps that run natively inside the Casework Desk app: each is a scene around one experience module. */
export type CaseworkApp = { id: string; name: string; description: string; module: string; title: string; subtitle: string; accent: string; aliases?: string[] };
export const CASEWORK_APPS: CaseworkApp[] = [{
  id: "kitchen-sink", name: "Kitchen sink", module: "kitchen-sink", aliases: ["kitchen"],
  description: "The whole Casework native toolkit as one example app: camera and QR, audio, calls, video, GL, sensors, files, web.",
  title: "The possibility lab.", subtitle: "An entire native toolkit. An experience delivered live from Cyberdeck.", accent: "#b6f36a",
}];
export const HOME_SCENE = "cyberdeck";
const appFor = (name: string) => CASEWORK_APPS.find((a) => a.id === name || a.aliases?.includes(name));
const KEY_FILE = join(CYBERDECK_HOME, "casework-key");
const MEDIA_DIR = join(CYBERDECK_HOME, "casework-media");
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function loadCaseworkKey(): string {
  if (existsSync(KEY_FILE)) { const k = readFileSync(KEY_FILE, "utf8").trim(); if (k) return k; }
  return rotateCaseworkKey();
}
export function rotateCaseworkKey(): string {
  mkdirSync(CYBERDECK_HOME, { recursive: true });
  const key = randomBytes(24).toString("hex");
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Routes a casework-scoped key may reach: what the app and its experiences need, nothing else. */
export function caseworkAllows(method: string, path: string): boolean {
  const get = method === "GET", post = method === "POST";
  if (path === "/api/auth/whoami" || path === "/api/state" || path === "/api/experience-status" || path === "/api/status" || path === "/api/casework/me" || path === "/api/applications") return get;
  // The kitchen sink's Agent tab: the Casework Seed bridge behind this node (when one is configured).
  if (path.startsWith("/api/seed/")) return get || post;
  if (path === "/api/kiosk/stream") return get;
  if (path === "/api/audio") return get || post; // the remote's volume buttons
  if (path.startsWith("/api/modules/")) return get;
  if (path.startsWith("/api/media/")) return get || method === "PUT";
  if (path === "/api/command" || path === "/api/experiences/validate" || path === "/api/experiences/error" || path === "/api/casework/run") return post;
  // Voice: the app's AI call flow (docs/VOICE.md). Setup stays with the node token.
  if (path === "/api/voice/config" || path === "/api/voice/status" || path === "/api/voice/transcript") return get;
  if (path === "/api/voice/livekit" || path === "/api/voice/session/reset") return post;
  if (path === "/api/fleet/nodes") return get;
  if (path.startsWith("/api/control/")) {
    if (get) return true;
    return post && ["/api/control/collab/tick", "/api/control/collab/run", "/api/control/services/probe", "/api/control/sync"].includes(path);
  }
  return false;
}

/** Bundle a TSX experience the way the app expects: CommonJS, native modules left as require() calls. */
export async function compileExperience(name: string, dir = EXPERIENCES_DIR): Promise<Compiled> {
  if (!NAME_RE.test(name)) throw new Error("bad experience name");
  const entry = join(dir, `${name}.tsx`);
  if (!existsSync(entry)) throw new Error("Experience not found");
  // Production JSX runtime: the app's registry has react/jsx-runtime, not the dev runtime.
  const r = await Bun.build({ entrypoints: [entry], format: "cjs", target: "browser", packages: "external", minify: false, sourcemap: "none", define: { "process.env.NODE_ENV": '"production"' } });
  if (!r.success) throw new Error(r.logs.map(String).join("\n") || "bundle failed");
  const body = await r.outputs[0].text();
  for (const m of body.matchAll(/require\("([^"]+)"\)/g)) if (!NATIVE.has(m[1])) throw new Error(`Native module '${m[1]}' is not installed in the app build`);
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  // Error boundary identical in spirit to remote-control's: a crashing screen reports back instead of killing the app.
  const source = body + `
;(() => {
 const React = require('react'), RN = require('react-native'), Candidate = module.exports.default;
 class ExperienceBoundary extends React.Component {
   constructor(props) { super(props); this.state = {}; }
   static getDerivedStateFromError(error) { return {error: String(error)}; }
   componentDidCatch(error) { this.props.report(String(error)); }
   render() { return this.state.error ? React.createElement(RN.Text, {style:{color:'#ffad99',padding:20}}, 'Screen failed: ' + this.state.error) : this.props.children; }
 }
 module.exports = {...module.exports, default: function ProtectedExperience() {
   const runtime = require('@remote/runtime').useRuntime();
   return React.createElement(ExperienceBoundary, {report: error => {
     runtime.emit('experience.error', {name:${JSON.stringify(name)}, error});
     runtime.connection?.request('/api/experiences/error', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:${JSON.stringify(name)},hash:${JSON.stringify(hash)},error})}).catch(() => {});
   }}, React.createElement(Candidate));
 }};
})();`;
  return { source, hash, updatedAt: Date.now() };
}

export type CaseworkDeps = {
  token: string;
  nodeName: string;
  kiosk?: boolean;
  upgradeWebSocket: any;
  /** Full (token or tailscale) authentication for the current request. */
  isFullAuth: (c: any) => boolean;
  experiencesDir?: string;
  /** Fixed pairing key (tests); otherwise ~/.cyberdeck/casework-key is loaded or created. */
  key?: string;
  /** Voice availability for `/api/state` and the `welcome` frame (the Seed bridge's summary; absent = no voice). */
  voice?: () => Promise<{ configured: boolean; provider: "livekit" | "none"; reason?: string }>;
  /** The https origin that serves this daemon on the tailnet (`cyberdeck serve`), for the phone's Desk link. */
  secureOrigin?: () => Promise<string | null>;
  /** Casework Seed bridge for the kitchen sink's Agent tab (config `casework`, or SEED_BRIDGE_URL). */
  seedBridge?: { url?: string; tokenFile?: string };
};

/** Serve a file with byte ranges: iOS's native player will not play a video without them. */
function rangedFile(file: string, range: string | undefined, type: string): Response {
  const f = Bun.file(file), size = f.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "public, max-age=3600" };
  if (!m || (!m[1] && !m[2])) return new Response(f, { headers: { ...headers, "content-length": String(size) } });
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(f.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
}
const SAMPLE_TYPES: Record<string, string> = { mp4: "video/mp4", wav: "audio/wav", m4a: "audio/mp4", mp3: "audio/mpeg", jpg: "image/jpeg", png: "image/png" };

export function registerCaseworkRoutes(app: Hono, deps: CaseworkDeps) {
  const dir = deps.experiencesDir ?? EXPERIENCES_DIR;
  let key = deps.key ?? loadCaseworkKey();
  const matches = (supplied: string) => safeEq(supplied, key) || safeEq(supplied, deps.token);
  const module = (name: string) => ({ type: "RemoteModule", props: { name } });
  // Home is the whole deck. A kiosk node (enuc) puts its screen remote on top: that module opens full screen
  // on its own and leaves the deck underneath when it is closed.
  const scene = (): Scene => ({ title: "Cyberdeck", subtitle: `${deps.nodeName} · the whole deck`, accent: "#22d3ee", tree: deps.kiosk ? { type: "Column", children: [module("screen-remote"), module("cyberdeck")] } : module("cyberdeck") });
  /** A scene by name: home (`cyberdeck`; `casework` is what the original experiences call home) or an example app. */
  const sceneNamed = (name: string): { name: string; scene: Scene } | null => {
    if (name === HOME_SCENE || name === "casework" || name === "home") return { name: HOME_SCENE, scene: scene() };
    const a = appFor(name);
    return a ? { name: a.id, scene: { title: a.title, subtitle: a.subtitle, accent: a.accent, tree: module(a.module) } } : null;
  };
  /** Navigate devices (one, or all) to a scene. Navigation is per device and momentary: a reconnect lands on home. */
  const show = (name: string, deviceId?: string): { name: string; sent: number } | null => {
    const next = sceneNamed(name);
    if (!next) return null;
    let sent = 0;
    for (const p of peers.values()) if (p.role === "device" && (!deviceId || p.id === deviceId)) { p.scene = next.name; p.send({ type: "scene", scene: next.scene, revision: ++revision }); sent++; }
    if (sent) broadcast({ type: "devices", devices: devices() }, "console");
    return { name: next.name, sent };
  };
  let revision = Date.now();
  const peers = new Map<string, Peer>();
  const events: unknown[] = [];
  const compiled = new Map<string, Compiled>();
  const errors = new Map<string, string>();
  const devices = () => [...peers.values()].filter((p) => p.role === "device").map((p) => ({ id: p.id, info: p.info, scene: p.scene }));
  const consoles = () => [...peers.values()].filter((p) => p.role === "console").length;
  const broadcast = (msg: unknown, role?: Peer["role"]) => { for (const p of peers.values()) if (!role || p.role === role) p.send(msg); };
  const record = (event: unknown) => { events.push(event); if (events.length > 100) events.shift(); broadcast({ type: "event", event }, "console"); };
  const voice = async () => { try { return deps.voice ? await deps.voice() : { configured: false, provider: "none" as const }; } catch (e) { return { configured: false, provider: "none" as const, reason: String(e) }; } };
  const status = () => ({ modules: [...compiled].map(([name, v]) => ({ name, hash: v.hash, updatedAt: v.updatedAt, error: errors.get(name) })), errors: Object.fromEntries(errors), nativeModules: NATIVE_MODULES });
  const get = async (name: string) => {
    if (!compiled.has(name)) { try { compiled.set(name, await compileExperience(name, dir)); errors.delete(name); } catch (e) { errors.set(name, String(e)); throw e; } }
    return compiled.get(name)!;
  };
  const validate = async () => {
    let changed = false;
    for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => /^[\w-]+\.tsx$/.test(f)) : []) {
      const name = f.slice(0, -4);
      try { const next = await compileExperience(name, dir); if (next.hash !== compiled.get(name)?.hash) { compiled.set(name, next); changed = true; } errors.delete(name); } catch (e) { errors.set(name, String(e)); }
    }
    if (changed) { revision = Date.now(); broadcast({ type: "modules.changed", revision }); }
    return { changed, ...status() };
  };
  void validate().catch(() => {});

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/state", async (c) => c.json({ scene: scene(), revision, devices: devices(), events, presets: [HOME_SCENE, ...CASEWORK_APPS.map((a) => a.id)], voice: await voice() }));
  app.get("/api/experience-status", (c) => c.json(status()));
  app.post("/api/experiences/validate", async (c) => c.json(await validate()));
  app.post("/api/experiences/error", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!["name", "hash", "error"].every((k) => typeof body[k] === "string")) return c.json({ error: "bad request" }, 400);
    errors.set(body.name, String(body.error).slice(0, 2000));
    record({ name: "experience.error", at: Date.now(), module: body.name, hash: body.hash, error: body.error });
    return c.json({ restored: false });
  });
  app.get("/api/modules/:name", async (c) => {
    const name = c.req.param("name");
    if (!NAME_RE.test(name)) return c.json({ error: "bad name" }, 400);
    try { const v = await get(name); return c.body(v.source, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); }
    catch (e) { return c.json({ error: String(e) }, existsSync(join(dir, `${name}.tsx`)) ? 500 : 404); }
  });
  app.post("/api/command", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = body.action;
    if (!action || typeof action.name !== "string" || !action.name || action.name.length > 100) return c.json({ error: "bad action" }, 400);
    const id = randomUUID();
    let sent = 0;
    for (const p of peers.values()) if (p.role === "device" && (!body.deviceId || p.id === body.deviceId)) { p.send({ type: "command", id, action: { name: action.name, args: action.args ?? {} } }); sent++; }
    return c.json({ id, sent }, sent ? 202 : 409);
  });
  // Send a scene (home or an example app) to every device, or to one with {deviceId}.
  app.post("/api/preset/:name", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = show(c.req.param("name"), typeof body.deviceId === "string" && body.deviceId ? body.deviceId : undefined);
    if (!r) return c.json({ error: "unknown preset" }, 404);
    return c.json({ revision, scene: r.name, sent: r.sent });
  });
  // Sample media the kitchen sink plays (a generated test pattern and chime). The native players send no
  // Authorization header, so like the UI these sit outside /api: tailnet-gated, not token-gated.
  app.get("/samples/:name", (c) => {
    const name = c.req.param("name");
    const type = SAMPLE_TYPES[name.split(".").pop() ?? ""];
    const file = join(dir, "samples", name);
    if (!/^[a-zA-Z0-9_-]{1,60}\.[a-z0-9]{2,4}$/.test(name) || !type || !existsSync(file)) return c.json({ error: "not found" }, 404);
    return rangedFile(file, c.req.header("range"), type);
  });
  // The kitchen sink's Agent tab talks to the Casework Seed bridge; its credential never reaches the device.
  app.all("/api/seed/*", async (c) => {
    const base = deps.seedBridge?.url || process.env.SEED_BRIDGE_URL;
    if (!base) return c.json({ error: "Seed agent is not configured on this node (config casework.url)." }, 502);
    const route = c.req.path.slice("/api/seed".length);
    if (!/^\/[a-z/-]{1,60}$/.test(route) || !["GET", "POST"].includes(c.req.method)) return c.json({ error: "bad request" }, 400);
    try {
      const token = readFileSync(deps.seedBridge?.tokenFile || join(homedir(), "Library/Application Support/CaseworkSeed/bridge-token"), "utf8").trim();
      // The app calls this the screen context; the bridge files it under the voice room.
      let target = route, body: string | undefined = c.req.method === "POST" ? await c.req.text() : undefined;
      if (route === "/screen-context") {
        const b = JSON.parse(body || "{}");
        if (typeof b.room !== "string" || typeof b.scene !== "string" || !b.scene.trim() || b.scene.length > 120 || [b.section, b.detail, b.resource].some((v) => v !== undefined && (typeof v !== "string" || v.length > 240))) return c.json({ error: "bad request" }, 400);
        target = "/voice/context";
        body = JSON.stringify({ room: b.room, context: JSON.stringify({ scene: b.scene, section: b.section, detail: b.detail, resource: b.resource }), capturedAt: Date.now() });
      }
      const r = await fetch(`${base.replace(/\/$/, "")}${target}${new URL(c.req.url).search}`, { method: c.req.method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(300_000) });
      const result = await r.json().catch(() => ({ error: `Seed returned HTTP ${r.status}` }));
      return c.json(r.ok ? result : { error: result.error || `Seed returned HTTP ${r.status}` }, r.ok ? 200 : 502);
    } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 502); }
  });
  app.put("/api/media/:name", async (c) => {
    const name = c.req.param("name");
    if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(name) || name.startsWith(".")) return c.json({ error: "bad name" }, 400);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > 80 * 1024 * 1024) return c.json({ error: "too large" }, 413);
    mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
    const stored = `${randomUUID()}-${name}`;
    writeFileSync(join(MEDIA_DIR, stored), bytes, { mode: 0o600 });
    record({ name: "media.upload", at: Date.now(), path: `/api/media/${stored}`, bytes: bytes.length });
    return c.json({ path: `/api/media/${stored}`, bytes: bytes.length }, 201);
  });
  app.get("/api/media/:name", (c) => {
    const name = c.req.param("name");
    if (!/^[a-zA-Z0-9_.-]{1,180}$/.test(name) || name.startsWith(".")) return c.json({ error: "bad name" }, 400);
    const file = join(MEDIA_DIR, name);
    if (!existsSync(file)) return c.json({ error: "not found" }, 404);
    return new Response(Bun.file(file));
  });

  // Dashboard-side management (full auth only).
  app.get("/api/casework/pairing", async (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const origin = c.req.query("url") || new URL(c.req.url).origin;
    let url: URL;
    try { url = new URL(origin); if (!/^https?:$/.test(url.protocol)) throw new Error(); } catch { return c.json({ error: "url must be http(s)" }, 400); }
    const link = `remotecontrol://?url=${encodeURIComponent(url.origin)}&token=${encodeURIComponent(key)}`;
    // A phone browser only gets the microphone on https (or localhost), so the Desk link prefers the tailnet origin.
    const secure = (await deps.secureOrigin?.().catch(() => null)) ?? (url.protocol === "https:" ? url.origin : null);
    const deskUrl = `${secure ?? url.origin}/#/desk`;
    const desk = { url: deskUrl, secure: Boolean(secure), qr: qrSvg(deskUrl, { scale: 5, dark: "#07080c", light: "#e8fbff" }) };
    return c.json({ url: url.origin, key, link, qr: qrSvg(link, { scale: 5, dark: "#07080c", light: "#e8fbff" }), devices: devices(), desk });
  });
  app.post("/api/casework/rotate", (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    key = deps.key ? randomBytes(24).toString("hex") : rotateCaseworkKey();
    for (const p of [...peers.values()]) if (p.role === "device") p.close();
    return c.json({ rotated: true });
  });
  // The QR the kitchen sink's Camera tab scans: the decoded text comes back as a `camera.barcode` event.
  app.get("/api/casework/demo-qr", (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    const text = `CYBERDECK: scanned on the iPad, received by ${deps.nodeName}`;
    return c.json({ text, qr: qrSvg(text, { scale: 6, dark: "#07080c", light: "#ffffff" }) });
  });
  app.get("/api/casework/me", (c) => c.json({ node: deps.nodeName, devices: devices(), events: events.slice(-20) }));
  app.get("/api/casework/devices", (c) => c.json({ devices: devices(), events: events.slice(-50) }));
  // Bounded, non-interactive command for the app's Run screen.
  app.post("/api/casework/run", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cmd = String(body.cmd ?? "").trim();
    if (!cmd || cmd.length > 2000) return c.json({ error: "cmd required" }, 400);
    const home = process.env.HOME ?? CYBERDECK_HOME;
    const cwd = String(body.cwd ?? "~").replace(/^~(?=$|\/)/, home) || home;
    if (!existsSync(cwd)) return c.json({ error: `no such directory: ${cwd}` }, 400);
    const p = Bun.spawn(["bash", "-lc", cmd], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`, TERM: "dumb" } });
    const t = setTimeout(() => p.kill(), 60_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(t);
    record({ name: "casework.run", at: Date.now(), cwd, cmd, code });
    return c.json({ code, output: (out + (err ? `\n${err}` : "")).slice(-60_000) });
  });

  // Device/console WebSocket. Authenticates in the first frame, like the original server.
  app.get("/control", deps.upgradeWebSocket((_c: any) => {
    let peer: Peer | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      onOpen(_ev: unknown, ws: any) {
        timer = setTimeout(() => { try { ws.close(4001, "Pairing required"); } catch {} }, 5000);
      },
      onMessage(ev: { data: unknown }, ws: any) {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { ws.send(JSON.stringify({ type: "error", error: "bad json" })); return; }
        if (!peer) {
          if (msg.type !== "hello" || typeof msg.token !== "string" || !matches(msg.token) || !["device", "console"].includes(msg.role)) { try { ws.close(4001, "Invalid pairing"); } catch {} return; }
          clearTimeout(timer);
          const id = randomUUID();
          peer = { id, role: msg.role, info: msg.info, scene: HOME_SCENE, send: (m) => { try { ws.send(JSON.stringify(m)); } catch {} }, close: () => { try { ws.close(1000, "key rotated"); } catch {} } };
          peers.set(id, peer);
          const p = peer;
          // The welcome carries voice availability, which may need a (cached) agents-server probe.
          void voice().then((v) => { if (peers.get(id) === p) p.send({ type: "welcome", id, scene: scene(), revision, voice: v, devices: devices() }); });
          broadcast({ type: "devices", devices: devices() }, "console");
          if (msg.role === "device") record({ name: "device.connected", at: Date.now(), deviceId: id, info: msg.info });
          return;
        }
        if (msg.type === "ping") { peer.send({ type: "pong", at: msg.at }); return; }
        // WebRTC call signalling between a device and a console (the web Kitchen sink console answers calls).
        if (msg.type === "signal") {
          const target = typeof msg.to === "string" ? peers.get(msg.to) : undefined;
          if (target && target.role !== peer.role) target.send({ type: "signal", from: peer.id, signal: msg.signal });
          else peer.send({ type: "error", error: "Call peer is unavailable" });
          return;
        }
        if (peer.role === "device" && msg.type === "event") {
          record({ deviceId: peer.id, at: Date.now(), name: msg.name, data: msg.data });
          if (msg.name === "scene" && typeof msg.data?.name === "string") show(msg.data.name, peer.id);
          if (msg.name === "call.request") {
            if (consoles()) broadcast({ type: "call.request", from: peer.id, video: Boolean(msg.data?.video) }, "console");
            else peer.send({ type: "error", error: "Open Cyberdeck → Applications → Kitchen sink in a browser to receive the call" });
          }
          return;
        }
        if (peer.role === "device" && msg.type === "result") { record({ deviceId: peer.id, at: Date.now(), ...msg }); return; }
      },
      onClose() {
        clearTimeout(timer);
        if (peer) { peers.delete(peer.id); broadcast({ type: "peer.left", id: peer.id }); broadcast({ type: "devices", devices: devices() }, "console"); }
      },
    };
  }));

  return { matches, allows: caseworkAllows, devices, validate, show, apps: () => CASEWORK_APPS, currentKey: () => key };
}
