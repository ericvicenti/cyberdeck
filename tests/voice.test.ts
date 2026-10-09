// Voice bridge: Cyberdeck signs Seed agents actions as a vault identity and mints LiveKit rooms for
// the Casework app. A fake agents server verifies the signed CBOR envelopes and answers the actions
// setup and calls need.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as blobs from "@seed-hypermedia/client/blobs";
import * as cbor from "@seed-hypermedia/client/cbor";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import { seedConfig } from "../src/daemon/config";
import { caseworkAllows } from "../src/daemon/api/casework";
import { secureCallUrl } from "../src/daemon/api/voice";
import { Tailscale } from "../src/daemon/tailscale";
import { DOGFOOD_PROMPT, DOGFOOD_TRIGGER_NAME } from "../src/daemon/seed";
import { testConfig, TEST_TOKEN, tmpHomeDir } from "./helpers";

// Deterministic signer; the bridge builds the keypair from this instead of opening the Seed vault.
const SEED_HEX = "7f".repeat(32);
process.env.CYBERDECK_SEED_KEY_SEED = SEED_HEX;
const EXPECTED_PRINCIPAL = blobs.principalToString(blobs.nobleKeyPairFromSeed(Uint8Array.from(Buffer.from(SEED_HEX, "hex"))).principal);

const KEY = "casework-pairing-key-for-voice-tests";
const FIXTURES = join(import.meta.dir, "fixtures", "casework");
const COMPANION_ID = "companion-agent-1";
const RUNTIME_TOKEN = "internal-voice-runtime-token";

