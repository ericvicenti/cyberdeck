// Casework Desk workflow server: makes the Casework Desk iPad/iPhone app (Eric's
// server-driven Expo client, repo ~/Code/remote-control) a native client of this node.
//
// Wire protocol (fixed by the shipped app, TestFlight 1.0.0 (2)):
//   GET  /health                      liveness (no auth)
//   GET  /api/state                   scene + revision + devices + events (Bearer pairing key)
//   GET  /api/modules/:name?v=rev     compiled CommonJS experience (TSX bundled here with Bun.build)
//   POST /api/experiences/validate    recompile; GET /api/experience-status; POST /api/experiences/error
//   POST /api/command                 {deviceId?, action:{name,args}} -> delivered over the socket
//   PUT  /api/media/:name             uploads from the device; GET /api/media/:name
//   WS   /control                     first frame {type:"hello", role:"device"|"console", token, info}
//                                     -> {type:"welcome", id, scene, revision, voice, devices}; then
//                                     ping/pong, scene, command/result, event, modules.changed, peer.left
// The app authenticates with a pairing key. We accept a dedicated key stored at
// ~/.cyberdeck/casework-key (so the phone never holds the main token) or the
// main bearer token; the key is scoped to the routes the app needs (see caseworkAllows).
import type { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { CYBERDECK_HOME } from "../config";
import { qrSvg } from "../casework/qr";

export type Scene = { title: string; subtitle?: string; accent?: string; tree: unknown };
type Peer = { id: string; role: "device" | "console"; info?: unknown; send: (msg: unknown) => void; close: () => void };
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
  if (path === "/api/auth/whoami" || path === "/api/state" || path === "/api/experience-status" || path === "/api/status" || path === "/api/casework/me") return get;
  if (path.startsWith("/api/modules/")) return get;
  if (path.startsWith("/api/media/")) return get || method === "PUT";
  if (path === "/api/command" || path === "/api/experiences/validate" || path === "/api/experiences/error" || path === "/api/casework/run") return post;
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
  upgradeWebSocket: any;
  /** Full (token or tailscale) authentication for the current request. */
  isFullAuth: (c: any) => boolean;
  experiencesDir?: string;
  /** Fixed pairing key (tests); otherwise ~/.cyberdeck/casework-key is loaded or created. */
  key?: string;
};

export function registerCaseworkRoutes(app: Hono, deps: CaseworkDeps) {
  const dir = deps.experiencesDir ?? EXPERIENCES_DIR;
  let key = deps.key ?? loadCaseworkKey();
  const matches = (supplied: string) => safeEq(supplied, key) || safeEq(supplied, deps.token);
  const scene = (): Scene => ({ title: "Cyberdeck", subtitle: `${deps.nodeName} · fleet control`, accent: "#22d3ee", tree: { type: "RemoteModule", props: { name: "cyberdeck" } } });
  let revision = Date.now();
  const peers = new Map<string, Peer>();
  const events: unknown[] = [];
  const compiled = new Map<string, Compiled>();
  const errors = new Map<string, string>();
  const devices = () => [...peers.values()].filter((p) => p.role === "device").map((p) => ({ id: p.id, info: p.info }));
  const broadcast = (msg: unknown, role?: Peer["role"]) => { for (const p of peers.values()) if (!role || p.role === role) p.send(msg); };
  const record = (event: unknown) => { events.push(event); if (events.length > 100) events.shift(); broadcast({ type: "event", event }, "console"); };
  const voice = () => ({ configured: false, provider: "none" });
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
  app.get("/api/state", (c) => c.json({ scene: scene(), revision, devices: devices(), events, presets: ["cyberdeck"], voice: voice() }));
  app.get("/api/voice/config", (c) => c.json(voice()));
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
  app.post("/api/preset/:name", (c) => { if (c.req.param("name") !== "cyberdeck") return c.json({ error: "unknown preset" }, 404); revision++; broadcast({ type: "scene", scene: scene(), revision }); return c.json({ revision }); });
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
    return c.json({ url: url.origin, key, link, qr: qrSvg(link, { scale: 5, dark: "#07080c", light: "#e8fbff" }), devices: devices() });
  });
  app.post("/api/casework/rotate", (c) => {
    if (!deps.isFullAuth(c)) return c.json({ error: "forbidden" }, 403);
    key = deps.key ? randomBytes(24).toString("hex") : rotateCaseworkKey();
    for (const p of [...peers.values()]) if (p.role === "device") p.close();
    return c.json({ rotated: true });
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
          peer = { id, role: msg.role, info: msg.info, send: (m) => { try { ws.send(JSON.stringify(m)); } catch {} }, close: () => { try { ws.close(1000, "key rotated"); } catch {} } };
          peers.set(id, peer);
          peer.send({ type: "welcome", id, scene: scene(), revision, voice: voice(), devices: devices() });
          broadcast({ type: "devices", devices: devices() }, "console");
          record({ name: "device.connected", at: Date.now(), deviceId: id, info: msg.info });
          return;
        }
        if (msg.type === "ping") { peer.send({ type: "pong", at: msg.at }); return; }
        if (peer.role === "device" && msg.type === "event") {
          record({ deviceId: peer.id, at: Date.now(), name: msg.name, data: msg.data });
          if (msg.name === "scene" && msg.data?.name === "cyberdeck") peer.send({ type: "scene", scene: scene(), revision: ++revision });
          if (msg.name === "call.request") peer.send({ type: "error", error: "Calls are not available on Cyberdeck" });
          return;
        }
        if (peer.role === "device" && msg.type === "result") { record({ deviceId: peer.id, at: Date.now(), ...msg }); return; }
        if (msg.type === "signal") peer.send({ type: "error", error: "Call peer is unavailable" });
      },
      onClose() {
        clearTimeout(timer);
        if (peer) { peers.delete(peer.id); broadcast({ type: "peer.left", id: peer.id }); broadcast({ type: "devices", devices: devices() }, "console"); }
      },
    };
  }));

  return { matches, allows: caseworkAllows, devices, validate, currentKey: () => key };
}
