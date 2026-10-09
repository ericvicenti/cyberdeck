// System volume: wpctl/osascript parsing, the clamp, and the /api/audio routes
// (full auth and the Casework pairing key) against a fake PipeWire.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import { testConfig, TEST_TOKEN, tmpHomeDir } from "./helpers";
import { parseWpctlVolume, parseWpctlDescription, parsePatch, pipewireBackend, macBackend, type Runner } from "../src/daemon/api/audio";
import { caseworkAllows } from "../src/daemon/api/casework";

/** A fake wpctl with one sink. */
function fakePipewire(initial = { volume: 0.4, muted: false }) {
  const sink = { ...initial };
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    const [cmd, sub, ...rest] = argv;
    if (cmd !== "wpctl") return { code: 127, stdout: "", stderr: `${cmd}: not found` };
    if (sub === "get-volume") return { code: 0, stdout: `Volume: ${sink.volume.toFixed(2)}${sink.muted ? " [MUTED]" : ""}\n`, stderr: "" };
    if (sub === "inspect") return { code: 0, stdout: `id 56, type PipeWire:Interface:Node\n    node.description = "PCM2900C Audio CODEC Analog Stereo"\n`, stderr: "" };
    if (sub === "set-volume") { const pct = rest[rest.length - 1]; sink.volume = parseInt(pct, 10) / 100; return { code: 0, stdout: "", stderr: "" }; }
    if (sub === "set-mute") { const v = rest[rest.length - 1]; sink.muted = v === "toggle" ? !sink.muted : v === "1"; return { code: 0, stdout: "", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  return { sink, calls, run };
}

describe("parsing", () => {
  test("wpctl volume with and without mute", () => {
    expect(parseWpctlVolume("Volume: 0.40\n")).toEqual({ volume: 40, muted: false });
    expect(parseWpctlVolume("Volume: 1.00 [MUTED]\n")).toEqual({ volume: 100, muted: true });
    expect(parseWpctlVolume("garbage")).toBeNull();
  });
  test("wpctl inspect description", () => {
    expect(parseWpctlDescription('  node.description = "Built-in Audio Digital Stereo (HDMI)"\n')).toBe("Built-in Audio Digital Stereo (HDMI)");
    expect(parseWpctlDescription("")).toBeNull();
  });
  test("patch validation clamps and rejects junk", () => {
    expect(parsePatch({ volume: 250 })).toEqual({ volume: 100 });
    expect(parsePatch({ volume: -3 })).toEqual({ volume: 0 });
    expect(parsePatch({ delta: 5, muted: "toggle" })).toEqual({ delta: 5, muted: "toggle" });
    expect(parsePatch({ volume: "50" })).toBeNull();
    expect(parsePatch({})).toBeNull();
    expect(parsePatch(null)).toBeNull();
  });
});

describe("pipewire backend", () => {
  test("reads, steps and mutes without ever exceeding 100%", async () => {
    const pw = fakePipewire({ volume: 0.98, muted: false });
    const b = pipewireBackend(pw.run);
    expect(await b.get()).toEqual({ available: true, volume: 98, muted: false, device: "PCM2900C Audio CODEC Analog Stereo" });
    expect((await b.set({ delta: 5 })).volume).toBe(100);
    expect((await b.set({ delta: -30 })).volume).toBe(70);
    expect((await b.set({ muted: "toggle" })).muted).toBe(true);
    expect((await b.set({ muted: false, volume: 12 })).muted).toBe(false);
    expect(pw.sink.volume).toBeCloseTo(0.12);
    // every set-volume carries the 1.0 limit so wpctl itself refuses to go above 0 dB
    for (const c of pw.calls.filter((c) => c[1] === "set-volume")) expect(c.slice(2, 4)).toEqual(["-l", "1.0"]);
  });
  test("reports unavailable when wpctl is missing or has no sink", async () => {
    const missing = pipewireBackend(async () => { throw new Error("spawn wpctl ENOENT"); });
    expect((await missing.get()).available).toBe(false);
    const noSink = pipewireBackend(async () => ({ code: 1, stdout: "", stderr: "Node 0 does not exist\n" }));
    expect(await noSink.get()).toMatchObject({ available: false, reason: "Node 0 does not exist" });
  });
});

describe("mac backend", () => {
  test("parses osascript and writes volume + mute", async () => {
    let vol = 30, muted = false;
    const calls: string[][] = [];
    const b = macBackend(async (argv) => {
      calls.push(argv);
      const script = argv.slice(1).join(" ");
      const m = /set volume output volume (\d+)/.exec(script); if (m) vol = parseInt(m[1], 10);
      const mm = /set volume output muted (true|false)/.exec(script); if (mm) muted = mm[1] === "true";
      return { code: 0, stdout: `${vol} ${muted}\n`, stderr: "" };
    });
    expect(await b.get()).toEqual({ available: true, volume: 30, muted: false, device: null });
    expect((await b.set({ delta: 100 })).volume).toBe(100);
    expect((await b.set({ muted: "toggle" })).muted).toBe(true);
    expect(calls.some((c) => c.includes("set volume output muted true"))).toBe(true);
  });
});

describe("/api/audio", () => {
  const KEY = "casework-pairing-key-for-audio-tests";
  process.env.CYBERDECK_SEED_KEY_SEED ??= "7f".repeat(32);
  const seedHome = tmpHomeDir("audio-seed");
  const pw = fakePipewire();
  let server: ReturnType<typeof Bun.serve>; let base = ""; let sessions: { close: () => void };
  beforeAll(() => {
    const db = new Database(":memory:"); initSchema(db);
    const s = createServer(db, testConfig({ seed: { agentsUrl: "http://127.0.0.1:1" } }), TEST_TOKEN, "stw-test", { caseworkKey: KEY, audio: pipewireBackend(pw.run), persistOwner: false, cloudSync: false, seed: { home: seedHome.dir, companionFile: join(seedHome.dir, "none.json") } });
    sessions = s.sessions;
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: s.fetch, websocket: s.websocket });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { sessions.close(); void server.stop(true); seedHome.cleanup(); });
  const call = (auth: string, init: RequestInit = {}) => fetch(`${base}/api/audio`, { ...init, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", ...init.headers } });

  test("GET reports the default sink", async () => {
    const r = await call(TEST_TOKEN);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ available: true, volume: 40, muted: false, device: "PCM2900C Audio CODEC Analog Stereo" });
  });
  test("POST sets, steps and mutes; junk is a 400", async () => {
    expect((await (await call(TEST_TOKEN, { method: "POST", body: JSON.stringify({ volume: 65 }) })).json()).volume).toBe(65);
    expect((await (await call(TEST_TOKEN, { method: "POST", body: JSON.stringify({ delta: -5 }) })).json()).volume).toBe(60);
    expect((await (await call(TEST_TOKEN, { method: "POST", body: JSON.stringify({ muted: true }) })).json()).muted).toBe(true);
    expect((await call(TEST_TOKEN, { method: "POST", body: JSON.stringify({ volume: "loud" }) })).status).toBe(400);
    expect((await call(TEST_TOKEN, { method: "POST", body: "not json" })).status).toBe(400);
  });
  test("the Casework pairing key may read and set the volume", async () => {
    expect(caseworkAllows("GET", "/api/audio")).toBe(true);
    expect(caseworkAllows("POST", "/api/audio")).toBe(true);
    expect(caseworkAllows("DELETE", "/api/audio")).toBe(false);
    const r = await call(KEY, { method: "POST", body: JSON.stringify({ volume: 20, muted: false }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ volume: 20, muted: false });
    expect((await call("wrong-key")).status).toBe(401);
  });
});