type Action = Record<string, any>;
function fakeAgents(opts: { voice: boolean }) {
  const actions: Action[] = [];
  const agents = new Map<string, Record<string, any>>([[COMPANION_ID, { name: "Casework Companion", systemPrompt: "x", modelProvider: "OpenAI", model: "gpt-6-sol", mcpServers: ["casework_host"] }]]);
  const sessions = new Map<string, { agentId: string; continuedTo?: string }>();
  const secrets = new Map<string, Uint8Array>();
  const mcp = new Map<string, Record<string, any>>();
  const triggers = new Map<string, Record<string, any>[]>();
  const runtimeCalls: { auth: string | null; body: any }[] = [];
  let n = 0;
  const err = (status: number, message: string) => new Response(cbor.encode({ _: "Error", message }) as unknown as BodyInit, { status, headers: { "content-type": "application/cbor" } });
  const ok = (body: unknown) => new Response(cbor.encode(body) as unknown as BodyInit, { headers: { "content-type": "application/cbor" } });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return Response.json({ status: "ok", version: "fake", protocol: 3, voice: opts.voice });
      // The internal voice runtime route (bearer = SEED_AGENTS_VOICE_INTERNAL_TOKEN), validated like the real one.
      if (url.pathname === "/api/voice/runtime" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        runtimeCalls.push({ auth: req.headers.get("authorization"), body });
        if (req.headers.get("authorization") !== `Bearer ${RUNTIME_TOKEN}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const pr = body?.profile;
        if (pr && (typeof pr.voice !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(pr.voice) || typeof pr.speed !== "number" || pr.speed < 0.6 || pr.speed > 2)) return Response.json({ error: "Invalid voice profile" }, { status: 400 });
        return Response.json({ pid: 1, rooms: [] });
      }
      if (url.pathname !== "/api/message" || req.method !== "POST") return Response.json({ error: "nope" }, { status: 404 });
      if (!(req.headers.get("content-type") ?? "").startsWith("application/cbor")) return err(415, "Content-Type must be application/cbor");
      const env: any = cbor.decode(new Uint8Array(await req.arrayBuffer()));
      if (env.type !== "AgentsAction" || env.protocol !== 3) return err(400, "bad envelope");
      await blobs.nativeCryptoReady;
      if (!blobs.verify(env)) return err(401, "Invalid signature");
      if (!blobs.principalEqual(env.signer, env.account)) return err(403, "Signer is not authorized for account");
      if (blobs.principalToString(env.account) !== EXPECTED_PRINCIPAL) return err(403, "unexpected account");
      if (Math.abs(Date.now() - env.action.ts) > 5 * 60_000) return err(400, "Action timestamp is outside allowed window");
      const a = env.action;
      actions.push(a);
      switch (a._) {
        case "SetSecret": secrets.set(a.name, a.value); return ok({ _: "SetSecretResponse", secret: { name: a.name } });
        case "SetMcpServer": mcp.set(a.name, a.config); return ok({ _: "SetMcpServerResponse", server: { name: a.name, status: { state: "ok", checkedAt: Date.now() }, tools: [{ name: "status" }, { name: "todo" }] } });
        case "GetAgent": { const d = agents.get(a.agentId); return d ? ok({ _: "GetAgentResponse", agent: { id: a.agentId, definition: d }, sessionCount: 0 }) : err(404, "Agent not found"); }
        case "UpdateAgent": if (!agents.has(a.agentId)) return err(404, "Agent not found"); agents.set(a.agentId, a.definition); return ok({ _: "UpdateAgentResponse", agent: { id: a.agentId, definition: a.definition } });
        case "CreateAgent": { const id = `agent-${++n}`; agents.set(id, a.definition); return ok({ _: "CreateAgentResponse", agentId: id }); }
        case "CreateSession": { if (!agents.has(a.agentId)) return err(404, "Agent not found"); const id = `session-${++n}`; sessions.set(id, { agentId: a.agentId }); return ok({ _: "CreateSessionResponse", sessionId: id }); }
        case "GetSession": {
          const s = sessions.get(a.sessionId);
          if (!s) return err(404, "Session not found");
          const events = [
            { id: "e1", sessionId: a.sessionId, seq: 1, createdAt: 1, event: { type: "message", role: "user", content: "Hi" } },
            { id: "e2", sessionId: a.sessionId, seq: 2, createdAt: 2, event: { type: "message", role: "tool", content: "{}", toolCallId: "t" } },
            { id: "e3", sessionId: a.sessionId, seq: 3, createdAt: 3, event: { type: "message", role: "assistant", content: "Hello from the fleet." } },
          ];
          return ok({ _: "GetSessionResponse", session: { id: a.sessionId, agentId: s.agentId, status: "idle", ...(s.continuedTo ? { continuedTo: { continuationId: "c", sessionId: s.continuedTo, reason: "context", createdAt: 1 } } : {}) }, events: events.slice(-(a.limit ?? events.length)), systemPromptMarkdown: "" });
        }
        case "ListAgentTriggers": return ok({ _: "ListAgentTriggersResponse", triggers: triggers.get(a.agentId) ?? [] });
        case "CreateAgentTrigger": {
          if (!agents.has(a.agentId)) return err(404, "Agent not found");
          const sc = a.trigger?.source?.schedule;
          if (a.trigger?.source?.type !== "schedule" || sc?.kind !== "weekly" || !Array.isArray(sc.daysOfWeek) || !sc.daysOfWeek.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) || !/^\d{2}:\d{2}$/.test(sc.timeOfDay) || typeof sc.timezone !== "string") return err(400, "Schedule is invalid");
          if (typeof a.trigger.prompt !== "string" || !a.trigger.name) return err(400, "Trigger prompt is required");
          const t = { id: `trigger-${++n}`, account: "x", agentId: a.agentId, name: a.trigger.name, enabled: a.trigger.enabled !== false, source: a.trigger.source, prompt: a.trigger.prompt, continuation: a.trigger.continuation, createdAt: Date.now(), updatedAt: Date.now() };
          triggers.set(a.agentId, [...(triggers.get(a.agentId) ?? []), t]);
          return ok({ _: "CreateAgentTriggerResponse", trigger: t });
        }
        case "CreateVoiceSession": {
          if (!opts.voice) return err(501, "Voice is not available on this server");
          if (!sessions.has(a.sessionId)) return err(404, "Session not found");
          return ok({ _: "CreateVoiceSessionResponse", sessionId: a.sessionId, url: "wss://livekit.example/", token: "jwt-" + a.sessionId, room: "room-" + a.sessionId, identity: "caller", expiresAt: Date.now() + 60_000 });
        }
        default: return err(400, `Unsupported action ${a._}`);
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, actions, agents, sessions, secrets, mcp, triggers, runtimeCalls, stop: () => void server.stop(true) };
}

type Node = { base: string; wsBase: string; home: string; stop: () => void; cleanup: () => void };
function startNode(agentsUrl: string, prefix: string, companion?: object, runtimeToken?: string): Node {
  const { dir, cleanup } = tmpHomeDir(prefix);
  const companionFile = join(dir, "companion.json");
  if (companion) writeFileSync(companionFile, JSON.stringify(companion));
  // Always point at a file inside the temp home so the test never reads this Mac's real runtime.json.
  const runtimeFile = join(dir, "runtime.json");
  if (runtimeToken) writeFileSync(runtimeFile, JSON.stringify({ SEED_AGENTS_VOICE_INTERNAL_TOKEN: runtimeToken, SEED_AGENTS_HTTP_PORT: "3053" }));
  const db = new Database(":memory:");
  initSchema(db);
  const s = createServer(db, testConfig({ port: 4777, seed: { agentsUrl } }), TEST_TOKEN, "stw-test", { caseworkKey: KEY, caseworkExperiencesDir: FIXTURES, persistOwner: false, cloudSync: false, tailscale: new Tailscale(async () => null), seed: { home: dir, companionFile, runtimeFile } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: s.fetch, websocket: s.websocket });
  return { base: `http://127.0.0.1:${server.port}`, wsBase: `ws://127.0.0.1:${server.port}`, home: dir, stop: () => { s.sessions.close(); void server.stop(true); }, cleanup };
}
const req = (node: Node, token: string, path: string, init: RequestInit = {}) => fetch(`${node.base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });

function welcome(node: Node): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${node.wsBase}/control`);
    ws.onmessage = (ev) => { resolve(JSON.parse(String(ev.data))); ws.close(); };
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "device", token: KEY, info: { name: "Test iPad" } }));
    ws.onerror = () => reject(new Error("socket error"));
    ws.onclose = (e) => { if (e.code === 4001) resolve({ type: "closed", code: e.code }); };
  });
}

let voiced: ReturnType<typeof fakeAgents>, muted: ReturnType<typeof fakeAgents>;
let a: Node, b: Node, c: Node;
beforeAll(() => {
  voiced = fakeAgents({ voice: true });
  muted = fakeAgents({ voice: false });
  a = startNode(voiced.url, "voice-a", { agentId: COMPANION_ID, sessionId: "old-companion-session", profile: { voice: "v", speed: 1 } }, RUNTIME_TOKEN);
  b = startNode(muted.url, "voice-b");
  // Same companion and profile, but a runtime token the agents server rejects.
  c = startNode(voiced.url, "voice-c", { agentId: COMPANION_ID, profile: { voice: "v-other", speed: 1.2 } }, "stale-token");
});
afterAll(() => { for (const n of [a, b, c]) { n.stop(); n.cleanup(); } voiced.stop(); muted.stop(); });

describe("secure call url", () => {
  const hosts = new Set(["localhost", "127.0.0.1", "192.168.1.131"]);
  const serve = async (port: number) => (port === 7880 ? "https://yacht.tail.ts.net:7443" : null);
  test("a plain ws:// call server on this machine gets the wss:// twin tailscale serve publishes", async () => {
    expect(await secureCallUrl("ws://192.168.1.131:7880", serve, hosts)).toBe("wss://yacht.tail.ts.net:7443");
    expect(await secureCallUrl("ws://localhost:7880/rtc", serve, hosts)).toBe("wss://yacht.tail.ts.net:7443/rtc");
  });
  test("no twin for TLS urls, other machines, or unpublished ports", async () => {
    expect(await secureCallUrl("wss://voice.botical.com/rtc", serve, hosts)).toBeNull();
    expect(await secureCallUrl("ws://192.168.1.99:7880", serve, hosts)).toBeNull();
    expect(await secureCallUrl("ws://127.0.0.1:7999", serve, hosts)).toBeNull();
    expect(await secureCallUrl("not a url", serve, hosts)).toBeNull();
  });
});

describe("seed config", () => {
  test("defaults, file values, then env overrides", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(seedConfig({}, env)).toEqual({ agentsUrl: "http://127.0.0.1:3053", identity: "main", modelProvider: "OpenAI", model: "gpt-6-sol" });
    expect(seedConfig({ seed: { agentsUrl: "http://a:1/", identity: "" } }, env).agentsUrl).toBe("http://a:1");
    expect(seedConfig({ seed: { agentsUrl: "http://a:1/", identity: "" } }, env).identity).toBe("main");
    const over = seedConfig({ seed: { agentsUrl: "http://a:1" } }, { CYBERDECK_SEED_AGENTS_URL: "http://b:2", CYBERDECK_SEED_IDENTITY: "alt" } as NodeJS.ProcessEnv);
    expect(over).toMatchObject({ agentsUrl: "http://b:2", identity: "alt" });
  });
  test("the pairing key reaches the call routes but not setup", () => {
    expect(caseworkAllows("GET", "/api/voice/config")).toBe(true);
    expect(caseworkAllows("POST", "/api/voice/livekit")).toBe(true);
    expect(caseworkAllows("GET", "/api/voice/status")).toBe(true);
    expect(caseworkAllows("GET", "/api/voice/transcript")).toBe(true);
    expect(caseworkAllows("POST", "/api/voice/session/reset")).toBe(true);
    expect(caseworkAllows("POST", "/api/voice/setup")).toBe(false);
    expect(caseworkAllows("POST", "/api/voice/dogfood")).toBe(false);
    expect(caseworkAllows("POST", "/api/voice/config")).toBe(false);
  });
});

describe("unconfigured node", () => {
  test("config says none with a reason and livekit is 503", async () => {
    const cfg = await (await req(b, KEY, "/api/voice/config")).json();
    expect(cfg.configured).toBe(false);
    expect(cfg.provider).toBe("none");
    expect(cfg.reason).toContain("no voice pipeline");
    const r = await req(b, KEY, "/api/voice/livekit", { method: "POST" });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("voice not configured");
    const state = await (await req(b, KEY, "/api/state")).json();
    expect(state.voice).toMatchObject({ configured: false, provider: "none" });
  });
  test("status shows the identity even when calls are off", async () => {
    const s = await (await req(b, TEST_TOKEN, "/api/voice/status")).json();
    expect(s.identity).toMatchObject({ name: "main", available: true, principal: EXPECTED_PRINCIPAL });
    expect(s.health).toMatchObject({ ok: true, voice: false });
    expect(s.agent).toBeUndefined();
  });
  test("setup still registers the MCP server and creates a Cyberdeck agent when there is no companion", async () => {
    const r = await req(b, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: JSON.stringify({ name: "Cyberdeck" }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.agent.origin).toBe("created");
    expect(j.agent.name).toBe("Cyberdeck");
    expect(j.sessionId).toMatch(/^session-/);
    expect(j.mcp).toMatchObject({ name: "cyberdeck", url: "http://127.0.0.1:4777/api/mcp", state: "ok", tools: 2 });
    const created = muted.agents.get(j.agent.id)!;
    expect(created.mcpServers).toEqual(["cyberdeck"]);
    expect(created.modelProvider).toBe("OpenAI");
    expect(created.model).toBe("gpt-6-sol");
    expect(String(created.systemPrompt)).toContain("Eric's fleet companion");
    expect(new TextDecoder().decode(muted.secrets.get("cyberdeck-mcp-token"))).toBe(`Bearer ${TEST_TOKEN}`);
    expect(muted.mcp.get("cyberdeck")).toEqual({ url: "http://127.0.0.1:4777/api/mcp", transport: "http", secretRefs: { Authorization: "cyberdeck-mcp-token" } });
    // Still no calls: the server has no voice pipeline.
    expect((await (await req(b, KEY, "/api/voice/config")).json()).configured).toBe(false);
  });
});

describe("configured node", () => {
  test("setup needs the node token; with it the companion is adopted and granted the cyberdeck MCP server", async () => {
    expect((await req(a, KEY, "/api/voice/setup", { method: "POST" })).status).toBe(403);
    expect((await (await req(a, KEY, "/api/voice/config")).json()).reason).toContain("no agent set up");

    const r = await req(a, TEST_TOKEN, "/api/voice/setup", { method: "POST" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.agent).toEqual({ id: COMPANION_ID, name: "Casework Companion", origin: "adopted" });
    expect(j.warnings).toEqual([]);
    expect(voiced.agents.get(COMPANION_ID)!.mcpServers).toEqual(["casework_host", "cyberdeck"]);
    // A fresh session, not the companion's own.
    expect(j.sessionId).not.toBe("old-companion-session");
    expect(voiced.sessions.get(j.sessionId)).toEqual({ agentId: COMPANION_ID });

    const persisted = JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8"));
    expect(persisted).toMatchObject({ agentId: COMPANION_ID, sessionId: j.sessionId });
    expect(typeof persisted.mcpRegisteredAt).toBe("number");
    expect(voiced.actions.map((x) => x._)).toEqual(["SetSecret", "SetMcpServer", "GetAgent", "UpdateAgent", "CreateSession"]);
  });
  test("config says livekit; state and welcome carry voice.configured", async () => {
    const cfg = await (await req(a, KEY, "/api/voice/config")).json();
    expect(cfg).toMatchObject({ configured: true, provider: "livekit", agentId: COMPANION_ID });
    expect(cfg.sessionId).toMatch(/^session-/);
    const state = await (await req(a, KEY, "/api/state")).json();
    expect(state.voice).toMatchObject({ configured: true, provider: "livekit" });
    const w = await welcome(a);
    expect(w.type).toBe("welcome");
    expect(w.voice).toMatchObject({ configured: true, provider: "livekit" });
    const s = await (await req(a, KEY, "/api/voice/status")).json();
    expect(s.profile).toEqual({ voice: "v", speed: 1, runtimeToken: true, source: join(a.home, "companion.json") });
  });
  test("livekit with the pairing key returns url/token/room and records the call", async () => {
    const before = voiced.actions.length;
    const r = await req(a, KEY, "/api/voice/livekit", { method: "POST" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.url).toBe("wss://livekit.example/");
    expect(j.secureUrl).toBeUndefined(); // already TLS: nothing to rewrite
    expect(j.token).toMatch(/^jwt-session-/);
    expect(j.room).toMatch(/^room-session-/);
    expect(j.identity).toBe("caller");
    expect(j.expiresAt).toBeGreaterThan(Date.now());
    expect(voiced.actions.slice(before).map((x) => x._)).toEqual(["GetSession", "CreateVoiceSession"]);
    expect(typeof JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).lastCallAt).toBe("number");
    expect((await (await req(a, TEST_TOKEN, "/api/voice/status")).json()).lastCallAt).toBeGreaterThan(0);
    // The companion's voice profile went to the runtime route for exactly this room, with the internal token.
    expect(j.profile).toEqual({ voice: "v", speed: 1, applied: true });
    const rt = voiced.runtimeCalls[voiced.runtimeCalls.length - 1]!;
    expect(rt.auth).toBe(`Bearer ${RUNTIME_TOKEN}`);
    expect(rt.body).toEqual({ room: j.room, profile: { voice: "v", speed: 1 } });
  });
  test("a rejected runtime token leaves the call working and reports the profile as not applied", async () => {
    expect((await req(c, TEST_TOKEN, "/api/voice/setup", { method: "POST" })).status).toBe(200);
    const s = await (await req(c, KEY, "/api/voice/status")).json();
    expect(s.profile).toMatchObject({ voice: "v-other", speed: 1.2, runtimeToken: true });
    const calls = voiced.runtimeCalls.length;
    const r = await req(c, KEY, "/api/voice/livekit", { method: "POST" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.room).toMatch(/^room-session-/);
    expect(j.profile).toEqual({ voice: "v-other", speed: 1.2, applied: false, error: "voice runtime HTTP 401" });
    expect(voiced.runtimeCalls.length).toBe(calls + 1);
    expect(voiced.runtimeCalls[calls]!.auth).toBe("Bearer stale-token");
    // A malformed profile is skipped before it reaches the server; no token on disk is reported too.
    writeFileSync(join(c.home, "companion.json"), JSON.stringify({ agentId: COMPANION_ID, profile: { voice: "not a voice id!", speed: 1 } }));
    const bad = await (await req(c, KEY, "/api/voice/livekit", { method: "POST" })).json();
    expect(bad.profile).toBeUndefined();
    expect(voiced.runtimeCalls.length).toBe(calls + 1);
    expect((await (await req(c, KEY, "/api/voice/status")).json()).profile).toBeUndefined();
    writeFileSync(join(c.home, "companion.json"), JSON.stringify({ agentId: COMPANION_ID, profile: { voice: "v-other", speed: 1.2 } }));
    writeFileSync(join(c.home, "runtime.json"), JSON.stringify({}));
    const none = await (await req(c, KEY, "/api/voice/livekit", { method: "POST" })).json();
    expect(none.profile).toMatchObject({ voice: "v-other", applied: false });
    expect(none.profile.error).toContain("no voice runtime token");
    expect(voiced.runtimeCalls.length).toBe(calls + 1);
  });
  test("transcript returns user and assistant text only", async () => {
    const t = await (await req(a, KEY, "/api/voice/transcript?limit=5")).json();
    expect(t.supported).toBe(true);
    expect(t.messages.map((m: any) => [m.role, m.text])).toEqual([["user", "Hi"], ["assistant", "Hello from the fleet."]]);
  });
  test("dogfood creates the daily check-in trigger once and status reports it", async () => {
    expect((await req(a, KEY, "/api/voice/dogfood", { method: "POST" })).status).toBe(403);
    expect((await (await req(a, TEST_TOKEN, "/api/voice/status")).json()).dogfood).toBeUndefined();

    const r1 = await req(a, TEST_TOKEN, "/api/voice/dogfood", { method: "POST", body: JSON.stringify({}) });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1).toMatchObject({ created: true, name: DOGFOOD_TRIGGER_NAME, enabled: true, nextSummary: "daily at 07:00 Europe/Madrid" });
    const stored = voiced.triggers.get(COMPANION_ID)!;
    expect(stored.length).toBe(1);
    expect(stored[0].source).toEqual({ type: "schedule", schedule: { kind: "weekly", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timeOfDay: "07:00", timezone: "Europe/Madrid" } });
    expect(stored[0].prompt).toBe(DOGFOOD_PROMPT);
    expect(stored[0].continuation).toEqual({ kind: "newThread" });
    expect(JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).dogfoodTriggerId).toBe(j1.triggerId);

    // Idempotent: a second call (even with other options) reuses the trigger by name.
    const j2 = await (await req(a, TEST_TOKEN, "/api/voice/dogfood", { method: "POST", body: JSON.stringify({ timezone: "UTC", timeOfDay: "08:30" }) })).json();
    expect(j2.created).toBe(false);
    expect(j2.triggerId).toBe(j1.triggerId);
    expect(voiced.triggers.get(COMPANION_ID)!.length).toBe(1);
    expect(voiced.actions.filter((x) => x._ === "CreateAgentTrigger").length).toBe(1);

    const s = await (await req(a, TEST_TOKEN, "/api/voice/status")).json();
    expect(s.dogfood).toMatchObject({ triggerId: j1.triggerId, name: DOGFOOD_TRIGGER_NAME, enabled: true, nextSummary: "daily at 07:00 Europe/Madrid" });
    expect((await req(a, TEST_TOKEN, "/api/voice/dogfood", { method: "POST", body: JSON.stringify({ timeOfDay: "7am" }) })).status).toBe(502);
  });
  test("calls follow a continued session and reset mints a new one", async () => {
    const current = JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).sessionId as string;
    voiced.sessions.set("session-next", { agentId: COMPANION_ID });
    voiced.sessions.get(current)!.continuedTo = "session-next";
    const call = await (await req(a, KEY, "/api/voice/livekit", { method: "POST" })).json();
    expect(call.room).toBe("room-session-next");
    expect(call.sessionId).toBe("session-next");
    const reset = await (await req(a, KEY, "/api/voice/session/reset", { method: "POST" })).json();
    expect(reset.previous).toBe("session-next");
    expect(reset.sessionId).not.toBe("session-next");
    expect(reset.room).toBeUndefined();
    expect(JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).sessionId).toBe(reset.sessionId);
  });
  test("reset with a live room tells the voice runtime to move the room to the new session", async () => {
    const calls = voiced.runtimeCalls.length;
    const r = await (await req(a, KEY, "/api/voice/session/reset", { method: "POST", body: JSON.stringify({ room: "room-live-1" }) })).json();
    expect(r.room).toEqual({ name: "room-live-1", switched: true });
    expect(voiced.runtimeCalls.length).toBe(calls + 1);
    expect(voiced.runtimeCalls[calls]!).toEqual({ auth: `Bearer ${RUNTIME_TOKEN}`, body: { room: "room-live-1", sessionId: r.sessionId } });
    // Node c's token is rejected: the session still resets, the room keeps the old one and the response says so.
    writeFileSync(join(c.home, "runtime.json"), JSON.stringify({ SEED_AGENTS_VOICE_INTERNAL_TOKEN: "stale-token" }));
    const bad = await (await req(c, KEY, "/api/voice/session/reset", { method: "POST", body: JSON.stringify({ room: "room-live-2" }) })).json();
    expect(bad.sessionId).toMatch(/^session-/);
    expect(bad.room).toEqual({ name: "room-live-2", switched: false, error: "voice runtime HTTP 401" });
  });
  test("setup --new creates a fresh Cyberdeck agent instead of keeping the adopted one", async () => {
    const j = await (await req(a, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: JSON.stringify({ new: true }) })).json();
    expect(j.agent.origin).toBe("created");
    expect(j.agent.id).not.toBe(COMPANION_ID);
    expect(existsSync(join(a.home, "seed.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).agentId).toBe(j.agent.id);
  });
  test("a server error comes back as 502 with the server's message", async () => {
    const stateFile = join(a.home, "seed.json");
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    voiced.sessions.delete(st.sessionId);
    voiced.agents.delete(st.agentId); // the session recreate now fails on the server
    const r = await req(a, KEY, "/api/voice/livekit", { method: "POST" });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain("Agent not found");
  });
});
