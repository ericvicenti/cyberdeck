// Voice bridge: Cyberdeck signs Seed agents actions as a vault identity and mints LiveKit rooms for
// the Casework app. A fake agents server verifies the signed CBOR envelopes and answers the actions
// setup and calls need.
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as blobs from "@seed-hypermedia/client/blobs";
import * as cbor from "@seed-hypermedia/client/cbor";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import { seedConfig, seedProfileNames } from "../src/daemon/config";
import { caseworkAllows } from "../src/daemon/api/casework";
import { createVoiceRelay, secureCallUrl, agoText, hubUnreachable, HUB_DOWN_TTL_MS } from "../src/daemon/api/voice";
import { parseBackend } from "../src/daemon/tailscale";
import { Tailscale } from "../src/daemon/tailscale";
import { SeedBridge, DOGFOOD_PROMPT, DOGFOOD_TRIGGER_NAME, checkinNoteStatus, fleetPrompt, promptText, samePrompt, RUNWATCH_TRIGGER_NAME, RUNWATCH_PROMPT, DIGEST_TRIGGER_NAME, DIGEST_SIGNER_LABEL, digestPrompt } from "../src/daemon/seed";
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
  const sessions = new Map<string, { agentId: string; title?: string; continuedTo?: string }>();
  const queryEvents = new Map<string, any[]>();
  const secrets = new Map<string, Uint8Array>();
  const mcp = new Map<string, Record<string, any>>();
  const triggers = new Map<string, Record<string, any>[]>();
  const identities: Record<string, any>[] = [];
  const memory = new Map<string, Map<string, string>>();
  const providers = new Map<string, Record<string, any>>();
  const logins = new Map<string, "pending" | "completed" | "failed">();
  const runtimeCalls: { auth: string | null; body: any }[] = [];
  const sockets = new Set<any>();
  let heldMessage: { entered: () => void; wait: Promise<void> } | null = null;
  let n = 0;
  const err = (status: number, message: string) => new Response(cbor.encode({ _: "Error", message }) as unknown as BodyInit, { status, headers: { "content-type": "application/cbor" } });
  const ok = (body: unknown) => new Response(cbor.encode(body) as unknown as BodyInit, { headers: { "content-type": "application/cbor" } });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/agents/ws") return server.upgrade(req, { data: { keys: new Set<string>() } }) ? undefined : new Response("upgrade failed", { status: 400 });
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
        case "UpdateAgent": if (!agents.has(a.agentId)) return err(404, "Agent not found"); if (Array.isArray(a.definition?.signingKeys) && a.definition.signingKeys.some((k: string) => !identities.some((i) => i.name === k))) return err(400, "Signing key not found"); agents.set(a.agentId, a.definition); return ok({ _: "UpdateAgentResponse", agent: { id: a.agentId, definition: a.definition } });
        case "CreateAgent": { if (a.definition?.modelProvider === "Missing") return err(404, "Model provider not found"); const id = `agent-${++n}`; agents.set(id, a.definition); return ok({ _: "CreateAgentResponse", agentId: id }); }
        case "CreateSession": { if (!agents.has(a.agentId)) return err(404, "Agent not found"); const id = `session-${++n}`; sessions.set(id, { agentId: a.agentId, title: a.title }); if (a.agentId !== COMPANION_ID) queryEvents.set(id, []); return ok({ _: "CreateSessionResponse", sessionId: id }); }
        case "ListSessions": return ok({ _: "ListSessionsResponse", sessions: [...sessions].filter(([, s]) => s.agentId === a.agentId).map(([id, s]) => ({ id, ...s, status: "idle", createdAt: 1, updatedAt: 2 })) });
        case "MessageSession": {
          if (!sessions.has(a.sessionId)) return err(404, "No session");
          const hold = heldMessage;
          hold?.entered();
          if (hold) await hold.wait;
          const rows = queryEvents.get(a.sessionId) ?? [];
          const text = a.content.find((p: any) => p.type === "text")?.text;
          for (const [role, content] of [["user", text], ["assistant", `Seed reply: ${text}`]]) {
            const seq = rows.length + 1;
            rows.push({ id: `${a.sessionId}-${seq}`, sessionId: a.sessionId, seq, createdAt: seq, event: { type: "message", role, content } });
          }
          queryEvents.set(a.sessionId, rows);
          for (const ws of sockets) {
            if (!ws.data.keys.has(`sessions/${a.sessionId}`)) continue;
            for (const row of rows.slice(-2)) ws.send(JSON.stringify({ _: "append", key: `sessions/${a.sessionId}`, event: { ...row, id: `${a.sessionId}-${row.seq}`, sessionId: a.sessionId, createdAt: row.seq } }));
          }
          return ok({ _: "MessageSessionResponse" });
        }
        case "StopSession": return ok({ _: "StopSessionResponse" });
        case "UpdateSession": { const s = sessions.get(a.sessionId); if (s) s.title = a.title; return ok({ _: "UpdateSessionResponse" }); }
        case "DeleteSession": sessions.delete(a.sessionId); return ok({ _: "DeleteSessionResponse" });
        case "GetSession": {
          const s = sessions.get(a.sessionId);
          if (!s) return err(404, "Session not found");
          const events = [
            { id: "e1", sessionId: a.sessionId, seq: 1, createdAt: 1, event: { type: "message", role: "user", content: "Hi" } },
            { id: "e2", sessionId: a.sessionId, seq: 2, createdAt: 2, event: { type: "message", role: "tool", content: "{}", toolCallId: "t" } },
            { id: "e3", sessionId: a.sessionId, seq: 3, createdAt: 3, event: { type: "message", role: "assistant", content: "Hello from the fleet." } },
          ];
          return ok({ _: "GetSessionResponse", session: { id: a.sessionId, agentId: s.agentId, status: "idle", ...(s.continuedTo ? { continuedTo: { continuationId: "c", sessionId: s.continuedTo, reason: "context", createdAt: 1 } } : {}) }, events: (queryEvents.get(a.sessionId) ?? events).slice(-(a.limit ?? events.length)), systemPromptMarkdown: "" });
        }
        case "ListAgentTriggers": return ok({ _: "ListAgentTriggersResponse", triggers: triggers.get(a.agentId) ?? [] });
        case "ListAgentMemoryDir": {
          if (!agents.has(a.agentId)) return err(404, "Agent not found");
          const m = memory.get(a.agentId) ?? new Map<string, string>();
          const prefix = a.path ? `${String(a.path).replace(/\/$/, "")}/` : "";
          const entries = [...m].filter(([p]) => p.startsWith(prefix)).map(([p, c]) => ({ path: p, type: "file", size: c.length }));
          return ok({ _: "ListAgentMemoryDirResponse", agentId: a.agentId, path: a.path ?? "", entries, entryCount: entries.length });
        }
        case "WriteAgentMemoryFile": {
          if (!agents.has(a.agentId)) return err(404, "Agent not found");
          if (typeof a.path !== "string" || a.path.startsWith("/") || a.path.includes("..")) return err(400, "Invalid memory path");
          const m = memory.get(a.agentId) ?? new Map<string, string>();
          m.set(a.path, String(a.content));
          memory.set(a.agentId, m);
          return ok({ _: "WriteAgentMemoryFileResponse", agentId: a.agentId, entry: { path: a.path, type: "file", size: String(a.content).length } });
        }
        case "DeleteAgentMemoryFile": { const deleted = memory.get(a.agentId)?.delete(a.path) ?? false; return ok({ _: "DeleteAgentMemoryFileResponse", agentId: a.agentId, path: a.path, deleted }); }
        case "ListModelProviders": return ok({ _: "ListModelProvidersResponse", providers: [...providers.values()] });
        case "SetModelProvider": {
          const p = a.provider;
          if (typeof a.name !== "string" || !a.name) return err(400, "Provider name is required");
          if (!p?.type) return err(400, "Provider name and type are required");
          if (p.authMode === "subscription" && !p.secretRefs?.oauth) return err(400, "subscription providers need secretRefs.oauth");
          providers.set(p.name, { name: p.name, type: p.type, authMode: p.authMode ?? "api-key", authStatus: "ok" });
          return ok({ _: "SetModelProviderResponse", provider: providers.get(p.name) });
        }
        case "StartProviderOAuth": { if (a.providerType !== "openai") return err(400, "Unsupported provider type"); const id = `login-${++n}`; logins.set(id, "pending"); return ok({ _: "StartProviderOAuthResponse", loginId: id, authUrl: `https://auth.example/authorize?state=${id}`, expiresAt: Date.now() + 600_000 }); }
        case "SubmitProviderOAuthCode": { if (!logins.has(a.loginId)) return err(404, "Login not found"); logins.set(a.loginId, String(a.code).includes("code=good") ? "completed" : "failed"); return ok({ _: "SubmitProviderOAuthCodeResponse" }); }
        case "GetProviderOAuthStatus": { const st = logins.get(a.loginId); if (!st) return err(404, "Login not found"); return ok({ _: "ProviderOAuthStatusResponse", loginId: a.loginId, status: st, ...(st === "completed" ? { secretName: "oauth-openai-1" } : st === "failed" ? { error: "invalid code" } : {}) }); }
        case "CreateAgentTrigger": {
          if (!agents.has(a.agentId)) return err(404, "Agent not found");
          const sc = a.trigger?.source?.schedule;
          const src = a.trigger?.source;
          if (src?.type === "run-completed") {
            if (src.status !== undefined && !["succeeded", "failed", "canceled"].includes(src.status)) return err(400, "Trigger run status must be succeeded, failed, or canceled");
            const k = a.trigger?.continuation?.kind;
            if (!["newThread", "wake", "tool", "script"].includes(k)) return err(400, "Trigger continuation kind is unsupported: expected newThread, wake, tool, or script");
            if (k === "tool" && (typeof a.trigger.continuation.tool !== "string" || (opts.voice === false && false))) return err(400, "Trigger tool is required");
          } else if (a.trigger?.source?.type !== "schedule" || sc?.kind !== "weekly" || !Array.isArray(sc.daysOfWeek) || !sc.daysOfWeek.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) || !/^\d{2}:\d{2}$/.test(sc.timeOfDay) || typeof sc.timezone !== "string") return err(400, "Schedule is invalid");
          if (typeof a.trigger.prompt !== "string" || !a.trigger.name) return err(400, "Trigger prompt is required");
          const t = { id: `trigger-${++n}`, account: "x", agentId: a.agentId, name: a.trigger.name, enabled: a.trigger.enabled !== false, source: a.trigger.source, prompt: a.trigger.prompt, continuation: a.trigger.continuation, createdAt: Date.now(), updatedAt: Date.now() };
          triggers.set(a.agentId, [...(triggers.get(a.agentId) ?? []), t]);
          return ok({ _: "CreateAgentTriggerResponse", trigger: t });
        }
        case "ListSigningIdentities": return ok({ _: "ListSigningIdentitiesResponse", identities: [...identities] });
        case "CreateSigningIdentity": {
          const accountId = `z6Mk${(++n).toString().padStart(4, "0")}digestaccount`;
          const id = { id: `sid-${n}`, name: `hm-account-${accountId.slice(0, 16)}`, accountId, label: a.label ?? `Agent account ${accountId.slice(0, 10)}`, serverUrl: "https://hyper.example", createdAt: Date.now(), updatedAt: Date.now() };
          identities.push(id);
          return ok({ _: "CreateSigningIdentityResponse", identity: id });
        }
        case "UpdateAgentTrigger": {
          const list = [...triggers.values()].flat();
          const t = list.find((x) => x.id === a.triggerId);
          if (!t) return err(404, "Trigger not found");
          Object.assign(t, a.patch ?? {}, { updatedAt: Date.now() });
          return ok({ _: "UpdateAgentTriggerResponse", trigger: t });
        }
        case "CreateVoiceSession": {
          if (!opts.voice) return err(501, "Voice is not available on this server");
          if (!sessions.has(a.sessionId)) return err(404, "Session not found");
          return ok({ _: "CreateVoiceSessionResponse", sessionId: a.sessionId, url: "wss://livekit.example/", token: "jwt-" + a.sessionId, room: "room-" + a.sessionId, identity: "caller", expiresAt: Date.now() + 60_000 });
        }
        default: return err(400, `Unsupported action ${a._}`);
      }
    },
    websocket: {
      open(ws: any) { sockets.add(ws); ws.send(JSON.stringify({ _: "connected", connectedAt: Date.now() })); },
      async message(ws: any, message: any) {
        const env: any = cbor.decode(new Uint8Array(message));
        await blobs.nativeCryptoReady;
        if (!blobs.verify(env) || env.action._ !== "Subscribe") { ws.close(1008); return; }
        const key = env.action.key;
        ws.data.keys.add(key);
        ws.send(JSON.stringify({ _: "subscribed", key, accountId: EXPECTED_PRINCIPAL }));
        // Replay closes the fetch/subscribe race, just as Seed's real transport does.
        const sessionId = key.startsWith("sessions/") ? key.slice("sessions/".length) : null;
        for (const row of queryEvents.get(sessionId) ?? []) ws.send(JSON.stringify({ _: "append", key, event: { ...row, id: `${sessionId}-${row.seq}`, sessionId, createdAt: row.seq } }));
      },
      close(ws: any) { sockets.delete(ws); },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    actions,
    agents,
    sessions,
    secrets,
    mcp,
    triggers,
    memory,
    identities,
    providers,
    runtimeCalls,
    holdNextMessage() {
      let entered!: () => void;
      let release!: () => void;
      const received = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      heldMessage = { entered, wait };
      return { received, release: () => { heldMessage = null; release(); } };
    },
    stop: () => void server.stop(true),
  };
}

type Node = { base: string; wsBase: string; home: string; db: Database; stop: () => void; cleanup: () => void };
function startNode(agentsUrl: string, prefix: string, companion?: object, runtimeToken?: string, extra: Partial<import("../src/daemon/config").CyberdeckConfig> = {}, tailscale: Tailscale = new Tailscale(async () => null)): Node {
  const { dir, cleanup } = tmpHomeDir(prefix);
  const companionFile = join(dir, "companion.json");
  if (companion) writeFileSync(companionFile, JSON.stringify(companion));
  // Always point at a file inside the temp home so the test never reads this Mac's real runtime.json.
  const runtimeFile = join(dir, "runtime.json");
  if (runtimeToken) writeFileSync(runtimeFile, JSON.stringify({ SEED_AGENTS_VOICE_INTERNAL_TOKEN: runtimeToken, SEED_AGENTS_HTTP_PORT: "3053" }));
  const db = new Database(":memory:");
  initSchema(db);
  const s = createServer(db, testConfig({ port: 4777, ...extra, seed: { agentsUrl, ...(extra.seed ?? {}) } }), TEST_TOKEN, "stw-test", { caseworkKey: KEY, caseworkExperiencesDir: FIXTURES, persistOwner: false, cloudSync: false, tailscale, seed: { home: dir, companionFile, runtimeFile } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: s.fetch, websocket: s.websocket });
  return { base: `http://127.0.0.1:${server.port}`, wsBase: `ws://127.0.0.1:${server.port}`, home: dir, db, stop: () => { s.sessions.close(); void server.stop(true); }, cleanup };
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
let a: Node, b: Node, c: Node, d: Node, e: Node, f: Node;
const pair = (from: Node, id: string, name: string, to: Node) => from.db.query("INSERT INTO nodes (id,name,url,token,added_at) VALUES (?,?,?,?,?)").run(id, name, to.base, TEST_TOKEN, Date.now());
beforeAll(() => {
  voiced = fakeAgents({ voice: true });
  muted = fakeAgents({ voice: false });
  a = startNode(voiced.url, "voice-a", { agentId: COMPANION_ID, sessionId: "old-companion-session", profile: { voice: "v", speed: 1 } }, RUNTIME_TOKEN);
  b = startNode(muted.url, "voice-b");
  // Same companion and profile, but a runtime token the agents server rejects.
  c = startNode(voiced.url, "voice-c", { agentId: COMPANION_ID, profile: { voice: "v-other", speed: 1.2 } }, "stale-token");
  // The voice relay: f is a configured node (set up in its describe); d has no bridge and is paired with
  // a dead url, b and f (f answers); e only with b (nobody answers).
  f = startNode(voiced.url, "voice-f", { agentId: COMPANION_ID, profile: { voice: "v", speed: 1 } }, RUNTIME_TOKEN);
  d = startNode(muted.url, "voice-d");
  pair(d, "n-dead", "Dead", { base: "http://127.0.0.1:9" } as Node);
  pair(d, "n-b", "Muted", b);
  pair(d, "n-voice", "Yacht", f);
  e = startNode(muted.url, "voice-e");
  pair(e, "n-b", "Muted", b);
});
afterAll(() => { for (const n of [a, b, c, d, e, f]) { n.stop(); n.cleanup(); } voiced.stop(); muted.stop(); });

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
    expect(seedConfig({}, env)).toEqual({ agentsUrl: "http://127.0.0.1:3053", identity: "main", modelProvider: "OpenAI", model: "gpt-6-sol", reasoningLevel: "medium", keyFile: join(process.env.HOME!, ".cyberdeck", "seed-key"), memoryDirs: [join(process.env.HOME!, ".claude", "projects", "-Users-ericvicenti-Code", "memory")] });
    expect(seedConfig({ roots: ["/srv/work"], seed: { reasoningLevel: "", memoryDirs: ["/x"] } }, env)).toMatchObject({ reasoningLevel: "", memoryDirs: ["/x"] });
    expect(seedConfig({ roots: ["/srv/work"] }, env).memoryDirs).toEqual([join(process.env.HOME!, ".claude", "projects", "-srv-work", "memory")]);
    expect(seedConfig({}, { CYBERDECK_SEED_MODEL: "gpt-6-astra", CYBERDECK_SEED_REASONING: "high" } as NodeJS.ProcessEnv)).toMatchObject({ model: "gpt-6-astra", reasoningLevel: "high" });
    expect(seedConfig({ seed: { agentsUrl: "http://a:1/", identity: "" } }, env).agentsUrl).toBe("http://a:1");
    expect(seedConfig({ seed: { agentsUrl: "http://a:1/", identity: "" } }, env).identity).toBe("main");
    const over = seedConfig({ seed: { agentsUrl: "http://a:1" } }, { CYBERDECK_SEED_AGENTS_URL: "http://b:2", CYBERDECK_SEED_IDENTITY: "alt" } as NodeJS.ProcessEnv);
    expect(over).toMatchObject({ agentsUrl: "http://b:2", identity: "alt" });
  });
  test("profiles: a seed.profiles entry layers over the seed block, never takes the env, and keeps its own agent pointers", () => {
    const cfg = { seed: { model: "gpt-6-sol", agentId: "default-agent", sessionId: "default-session", profiles: { prod: { agentsUrl: "https://agent.hm/", mcpUrl: " https://yacht.example.ts.net:8443/api/mcp " }, "Bad Name": { agentsUrl: "http://x" } } } };
    const env = { CYBERDECK_SEED_AGENTS_URL: "http://env:2", CYBERDECK_SEED_MODEL: "gpt-6-astra" } as NodeJS.ProcessEnv;
    expect(seedProfileNames(cfg)).toEqual(["prod"]);
    const prod = seedConfig(cfg, env, "prod");
    expect(prod).toMatchObject({ agentsUrl: "https://agent.hm", mcpUrl: "https://yacht.example.ts.net:8443/api/mcp", model: "gpt-6-sol", identity: "main" });
    expect(prod.agentId).toBeUndefined();
    expect(prod.sessionId).toBeUndefined();
    expect((prod as any).profiles).toBeUndefined();
    // The default bridge: env wins, and the profiles block is not part of its settings.
    const def = seedConfig(cfg, env);
    expect(def).toMatchObject({ agentsUrl: "http://env:2", model: "gpt-6-astra", agentId: "default-agent" });
    expect((def as any).profiles).toBeUndefined();
    expect(() => seedConfig(cfg, env, "nope")).toThrow(/unknown seed profile "nope".*prod/);
    expect(() => seedConfig(cfg, env, "Bad Name")).toThrow(/unknown seed profile/);
  });
  test("profiles: setup refuses a remote agents server without a public MCP url before touching the network", async () => {
    const fetchCalls: string[] = [];
    const cfg = seedConfig({ seed: { profiles: { prod: { agentsUrl: "https://agent.hm" } } } }, {} as NodeJS.ProcessEnv, "prod");
    const bridge = new SeedBridge({ config: cfg, profile: "prod", port: 4777, token: TEST_TOKEN, home: mkdtempSync(join(tmpdir(), "cd-seed-")), fetch: (async (input: any) => { fetchCalls.push(String(input)); return new Response("{}"); }) as typeof fetch });
    expect(bridge.stateFile.endsWith("/seed-prod.json")).toBe(true);
    expect(bridge.mcpUrl).toBe("http://127.0.0.1:4777/api/mcp");
    expect(bridge.agentsLocal).toBe(false);
    await expect(bridge.setup()).rejects.toThrow(/seed profile "prod".*agent\.hm.*mcpUrl.*cyberdeck serve mcp/);
    expect(fetchCalls.filter((u) => u.includes("/api/message"))).toEqual([]);
    // With the public route in config the url is what setup registers; a loopback server never needs it.
    const withUrl = new SeedBridge({ config: { ...cfg, mcpUrl: "https://yacht.example.ts.net:8443/api/mcp" }, profile: "prod", port: 4777, token: TEST_TOKEN, home: mkdtempSync(join(tmpdir(), "cd-seed-")) });
    expect(withUrl.mcpUrl).toBe("https://yacht.example.ts.net:8443/api/mcp");
    expect(new SeedBridge({ config: { ...cfg, agentsUrl: "http://localhost:3053" }, profile: "prod", port: 4777, token: TEST_TOKEN, home: mkdtempSync(join(tmpdir(), "cd-seed-")) }).agentsLocal).toBe(true);
  });
  test("the pairing key reaches the call routes but not setup", () => {
    expect(caseworkAllows("GET", "/api/voice/config")).toBe(true);
    expect(caseworkAllows("POST", "/api/voice/livekit")).toBe(true);
    expect(caseworkAllows("GET", "/api/voice/status")).toBe(true);
    expect(caseworkAllows("GET", "/api/voice/transcript")).toBe(true);
    expect(caseworkAllows("GET", "/api/voice/control")).toBe(true);
    expect(caseworkAllows("POST", "/api/voice/control")).toBe(false);
    expect(caseworkAllows("POST", "/api/voice/session/reset")).toBe(true);
    expect(caseworkAllows("POST", "/api/voice/setup")).toBe(false);
    expect(caseworkAllows("POST", "/api/voice/dogfood")).toBe(false);
    expect(caseworkAllows("POST", "/api/voice/digest")).toBe(false);
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
    expect(s.identity).toMatchObject({ name: "main", source: "env", available: true, principal: EXPECTED_PRINCIPAL });
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
    expect(voiced.sessions.get(j.sessionId)).toEqual({ agentId: COMPANION_ID, title: "Cyberdeck voice" });

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
  test("after a restart the bridge looks the agent's name up once instead of showing only its id", async () => {
    const restarted = new SeedBridge({ config: seedConfig({ seed: { agentsUrl: voiced.url } }), port: 4777, token: TEST_TOKEN, home: a.home });
    const before = voiced.actions.filter((x) => x._ === "GetAgent").length;
    expect((await restarted.status()).agent).toEqual({ id: COMPANION_ID, name: "Casework Companion" });
    expect((await restarted.status()).agent?.name).toBe("Casework Companion");
    expect(voiced.actions.filter((x) => x._ === "GetAgent").length).toBe(before + 1);
  });
  test("a changed MCP tool list re-registers the server once; an unchanged one does nothing", async () => {
    const bridge = new SeedBridge({ config: seedConfig({ seed: { agentsUrl: voiced.url } }), port: 4777, token: TEST_TOKEN, home: a.home });
    const sets = () => voiced.actions.filter((x) => x._ === "SetMcpServer").length;
    const before = sets();
    expect(await bridge.refreshMcp(["status", "todo_add"])).toBe("refreshed");
    expect(await bridge.refreshMcp(["todo_add", "status"])).toBe("unchanged");
    expect(sets()).toBe(before + 1);
    expect(JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).mcpTools).toBe("status,todo_add");
    expect(await bridge.refreshMcp(["status", "todo_add", "todo_done"])).toBe("refreshed");
    expect(sets()).toBe(before + 2);
    const fresh = new SeedBridge({ config: seedConfig({ seed: { agentsUrl: voiced.url } }), port: 4777, token: TEST_TOKEN, home: mkdtempSync(join(tmpdir(), "cd-seed-")) });
    expect(await fresh.refreshMcp(["status"])).toBe("skipped");
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
  test("control: the first poll is a baseline, listen notices arrive once, bad since is a 400", async () => {
    const base = await (await req(a, KEY, "/api/voice/control")).json();
    expect(base).toEqual({ now: expect.any(Number), controls: [] });
    expect((await req(a, KEY, "/api/voice/control?since=soon")).status).toBe(400);
    // What the `listen` MCP tool does on the hub: a control notice with a transcript line.
    const bridge = new SeedBridge({ config: seedConfig({ seed: { agentsUrl: voiced.url } }), port: 4777, token: TEST_TOKEN, home: mkdtempSync(join(tmpdir(), "cd-seed-")) });
    const n = bridge.control("mute");
    expect(n).toMatchObject({ text: "Microphone muted at your request; unmute when you want me back.", control: { action: "mute" } });
    expect(bridge.controls(base.now - 1).map((x) => x.control)).toEqual([{ action: "mute" }]);
    expect(bridge.controls(n.at)).toEqual([]);
    expect(bridge.controls(0, n.at - 1)).toEqual([]);
    expect(bridge.notices(5).at(-1)?.control).toEqual({ action: "mute" });
  });
  test("prompt reads a persona the server stored as blocks and does not re-apply it", async () => {
    const stateFile = join(a.home, "seed.json");
    const agentId = JSON.parse(readFileSync(stateFile, "utf8")).agentId as string;
    const definition = voiced.agents.get(agentId)!;
    const before = definition.systemPrompt;
    const text = fleetPrompt(definition.name ?? "Cyberdeck");
    definition.systemPrompt = { type: "seed-prompt-blocks", blocks: text.split("\n").map((t, i) => ({ block: { type: "Paragraph", id: `p${i}`, text: t } })) };
    try {
      const r = await (await req(a, TEST_TOKEN, "/api/voice/prompt", { method: "POST" })).json();
      expect(r.changed).toBe(false);
      expect(r.applied).toBe(false);
      expect(r.current).toBe(text.split("\n").filter(Boolean).join("\n"));
      expect(r.current).toContain("wait for a yes");
      expect(definition.systemPrompt).not.toBe(text); // nothing was written
    } finally { definition.systemPrompt = before; }
  });

  test("samePrompt sees through the agents server's prompt blocks", () => {
    const blocks = { type: "seed-prompt-blocks", blocks: [{ block: { type: "Paragraph", id: "x", text: "Call cyberdeckfleetstatus, then  note." } }] };
    expect(promptText(blocks)).toBe("Call cyberdeckfleetstatus, then  note.");
    expect(promptText("plain")).toBe("plain");
    expect(promptText(undefined)).toBe("");
    expect(samePrompt(blocks, "Call cyberdeck__fleet_status, then note.")).toBe(true);
    expect(samePrompt(blocks, "Call cyberdeck__fleet_status, then todo.")).toBe(false);
    expect(samePrompt(undefined, DOGFOOD_PROMPT)).toBe(false);
  });
  test("checkinNoteStatus reads the inbox for the firing's day in the trigger's zone", () => {
    const inbox = "# Inbox\n\n- 2026-10-22 (clipper) fleet check-in: 6/9 online\n- 2026-10-21 (yacht) fleet check-in: 6/9 up\n- 2026-10-23 (yacht) something else\n";
    // 2026-10-23 07:00 Europe/Madrid (05:00Z): fired, no line that day.
    const fired = Date.UTC(2026, 9, 23, 5, 0, 4);
    expect(checkinNoteStatus(inbox, fired, "Europe/Madrid")).toEqual({ lastNoteDate: "2026-10-22", missedNote: true });
    expect(checkinNoteStatus(inbox, Date.UTC(2026, 9, 22, 5, 0, 0), "Europe/Madrid")).toEqual({ lastNoteDate: "2026-10-22", missedNote: false });
    // The firing's day is the trigger zone's: 22:30Z on the 22nd is already the 23rd in Madrid (no line yet), still the 22nd in UTC.
    expect(checkinNoteStatus(inbox, Date.UTC(2026, 9, 22, 22, 30, 0), "Europe/Madrid")).toEqual({ lastNoteDate: "2026-10-22", missedNote: true });
    expect(checkinNoteStatus(inbox, Date.UTC(2026, 9, 22, 22, 30, 0), "UTC")).toEqual({ lastNoteDate: "2026-10-22", missedNote: false });
    expect(checkinNoteStatus(inbox, undefined)).toEqual({ lastNoteDate: "2026-10-22" });
    expect(checkinNoteStatus(null, fired)).toEqual({ missedNote: true });
    expect(checkinNoteStatus("", undefined)).toEqual({});
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

    // A trigger made by an older build (stale prompt) gets the current wording; the schedule stays.
    stored[0].prompt = "Daily fleet check-in. Old wording that let the agent skip the note.";
    const j3 = await (await req(a, TEST_TOKEN, "/api/voice/dogfood", { method: "POST", body: JSON.stringify({}) })).json();
    expect(j3).toMatchObject({ created: false, updated: true, triggerId: j1.triggerId, nextSummary: "daily at 07:00 Europe/Madrid" });
    expect(stored[0].prompt).toBe(DOGFOOD_PROMPT);
    const patches = voiced.actions.filter((x) => x._ === "UpdateAgentTrigger");
    expect(patches.length).toBe(1);
    expect(patches[0]).toMatchObject({ triggerId: j1.triggerId, patch: { prompt: DOGFOOD_PROMPT } });
    expect((await (await req(a, TEST_TOKEN, "/api/voice/dogfood", { method: "POST", body: JSON.stringify({}) })).json()).updated).toBe(false);
    expect(voiced.actions.filter((x) => x._ === "UpdateAgentTrigger").length).toBe(1);
  });

  test("digest: a signing identity, its grant on the agent and the Monday trigger that publishes the fleet digest", async () => {
    expect((await req(a, KEY, "/api/voice/digest", { method: "POST" })).status).toBe(403);
    expect((await (await req(a, TEST_TOKEN, "/api/voice/status")).json()).digest).toBeUndefined();
    expect(voiced.identities.length).toBe(0);

    const r1 = await req(a, TEST_TOKEN, "/api/voice/digest", { method: "POST", body: JSON.stringify({}) });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1).toMatchObject({ created: true, updated: false, granted: true, identityCreated: true, name: DIGEST_TRIGGER_NAME, enabled: true, nextSummary: "Mon at 08:00 Europe/Madrid" });
    // One new identity with our label, granted to the agent through signingKeys, documents listed under its account.
    expect(voiced.identities.length).toBe(1);
    expect(voiced.identities[0].label).toBe(DIGEST_SIGNER_LABEL);
    const account = voiced.identities[0].accountId as string;
    expect(j1.account).toBe(account);
    expect(j1.signer).toBe(voiced.identities[0].name);
    expect(j1.url).toBe(`https://hyper.media/hm/${account}`);
    expect(voiced.agents.get(COMPANION_ID)!.signingKeys).toEqual([voiced.identities[0].name]);
    expect(voiced.agents.get(COMPANION_ID)!.mcpServers).toContain("casework_host"); // the rest of the definition is kept
    const stored = voiced.triggers.get(COMPANION_ID)!.filter((t) => t.name === DIGEST_TRIGGER_NAME);
    expect(stored.length).toBe(1);
    expect(stored[0].source).toEqual({ type: "schedule", schedule: { kind: "weekly", daysOfWeek: [1], timeOfDay: "08:00", timezone: "Europe/Madrid" } });
    expect(stored[0].prompt).toBe(digestPrompt(account));
    expect(stored[0].prompt).toContain(`hm://${account}/fleet-digest-<date>`);
    expect(stored[0].prompt).toContain("cyberdeck__announce");
    expect(stored[0].continuation).toEqual({ kind: "newThread" });
    const state = JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8"));
    expect(state).toMatchObject({ digestTriggerId: j1.triggerId, digestSignerName: voiced.identities[0].name, digestAccount: account });

    // Idempotent: no second identity, no second grant, no second trigger; other schedule options are ignored once it exists.
    const j2 = await (await req(a, TEST_TOKEN, "/api/voice/digest", { method: "POST", body: JSON.stringify({ dayOfWeek: 5, timeOfDay: "09:30" }) })).json();
    expect(j2).toMatchObject({ created: false, updated: false, granted: false, identityCreated: false, triggerId: j1.triggerId, account });
    expect(voiced.identities.length).toBe(1);
    expect(voiced.triggers.get(COMPANION_ID)!.filter((t) => t.name === DIGEST_TRIGGER_NAME).length).toBe(1);
    expect(voiced.actions.filter((x) => x._ === "CreateSigningIdentity").length).toBe(1);
    expect(voiced.actions.filter((x) => x._ === "UpdateAgent" && Array.isArray(x.definition?.signingKeys)).length).toBe(1);

    const s = await (await req(a, TEST_TOKEN, "/api/voice/status")).json();
    expect(s.digest).toMatchObject({ triggerId: j1.triggerId, name: DIGEST_TRIGGER_NAME, enabled: true, nextSummary: "Mon at 08:00 Europe/Madrid", account, url: `https://hyper.media/hm/${account}` });
    expect((await req(a, TEST_TOKEN, "/api/voice/digest", { method: "POST", body: JSON.stringify({ dayOfWeek: 7 }) })).status).toBe(502);

    // A stale prompt (older build) is rewritten with the same account.
    stored[0].prompt = "Weekly fleet digest. Old wording.";
    const j3 = await (await req(a, TEST_TOKEN, "/api/voice/digest", { method: "POST", body: JSON.stringify({}) })).json();
    expect(j3).toMatchObject({ created: false, updated: true, triggerId: j1.triggerId });
    expect(stored[0].prompt).toBe(digestPrompt(account));
  });

  test("runwatch: a run-completed trigger on the voice agent watches the harness agent, and announce lands in the transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "runwatch-root-"));
    writeFileSync(join(root, "AGENTS.md"), "# Fleet rules\n");
    const h = startNode(voiced.url, "voice-rw", undefined, undefined, { roots: [root] });
    try {
      expect((await req(h, KEY, "/api/voice/runwatch", { method: "POST" })).status).toBe(403);
      expect((await req(h, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: JSON.stringify({ adopt: false }) })).status).toBe(200);
      // No harness agent yet: nothing to watch.
      const early = await req(h, TEST_TOKEN, "/api/voice/runwatch", { method: "POST" });
      expect(early.status).toBe(502);
      expect((await early.json()).error).toMatch(/no harness agent/);
      const sync = await (await req(h, TEST_TOKEN, "/api/voice/harness/sync", { method: "POST", body: "{}" })).json();
      const harnessId = sync.agents.find((x: any) => x.role === "harness").agentId;
      const voiceId = (await (await req(h, TEST_TOKEN, "/api/voice/status")).json()).agent.id;
      expect(voiceId).not.toBe(harnessId);

      const r1 = await req(h, TEST_TOKEN, "/api/voice/runwatch", { method: "POST" });
      expect(r1.status).toBe(200);
      const j1 = await r1.json();
      expect(j1).toMatchObject({ created: true, updated: false, name: RUNWATCH_TRIGGER_NAME, enabled: true, watches: harnessId, headless: true, nextSummary: `after each finished run of agent ${harnessId.slice(0, 8)}` });
      const stored = voiced.triggers.get(voiceId)!;
      expect(stored.length).toBe(1);
      expect(stored[0].source).toEqual({ type: "run-completed", agentId: harnessId });
      expect(stored[0].prompt).toBe(RUNWATCH_PROMPT);
      // Headless: the server calls the announce tool with the event itself, no model turn.
      expect(stored[0].continuation).toEqual({ kind: "tool", tool: "cyberdeck__announce", input: { runId: "$event.runId", title: "$event.runTitle", status: "$event.runStatus", sessionId: "$event.sessionId", agentId: "$event.agentId" }, onFailure: "thread" });
      expect(JSON.parse(readFileSync(join(h.home, "seed.json"), "utf8")).runWatchTriggerId).toBe(j1.triggerId);
      // Idempotent; status reports it.
      const j2 = await (await req(h, TEST_TOKEN, "/api/voice/runwatch", { method: "POST" })).json();
      expect(j2).toMatchObject({ created: false, updated: false, triggerId: j1.triggerId });
      expect((await (await req(h, TEST_TOKEN, "/api/voice/status")).json()).runWatch).toMatchObject({ triggerId: j1.triggerId, name: RUNWATCH_TRIGGER_NAME, enabled: true });
      // A trigger from an older build (other prompt, other harness agent) is patched in place.
      stored[0].prompt = "old"; stored[0].source = { type: "run-completed", agentId: "agent-gone" };
      const j3 = await (await req(h, TEST_TOKEN, "/api/voice/runwatch", { method: "POST" })).json();
      expect(j3).toMatchObject({ created: false, updated: true, triggerId: j1.triggerId });
      expect(stored[0].prompt).toBe(RUNWATCH_PROMPT);
      expect(stored[0].source).toEqual({ type: "run-completed", agentId: harnessId });
      // A trigger left in thread form (the tool was not registered when it was made) is upgraded to the headless call.
      stored[0].continuation = { kind: "newThread" };
      const j4 = await (await req(h, TEST_TOKEN, "/api/voice/runwatch", { method: "POST" })).json();
      expect(j4).toMatchObject({ created: false, updated: true, headless: true, triggerId: j1.triggerId });
      expect(stored[0].continuation).toMatchObject({ kind: "tool", tool: "cyberdeck__announce", onFailure: "thread" });
      expect((await (await req(h, TEST_TOKEN, "/api/voice/runwatch", { method: "POST" })).json()).updated).toBe(false);

      // What the trigger's tool call does: the announce tool composes the line and the transcript carries it.
      const client = new Client({ name: "runwatch-test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.base}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } } }), { timeout: 10_000 });
      const tool = async (args: Record<string, unknown>) => { const r: any = await client.callTool({ name: "announce", arguments: args }); return { text: r.content[0].text as string, data: r.structuredContent as any }; };
      const done = await tool({ title: "Check the backups on enuc", status: "succeeded", runId: "run-1", sessionId: "s-1" });
      expect(done.data).toMatchObject({ announced: true, notice: { text: 'Done: "Check the backups on enuc" finished.', run: { id: "run-1", title: "Check the backups on enuc", status: "succeeded", sessionId: "s-1" } } });
      const failed = await tool({ title: "Rotate the certs", status: "failed", runId: "run-2", sessionId: "s-2", brief: true });
      expect(failed.text).toBe('Announced on the Desk: Failed: "Rotate the certs" failed.');
      // A workflow sub-step (no session) is dropped so one job announces once.
      const sub = await tool({ title: "Await source preservation result", status: "succeeded", runId: "run-3" });
      expect(sub.data).toMatchObject({ announced: false, reason: expect.stringMatching(/no session/) });
      expect((await tool({})).data.announced).toBe(false);
      const free = await tool({ text: "The nightly digest is ready." });
      expect(free.data.announced).toBe(true);
      await client.close();

      const t = await (await req(h, TEST_TOKEN, "/api/voice/transcript?limit=10")).json();
      expect(t.notices.map((x: any) => x.text)).toEqual(['Done: "Check the backups on enuc" finished.', 'Failed: "Rotate the certs" failed.', "The nightly digest is ready."]);
      expect(t.notices.every((x: any) => typeof x.id === "string" && x.at > 0)).toBe(true);
      // Notices survive a restart of the daemon (seed.json).
      expect(JSON.parse(readFileSync(join(h.home, "seed.json"), "utf8")).notices.length).toBe(3);
    } finally {
      h.stop(); h.cleanup();
    }
  });
  test("prompt compares the companion's system prompt with the fleet persona and applies it only on POST", async () => {
    expect((await req(a, KEY, "/api/voice/prompt")).status).toBe(403);
    const before = await (await req(a, TEST_TOKEN, "/api/voice/prompt")).json();
    expect(before).toMatchObject({ agentId: COMPANION_ID, name: "Casework Companion", changed: true, applied: false });
    expect(before.desired).toBe(fleetPrompt("Casework Companion"));
    expect(before.desired).toContain("wait for a yes");
    expect(voiced.agents.get(COMPANION_ID)!.systemPrompt).toBe(before.current);

    const applied = await (await req(a, TEST_TOKEN, "/api/voice/prompt", { method: "POST" })).json();
    expect(applied).toMatchObject({ changed: true, applied: true });
    expect(voiced.agents.get(COMPANION_ID)!.systemPrompt).toBe(before.desired);
    expect(voiced.agents.get(COMPANION_ID)!.mcpServers).toContain("cyberdeck");
    const again = await (await req(a, TEST_TOKEN, "/api/voice/prompt", { method: "POST" })).json();
    expect(again).toMatchObject({ changed: false, applied: false });
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


describe("voice relay", () => {
  beforeAll(async () => { expect((await req(f, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: "{}" })).status).toBe(200); });
  test("a node without a bridge answers for voice through the paired node that has one", async () => {
    const own = await (await req(f, KEY, "/api/voice/config")).json();
    const cfg = await (await req(d, KEY, "/api/voice/config")).json();
    expect(cfg).toEqual({ ...own, via: { node: "n-voice", name: "Yacht" } });
    const grant = await (await req(d, KEY, "/api/voice/livekit", { method: "POST" })).json();
    expect(grant).toMatchObject({ url: "wss://livekit.example/", via: { node: "n-voice", name: "Yacht" } });
    expect(grant.room).toMatch(/^room-/);
    expect(grant.token).toMatch(/^jwt-/);
    const t = await (await req(d, KEY, "/api/voice/transcript?limit=5")).json();
    expect(t.supported).toBe(true);
    expect(t.messages.map((m: any) => m.role)).toContain("assistant");
    expect(t.via).toEqual({ node: "n-voice", name: "Yacht" });
    const s = await (await req(d, TEST_TOKEN, "/api/voice/status")).json();
    expect(s.via).toEqual({ node: "n-voice", name: "Yacht" });
    expect(s.agent).toMatchObject({ id: own.agentId });
    expect(s.local).toMatchObject({ configured: false });
    expect(s.local.reason).toContain("no voice pipeline");
    // /api/state and the Casework welcome say configured, naming the node that answers.
    const state = await (await req(d, KEY, "/api/state")).json();
    expect(state.voice).toMatchObject({ configured: true, provider: "livekit", via: { node: "n-voice", name: "Yacht" } });
    const w = await welcome(d);
    expect(w.voice).toMatchObject({ configured: true, via: { name: "Yacht" } });
    // The relay never bounces: a peer asked directly answers for itself only.
    const direct = await (await req(d, KEY, "/api/voice/config", { headers: { "x-cyberdeck-voice-direct": "1" } })).json();
    expect(direct).toMatchObject({ configured: false, provider: "none" });
  }, 20000);

  test("a session reset through the relay mints the session on the voice node", async () => {
    const before = (await (await req(d, KEY, "/api/voice/config")).json()).sessionId;
    const r = await (await req(d, KEY, "/api/voice/session/reset", { method: "POST", body: "{}" })).json();
    expect(r.via).toEqual({ node: "n-voice", name: "Yacht" });
    expect(r.sessionId).toBeTruthy();
    expect(r.sessionId).not.toBe(before);
    expect((await (await req(f, KEY, "/api/voice/config")).json()).sessionId).toBe(r.sessionId);
  }, 20000);

  test("the companion's triggers and prompt through the relay act on the voice node's agent, never on a local one", async () => {
    // 2026-10-26: `cyberdeck seed digest` on yacht (pinned to clipper) made a second trigger, grant and signing identity on
    // yacht's own agents server while `status` showed clipper's. These node-token routes now go where status goes.
    const r = await (await req(d, TEST_TOKEN, "/api/voice/dogfood", { method: "POST", body: "{}" })).json();
    expect(r.via).toEqual({ node: "n-voice", name: "Yacht" });
    expect(r.name).toBe(DOGFOOD_TRIGGER_NAME);
    expect(r.triggerId).toBeTruthy();
    const s = await (await req(f, TEST_TOKEN, "/api/voice/status")).json();
    expect(s.dogfood?.triggerId).toBe(r.triggerId);
    const p = await (await req(d, TEST_TOKEN, "/api/voice/prompt")).json();
    expect(p.via).toEqual({ node: "n-voice", name: "Yacht" });
    expect(p.agentId).toBe(s.agent.id);
    const w = await (await req(d, TEST_TOKEN, "/api/voice/runwatch", { method: "POST" })).json();
    expect(w.via).toEqual({ node: "n-voice", name: "Yacht" });
    expect((await (await req(d, TEST_TOKEN, "/api/voice/status")).json()).local.dogfood).toBeUndefined();
  }, 20000);

  test("paired only with nodes that have no voice, the node stays unconfigured", async () => {
    const cfg = await (await req(e, KEY, "/api/voice/config")).json();
    expect(cfg).toMatchObject({ configured: false, provider: "none" });
    expect(cfg.via).toBeUndefined();
    expect((await req(e, KEY, "/api/voice/livekit", { method: "POST" })).status).toBe(503);
    const state = await (await req(e, KEY, "/api/state")).json();
    expect(state.voice).toMatchObject({ configured: false, provider: "none" });
  }, 20000);
});

describe("voice hub", () => {
  const rows = (): import("../src/daemon/api/fleet").NodeRow[] => [
    { id: "n-yacht", name: "Yacht", url: "http://127.0.0.1:9", token: "t", added_at: 1, last_seen: 1 } as any,
    { id: "n-clipper", name: "clipper", url: "http://127.0.0.1:9", token: "t", added_at: 1, last_seen: 1 } as any,
  ];
  test("a pinned hub is found by name or id without probing anyone", async () => {
    const probe = async () => { throw new Error("must not probe"); };
    const byName = createVoiceRelay(rows, probe, { hub: "Clipper", self: "yacht" });
    expect(byName.pinned).toBe("Clipper");
    expect((await byName.find())?.id).toBe("n-clipper");
    const byId = createVoiceRelay(rows, probe, { hub: "n-yacht", self: "clipper" });
    expect((await byId.find())?.name).toBe("Yacht");
    const unpaired = createVoiceRelay(rows, probe, { hub: "nowhere", self: "yacht" });
    expect(unpaired.pinned).toBe("nowhere");
    expect(await unpaired.find()).toBeNull();
  });
  test("a hub that names this node means local voice; no hub means discovery", async () => {
    const self = createVoiceRelay(rows, async () => true, { hub: " clipper ", self: "Clipper" });
    expect(self.pinned).toBeUndefined();
    const none = createVoiceRelay(rows, async () => true, { self: "yacht" });
    expect(none.pinned).toBeUndefined();
    expect((await none.find())?.id).toBe("n-yacht");
  });

  let g: Node, h: Node, i: Node;
  beforeAll(async () => {
    // g has a working bridge of its own but is pinned to the hub "Hub" (= f): everything relays there.
    g = startNode(voiced.url, "voice-g", { agentId: COMPANION_ID, profile: { voice: "v", speed: 1 } }, RUNTIME_TOKEN, { voice: { hub: "hub" } });
    pair(g, "n-hub", "Hub", f);
    // h is pinned to a hub it is not paired with.
    h = startNode(voiced.url, "voice-h", { agentId: COMPANION_ID }, RUNTIME_TOKEN, { voice: { hub: "Clipper" } });
    pair(h, "n-hub", "Hub", f);
    // i names itself as the hub: its own bridge answers.
    i = startNode(voiced.url, "voice-i", { agentId: COMPANION_ID }, RUNTIME_TOKEN, { nodeName: "Clipper", voice: { hub: "clipper" } });
    pair(i, "n-hub", "Hub", f);
    // Setup always targets the node itself; g, h and i get working bridges of their own, f is the hub.
    for (const n of [f, g, h, i]) expect((await req(n, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: "{}" })).status).toBe(200);
  });
  afterAll(() => { for (const n of [g, h, i]) { n.stop(); n.cleanup(); } });

  test("every voice route of a node pinned to the hub goes there, even with a bridge of its own", async () => {
    const own = await (await req(f, KEY, "/api/voice/config")).json();
    const cfg = await (await req(g, KEY, "/api/voice/config")).json();
    expect(cfg).toEqual({ ...own, via: { node: "n-hub", name: "Hub" } });
    const grant = await (await req(g, KEY, "/api/voice/livekit", { method: "POST" })).json();
    expect(grant).toMatchObject({ url: "wss://livekit.example/", via: { node: "n-hub", name: "Hub" } });
    const s = await (await req(g, TEST_TOKEN, "/api/voice/status")).json();
    expect(s.via).toEqual({ node: "n-hub", name: "Hub" });
    expect(s.local).toMatchObject({ configured: true });
    const t = await (await req(g, KEY, "/api/voice/transcript?limit=5")).json();
    expect(t.via).toEqual({ node: "n-hub", name: "Hub" });
    const state = await (await req(g, KEY, "/api/state")).json();
    expect(state.voice).toMatchObject({ configured: true, via: { node: "n-hub", name: "Hub" } });
    expect((await welcome(g)).voice).toMatchObject({ configured: true, via: { name: "Hub" } });
    // Asked directly (as the hub itself would ask), the node answers for itself.
    const direct = await (await req(g, KEY, "/api/voice/config", { headers: { "x-cyberdeck-voice-direct": "1" } })).json();
    expect(direct).toMatchObject({ configured: true });
    expect(direct.via).toBeUndefined();
  }, 20000);

  test("a hub that is not paired leaves the node without voice and says so", async () => {
    const cfg = await (await req(h, KEY, "/api/voice/config")).json();
    expect(cfg).toMatchObject({ configured: false, provider: "none" });
    expect(cfg.reason).toContain("voice hub Clipper is not paired");
    const call = await req(h, KEY, "/api/voice/livekit", { method: "POST" });
    expect(call.status).toBe(503);
    expect((await call.json()).reason).toContain("not paired");
    const s = await (await req(h, TEST_TOKEN, "/api/voice/status")).json();
    expect(s.configured).toBe(false);
    expect(s.reason).toContain("not paired");
    expect(s.local).toMatchObject({ configured: true });
    expect((await req(h, KEY, "/api/voice/session/reset", { method: "POST", body: "{}" })).status).toBe(503);
    expect((await req(h, KEY, "/api/voice/transcript")).status).toBe(503);
    // A node pinned to a hub that is not paired refuses instead of acting on its own agent: no trigger is made anywhere.
    const count = [...voiced.triggers.values()].flat().length;
    const refused = await req(h, TEST_TOKEN, "/api/voice/digest", { method: "POST", body: "{}" });
    expect(refused.status).toBe(503);
    expect((await refused.json()).reason).toContain("not paired");
    expect([...voiced.triggers.values()].flat().length).toBe(count);
    const state = await (await req(h, KEY, "/api/state")).json();
    expect(state.voice).toMatchObject({ configured: false, provider: "none" });
    expect(state.voice.reason).toContain("not paired");
  }, 20000);

  test("a node that is itself the hub answers locally and never relays", async () => {
    const cfg = await (await req(i, KEY, "/api/voice/config")).json();
    expect(cfg).toMatchObject({ configured: true, provider: "livekit" });
    expect(cfg.via).toBeUndefined();
    const grant = await (await req(i, KEY, "/api/voice/livekit", { method: "POST" })).json();
    expect(grant.url).toBe("wss://livekit.example/");
    expect(grant.via).toBeUndefined();
  }, 20000);

  test("the relay remembers a hub that did not answer, for a while, and forgets it when it answers", () => {
    const relay = createVoiceRelay(rows, async () => true, { hub: "clipper", self: "yacht" });
    expect(relay.outage()).toBeNull();
    relay.noteFailure("no answer in time");
    const first = relay.outage();
    expect(first).toMatchObject({ error: "no answer in time" });
    expect(Date.now() - first!.since).toBeLessThan(2000);
    // A second failure keeps the start of the outage and carries the latest error.
    relay.noteFailure("Unable to connect");
    expect(relay.outage()).toEqual({ since: first!.since, error: "Unable to connect" });
    relay.noteSuccess();
    expect(relay.outage()).toBeNull();
    expect(HUB_DOWN_TTL_MS).toBeGreaterThanOrEqual(5000);
    const node = rows()[1];
    expect(hubUnreachable({ ...node, last_seen: Date.now() - 2 * 3600_000 }, { since: 1, error: "no answer in time" }))
      .toBe("voice hub clipper is paired but not answering (no answer in time; last seen 2 h ago); calls resume when it is back on the network");
    expect(hubUnreachable({ ...node, last_seen: null }, { since: 1, error: "Unable to connect" })).toContain("(Unable to connect); calls resume");
    expect(agoText(Date.now() - 30_000)).toBe("just now");
    expect(agoText(Date.now() - 35 * 60_000)).toBe("35 min ago");
    expect(agoText(Date.now() - 3 * 86_400_000)).toBe("3 d ago");
    expect(agoText(null)).toBeNull();
  });

  test("a node that is itself off the tailnet blames itself, not the hub, and keeps the login url off the wire", () => {
    // `tailscale status --json` of a logged-out node (key expired, or `tailscale logout`): 2026-10-27 on yacht.
    const loggedOut = JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc", Self: { DNSName: "" } });
    expect(parseBackend(loggedOut)).toEqual({ running: false, state: "NeedsLogin", authUrl: "https://login.tailscale.com/a/abc" });
    expect(parseBackend(JSON.stringify({ BackendState: "Running", AuthURL: "", Self: { DNSName: "yacht.tail.ts.net." } }))).toEqual({ running: true, state: "Running", authUrl: null });
    expect(parseBackend(JSON.stringify({ BackendState: "Stopped" }))).toMatchObject({ running: false, state: "Stopped" });
    expect(parseBackend(null)).toBeNull();
    expect(parseBackend("not json")).toBeNull();
    expect(parseBackend("{}")).toBeNull();

    const relay = createVoiceRelay(() => [], undefined, { hub: "clipper", self: "Yacht" });
    const node = { id: "n-hub", name: "clipper", url: "http://127.0.0.1:1", token: "t", added_at: 0, last_seen: Date.now() - 10 * 3600_000 };
    // A running tailnet is not recorded: the hub really is the one not answering.
    relay.noteFailure("no route to the hub", { running: true, state: "Running", authUrl: null });
    expect(relay.outage()!.tailnet).toBeUndefined();
    expect(hubUnreachable(node, relay.outage()!, relay.self)).toContain("voice hub clipper is paired but not answering");
    relay.noteFailure("no route to the hub", parseBackend(loggedOut));
    const outage = relay.outage()!;
    expect(outage.tailnet).toMatchObject({ state: "NeedsLogin", running: false });
    expect(hubUnreachable(node, outage, relay.self)).toBe(
      "Yacht is off the tailnet, so voice hub clipper is out of reach (Tailscale on Yacht is logged out: log in from the Tailscale menu there, or run tailscale up; hub last seen 10 h ago); calls resume once this node is back on the tailnet"
    );
    expect(hubUnreachable(node, { since: 1, error: "x", tailnet: { running: false, state: "Stopped", authUrl: null } })).toContain("Tailscale on this node is switched off");
    expect(hubUnreachable(node, { since: 1, error: "x", tailnet: { running: false, state: "NoState", authUrl: null } }, "iris")).toContain("Tailscale on iris is no state");
    // The hub answering again clears it.
    relay.noteSuccess();
    expect(relay.outage()).toBeNull();
  });

  test("every voice route of a node that is off the tailnet says so, names this node, and never leaks the login url", async () => {
    const ts = new Tailscale(async (args) => (args[0] === "status" ? JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/secret-login", Self: { DNSName: "" } }) : null));
    const j = startNode(voiced.url, "voice-offnet", { agentId: COMPANION_ID }, RUNTIME_TOKEN, { nodeName: "yacht", voice: { hub: "clipper" } }, ts);
    j.db.query("INSERT INTO nodes (id,name,url,token,added_at,last_seen) VALUES (?,?,?,?,?,?)").run("n-hub", "clipper", "http://127.0.0.1:1", TEST_TOKEN, Date.now(), Date.now() - 10 * 3600_000);
    try {
      const cfg = await (await req(j, KEY, "/api/voice/config")).json();
      expect(cfg).toMatchObject({ configured: false, provider: "none", via: { name: "clipper" }, hub: { name: "clipper", reachable: false, tailnet: { state: "NeedsLogin", running: false } } });
      expect(cfg.reason).toBe("yacht is off the tailnet, so voice hub clipper is out of reach (Tailscale on yacht is logged out: log in from the Tailscale menu there, or run tailscale up; hub last seen 10 h ago); calls resume once this node is back on the tailnet");
      expect(JSON.stringify(cfg)).not.toContain("secret-login");
      // Remembered like any outage: the next answers carry it without asking tailscale or the network again.
      const call = await req(j, KEY, "/api/voice/livekit", { method: "POST" });
      expect(call.status).toBe(503);
      const callBody = await call.json();
      expect(callBody.reason).toContain("yacht is off the tailnet");
      expect(callBody.hub.tailnet).toEqual({ state: "NeedsLogin", running: false });
      expect(JSON.stringify(callBody)).not.toContain("secret-login");
      const s = await (await req(j, TEST_TOKEN, "/api/voice/status")).json();
      expect(s.configured).toBe(false);
      expect(s.reason).toContain("yacht is off the tailnet");
      expect(JSON.stringify(s)).not.toContain("secret-login");
      const state = await (await req(j, KEY, "/api/state")).json();
      expect(state.voice.reason).toContain("yacht is off the tailnet");
    } finally { j.stop(); j.cleanup(); }
  }, 20000);

  test("a paired hub that does not answer leaves the node without voice, says which hub and that it comes back", async () => {
    // j is pinned to "Dead", paired at a port nobody listens on: the connect fails at once.
    const j = startNode(voiced.url, "voice-j", { agentId: COMPANION_ID }, RUNTIME_TOKEN, { voice: { hub: "dead" } });
    j.db.query("INSERT INTO nodes (id,name,url,token,added_at,last_seen) VALUES (?,?,?,?,?,?)").run("n-dead", "Dead", "http://127.0.0.1:1", TEST_TOKEN, Date.now(), Date.now() - 90 * 60_000);
    try {
      expect((await req(j, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: "{}" })).status).toBe(200);
      const t0 = Date.now();
      const cfg = await (await req(j, KEY, "/api/voice/config")).json();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(cfg).toMatchObject({ configured: false, provider: "none", via: { node: "n-dead", name: "Dead" }, hub: { name: "Dead", node: "n-dead", reachable: false } });
      expect(cfg.reason).toContain("voice hub Dead is paired but not answering");
      expect(cfg.reason).toContain("last seen 2 h ago");
      expect(cfg.reason).not.toContain("not paired");
      // The outage is remembered: the next answers carry the same start and do not touch the network again.
      const again = await (await req(j, KEY, "/api/voice/config")).json();
      expect(again.hub.since).toBe(cfg.hub.since);
      const call = await req(j, KEY, "/api/voice/livekit", { method: "POST" });
      expect(call.status).toBe(503);
      const callBody = await call.json();
      expect(callBody.error).toBe("voice hub unreachable");
      expect(callBody.reason).toContain("not answering");
      expect(callBody.hub.lastSeen).toBe(cfg.hub.lastSeen);
      const s = await (await req(j, TEST_TOKEN, "/api/voice/status")).json();
      expect(s.configured).toBe(false);
      expect(s.reason).toContain("not answering");
      expect(s.via).toEqual({ node: "n-dead", name: "Dead" });
      expect(s.local).toMatchObject({ configured: true });
      expect((await req(j, KEY, "/api/voice/session/reset", { method: "POST", body: "{}" })).status).toBe(503);
      const t = await req(j, KEY, "/api/voice/transcript");
      expect(t.status).toBe(503);
      expect(await t.json()).toMatchObject({ supported: true, messages: [], via: { name: "Dead" } });
      const state = await (await req(j, KEY, "/api/state")).json();
      expect(state.voice).toMatchObject({ configured: false, provider: "none", via: { name: "Dead" } });
      expect(state.voice.reason).toContain("not answering");
      expect((await welcome(j)).voice).toMatchObject({ configured: false, via: { name: "Dead" } });
    } finally { j.stop(); j.cleanup(); }
  }, 20000);
});

describe("Seed text queries", () => {
  test("create, list, message, read, rename and delete are signed server actions; voice stays separate", async () => {
    const voiceSession = JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).sessionId;
    const create = await req(a, TEST_TOKEN, "/api/sessions", { method: "POST", body: JSON.stringify({ tool: "seed", runner: "agent", title: "A query" }) });
    expect(create.status).toBe(201);
    const s = await create.json() as any;
    expect(s.tool).toBe("seed"); expect(s.runner).toBe("agent");
    expect(s.id).toStartWith("seed-");
    expect(JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).sessionId).toBe(voiceSession);
    const id = s.id.slice(5);
    expect((await req(a, TEST_TOKEN, `/api/sessions/${s.id}/message`, { method: "POST", body: JSON.stringify({ text: "hello", cwd: "~/Code/Deck", nodeName: "yacht", clientMessageId: "retry-safe-id" }) })).status).toBe(200);
    const msg = voiced.actions.findLast((x) => x._ === "MessageSession");
    // (copied first: bun's toMatchObject with an asymmetric matcher rewrites the received array in place)
    const ctxLines = [...(msg.content[1].lines as string[])];
    expect(msg).toMatchObject({ sessionId: id, clientMessageId: "retry-safe-id", content: [{ type: "text", text: "hello" }, { type: "context" }] });
    expect(ctxLines).toContain("Working directory: ~/Code/Deck");
    expect(ctxLines[0]).toStartWith("Fleet machine: yacht (another fleet host");
    expect(ctxLines.at(-1)).toStartWith("Time: ");
    const transcript = await (await req(a, TEST_TOKEN, `/api/sessions/${s.id}/transcript?beforeSeq=5`)).json() as any;
    expect(transcript.events.some((e: any) => e.event.content === "Seed reply: hello")).toBe(true);
    expect(voiced.actions.findLast((x) => x._ === "GetSession").beforeSeq).toBe(5);
    expect((await (await req(a, TEST_TOKEN, "/api/sessions")).json() as any).sessions.some((x: any) => x.id === s.id)).toBe(true);
    const recovered = new SeedBridge({ config: seedConfig({ seed: { agentsUrl: voiced.url } }), port: 4777, token: TEST_TOKEN, home: a.home });
    expect((await recovered.querySessions()).some((x) => x.id === s.id)).toBe(true);
    expect((await req(a, TEST_TOKEN, `/api/sessions/${s.id}/stop`, { method: "POST" })).status).toBe(200);
    expect((await req(a, TEST_TOKEN, `/api/sessions/${s.id}/rename`, { method: "POST", body: JSON.stringify({ title: "Renamed query" }) })).status).toBe(200);
    expect(voiced.sessions.get(id)?.title).toBe("Renamed query");
    expect((await req(a, TEST_TOKEN, `/api/sessions/${s.id}`, { method: "DELETE" })).status).toBe(200);
    expect(voiced.sessions.has(id)).toBe(false);
  });
  test("harness sync: prompt from this node's AGENTS.md files, memory pack, idempotent, and the companion only on request", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-root-"));
    writeFileSync(join(root, "AGENTS.md"), "# Fleet rules\n\nNever commit at the root.\n");
    const deck = mkdtempSync(join(tmpdir(), "harness-deck-"));
    writeFileSync(join(deck, "AGENTS.md"), "# Deck agent protocol\n\nRun deck context first.\n");
    const mem = mkdtempSync(join(tmpdir(), "harness-mem-"));
    writeFileSync(join(mem, "MEMORY.md"), "- index\n");
    writeFileSync(join(mem, "seed-prod-hosts.md"), "---\nname: seed-prod-hosts\ndescription: ssh hm is not the agents VM\n---\n\nThe fact.\n");
    const h = startNode(voiced.url, "voice-h", undefined, undefined, { roots: [root], fleetDir: deck, seed: { memoryDirs: [mem], reasoningLevel: "high" } });
    try {
      expect((await req(h, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: JSON.stringify({ adopt: false }) })).status).toBe(200);
      const sync = async (body: object = {}) => (await req(h, TEST_TOKEN, "/api/voice/harness/sync", { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
      const r1 = await sync();
      expect(r1.sources).toMatchObject({ rules: join(root, "AGENTS.md"), deck: join(deck, "AGENTS.md"), notes: 1 });
      const harness = r1.agents.find((x: any) => x.role === "harness");
      expect(harness.created).toBe(true);
      const def = voiced.agents.get(harness.agentId)!;
      expect(def.name).toBe("Cyberdeck");
      expect(def.reasoningLevel).toBe("high");
      expect(def.mcpServers).toEqual(["cyberdeck"]);
      for (const s of ["Never commit at the root.", "Run deck context first.", "`cyberdeck__shell`", "`cyberdeck__deck_context`", "~/memory/fleet/README.md"]) expect(def.systemPrompt).toContain(s);
      expect(def.metadata.cyberdeck.promptHash).toHaveLength(64);
      expect(harness.memory).toMatchObject({ written: 4, deleted: 0, files: 4 });
      const files = voiced.memory.get(harness.agentId)!;
      expect([...files.keys()].sort()).toEqual(["fleet/README.md", "fleet/code-agents.md", "fleet/deck-protocol.md", "fleet/notes/seed-prod-hosts.md"]);
      expect(files.get("fleet/README.md")).toContain("ssh hm is not the agents VM");
      // The voice agent created by setup gets the pack but keeps its own prompt until adopted.
      const voice = r1.agents.find((x: any) => x.role === "voice");
      expect(voice.skipped).toContain("not managed");
      expect(voice.memory.written).toBe(4);
      // Second run: nothing to do.
      const r2 = await sync();
      expect(r2.agents.map((x: any) => [x.definition, x.memory.written, x.memory.deleted, x.memory.unchanged])).toEqual([[[], 0, 0, 4], [[], 0, 0, 4]]);
      // Changed rules: the prompt and the one pack file follow.
      writeFileSync(join(root, "AGENTS.md"), "# Fleet rules\n\nAlways run deck sync.\n");
      const r3 = await sync();
      const h3 = r3.agents.find((x: any) => x.role === "harness");
      expect(h3.definition).toEqual(["systemPrompt"]);
      expect(h3.memory).toMatchObject({ written: 1, unchanged: 3 });
      expect(voiced.agents.get(harness.agentId)!.systemPrompt).toContain("Always run deck sync.");
      // A pack file the agent lost is rewritten even though the manifest says it is current.
      voiced.memory.get(harness.agentId)!.delete("fleet/deck-protocol.md");
      expect((await sync()).agents[0].memory.written).toBe(1);
      // Adopt the companion: spoken persona plus the same knowledge.
      const r4 = await sync({ voice: true });
      const v4 = r4.agents.find((x: any) => x.role === "voice");
      expect(v4.definition).toEqual(["systemPrompt"]);
      const vdef = voiced.agents.get(v4.agentId)!;
      expect(vdef.systemPrompt).toContain("fleet companion");
      expect(vdef.systemPrompt).toContain("Always run deck sync.");
      expect(vdef.model).toBe("gpt-6-sol");
      expect((await sync()).agents.find((x: any) => x.role === "voice").definition).toEqual([]);
      const st = await (await req(h, TEST_TOKEN, "/api/voice/harness")).json() as any;
      expect(st.queryAgent).toMatchObject({ id: harness.agentId, name: "Cyberdeck", reasoningLevel: "high", promptCurrent: true, memoryFiles: 4 });
      expect(st.voiceAgent).toMatchObject({ managed: true, promptCurrent: true, memoryFiles: 4 });
      expect(st.nodeTools).toBe(true);
      expect(await (await req(h, TEST_TOKEN, "/api/voice/harness/prompt")).text()).toContain("Always run deck sync.");
      // The prompt bar's first query uses that agent instead of creating another.
      const creates = voiced.actions.filter((x) => x._ === "CreateAgent").length;
      const created = await (await req(h, TEST_TOKEN, "/api/sessions", { method: "POST", body: JSON.stringify({ tool: "seed", title: "q" }) })).json() as any;
      expect(voiced.sessions.get(created.id.slice(5))?.agentId).toBe(harness.agentId);
      expect(voiced.actions.filter((x) => x._ === "CreateAgent").length).toBe(creates);
      // A query created before any sync creates the harness agent with the same prompt and pack.
      const fresh = startNode(voiced.url, "voice-fresh", undefined, undefined, { roots: [root], fleetDir: deck, seed: { memoryDirs: [mem] } });
      try {
        await req(fresh, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: JSON.stringify({ adopt: false }) });
        const q = await (await req(fresh, TEST_TOKEN, "/api/sessions", { method: "POST", body: JSON.stringify({ tool: "seed", title: "first" }) })).json() as any;
        const agentId = voiced.sessions.get(q.id.slice(5))!.agentId;
        expect(voiced.agents.get(agentId)!.systemPrompt).toContain("Always run deck sync.");
        expect(voiced.agents.get(agentId)!.reasoningLevel).toBe("medium");
        expect(voiced.memory.get(agentId)!.size).toBe(4);
      } finally { fresh.stop(); fresh.cleanup(); }
    } finally { h.stop(); h.cleanup(); }
  });
  test("setup on an identity without a model provider keeps the MCP registration and says to log in", async () => {
    const n = startNode(voiced.url, "voice-noprov", undefined, undefined, { seed: { modelProvider: "Missing" } });
    try {
      const r = await req(n, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: JSON.stringify({ adopt: false }) });
      expect(r.status).toBe(502);
      const body = await r.json() as any;
      expect(body.error).toContain("cyberdeck seed login");
      expect(body.error).toContain('"Missing"');
      const state = JSON.parse(readFileSync(join(n.home, "seed.json"), "utf8"));
      expect(state.mcpRegisteredAt).toBeGreaterThan(0);
      expect(state.agentId).toBeUndefined();
      expect(voiced.mcp.has("cyberdeck")).toBe(true);
    } finally { n.stop(); n.cleanup(); }
  });
  test("keygen gives a node without a vault its own signing identity", async () => {
    const { dir, cleanup } = tmpHomeDir("voice-key");
    const saved = process.env.CYBERDECK_SEED_KEY_SEED;
    try {
      const bridge = new SeedBridge({ config: seedConfig({ seed: { agentsUrl: voiced.url, keyFile: join(dir, "seed-key") } }), port: 4777, token: TEST_TOKEN, home: dir });
      delete process.env.CYBERDECK_SEED_KEY_SEED;
      expect(bridge.keygen()).toMatchObject({ created: true, keyFile: join(dir, "seed-key") });
      expect(readFileSync(join(dir, "seed-key"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(bridge.keygen()).toMatchObject({ created: false });
      const st = await bridge.status();
      expect(st.identity.available).toBe(true);
      expect(st.identity.source).toBe("file");
      expect(st.identity.principal).toStartWith("z6Mk");
      expect(st.identity.principal).not.toBe(EXPECTED_PRINCIPAL);
    } finally { if (saved !== undefined) process.env.CYBERDECK_SEED_KEY_SEED = saved; cleanup(); }
  });
  test("login: start, paste the redirect, and the subscription provider is saved under the configured name", async () => {
    const start = await (await req(a, TEST_TOKEN, "/api/voice/login", { method: "POST", body: "{}" })).json() as any;
    expect(start.authUrl).toStartWith("https://auth.example/authorize");
    expect(JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).login.loginId).toBe(start.loginId);
    const pending = await (await req(a, TEST_TOKEN, "/api/voice/login", { method: "POST", body: JSON.stringify({ status: true }) })).json() as any;
    expect(pending.status).toBe("pending");
    const done = await (await req(a, TEST_TOKEN, "/api/voice/login", { method: "POST", body: JSON.stringify({ code: "http://localhost:1455/auth/callback?code=good&state=x" }) })).json() as any;
    expect(done).toMatchObject({ status: "completed", provider: "OpenAI" });
    expect(voiced.providers.get("OpenAI")).toMatchObject({ type: "openai", authMode: "subscription" });
    expect(JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8")).login).toBeUndefined();
    expect((await (await req(a, TEST_TOKEN, "/api/voice/providers")).json() as any).providers).toEqual([{ name: "OpenAI", type: "openai", authMode: "subscription", authStatus: "ok" }]);
    expect((await req(a, KEY, "/api/voice/login", { method: "POST", body: "{}" })).status).toBe(403);
    const bad = await (await req(a, TEST_TOKEN, "/api/voice/login", { method: "POST", body: JSON.stringify({ code: "nope", loginId: (await (await req(a, TEST_TOKEN, "/api/voice/login", { method: "POST", body: "{}" })).json() as any).loginId }) })).json() as any;
    expect(bad.status).toBe("failed");
  });
  test("query API rejects unauthenticated, pairing-key and unrelated voice-session access", async () => {
    const state = JSON.parse(readFileSync(join(a.home, "seed.json"), "utf8"));
    expect((await req(a, "bad", "/api/sessions")).status).toBe(401);
    expect((await req(a, KEY, "/api/sessions", { method: "POST", body: JSON.stringify({ tool: "seed" }) })).status).toBe(403);
    expect((await req(a, TEST_TOKEN, `/api/sessions/seed-${state.sessionId}/transcript`)).status).toBe(404);
    expect((await req(a, TEST_TOKEN, `/api/sessions/seed-${state.sessionId}/message`, { method: "POST", body: JSON.stringify({ text: "wrong agent" }) })).status).toBe(404);
  });
  test("text queries do not require voice support", async () => {
    await req(b, TEST_TOKEN, "/api/voice/setup", { method: "POST", body: "{}" });
    const created = await req(b, TEST_TOKEN, "/api/sessions", { method: "POST", body: JSON.stringify({ tool: "seed", title: "Text only" }) });
    expect(created.status).toBe(201);
    const s = await created.json() as any;
    expect(s.tool).toBe("seed");
  });
});


test("Seed query UI defaults, starts, resumes after reload, and sends a follow-up on desktop and mobile", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.addInitScript(({ token }) => {
      // Tailnet HTTP origins lack randomUUID; the send path must work there too.
      Object.defineProperty(crypto, "randomUUID", { value: undefined });
      localStorage.setItem("cyberdeck-token", token);
      // The old preference must not keep pre-Seed installations stuck on Codex.
      localStorage.setItem("cyberdeck-default-tool", "cx");
    }, { token: TEST_TOKEN });
    await page.goto(a.base + "/#/term");
    const input = page.locator('[data-testid="prompt-input"]');
    await input.fill("Check the fleet");
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid="prompt-go"]')?.disabled);
    expect(await page.locator('[data-testid="plan-tool"]').textContent()).toContain("Seed agents");
    expect(await page.locator('[data-testid="plan-runner"]').count()).toBe(0);
    const held = voiced.holdNextMessage();
    await input.press("Enter");
    try {
      await held.received;
      // The session exists and opens before MessageSession responds. Agent startup and the first
      // model turn happen in the conversation instead of freezing the launcher.
      expect(page.url()).toContain("session=seed-");
      await page.locator('[data-testid="seed-agents"]').waitFor();
    } finally {
      held.release();
    }
    await page.getByText("Seed reply: Check the fleet", { exact: true }).waitFor();
    const url = page.url();
    expect(url).toContain("session=seed-");
    await page.reload();
    await page.getByText("Seed reply: Check the fleet", { exact: true }).waitFor();
    // Local Seed sessions render in Seed's own published agents UI: its block editor composes replies.
    const reply = async (text: string) => {
      const seed = page.locator('[data-testid="seed-agents"]');
      const editor = seed.locator('[contenteditable="true"]:visible').last();
      const collapsed = seed.getByRole("button", { name: /Start a Discussion|Write a Reply/ }).last();
      await editor.or(collapsed).first().waitFor(); // the editor loads lazily
      if (await collapsed.isVisible()) await collapsed.click();
      await editor.click();
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    };
    await reply("And the services?");
    await page.getByText("Seed reply: And the services?", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await reply("Mobile reply");
    await page.getByText("Seed reply: Mobile reply", { exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await input.fill("cx: explicitly use Codex");
    expect(await page.locator('[data-testid="plan-tool"]').textContent()).toContain("cx");
    expect(await page.locator('[data-testid="plan-runner"]').count()).toBe(1);
  } finally { await browser.close(); }
}, 45000);

describe("seed profiles", () => {
  // A second agents server (think agent.hm) next to the default one: its own bridge, own state file, own agent; the hub relay
  // never applies to it, and the MCP server it is told about is the public route from config, not loopback.
  let hosted: ReturnType<typeof fakeAgents>, p: Node;
  const MCP_PUBLIC = "https://yacht.example.ts.net:8443/api/mcp";
  beforeAll(() => {
    hosted = fakeAgents({ voice: false });
    p = startNode(voiced.url, "voice-profiles", undefined, undefined, { seed: { profiles: { prod: { agentsUrl: hosted.url, mcpUrl: MCP_PUBLIC } } } });
  });
  afterAll(() => { p.stop(); p.cleanup(); hosted.stop(); });

  test("profiles lists the default and the entry; ?profile= addresses the entry and an unknown name is a 404", async () => {
    const list = await (await req(p, TEST_TOKEN, "/api/voice/profiles")).json();
    expect(list.profiles.map((x: any) => [x.name, x.agentsUrl, x.mcpUrl, x.configured])).toEqual([[null, voiced.url, `http://127.0.0.1:4777/api/mcp`, false], ["prod", hosted.url, MCP_PUBLIC, false]]);
    expect(list.profiles[1].stateFile).toBe(join(p.home, "seed-prod.json"));
    expect((await req(p, TEST_TOKEN, "/api/voice/profiles", { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(403);
    const s = await (await req(p, TEST_TOKEN, "/api/voice/status?profile=prod")).json();
    expect(s).toMatchObject({ seedProfile: "prod", agentsUrl: hosted.url, mcpUrl: MCP_PUBLIC, configured: false, health: { ok: true, voice: false } });
    expect(s.via).toBeUndefined();
    expect(s.local).toBeUndefined();
    const def = await (await req(p, TEST_TOKEN, "/api/voice/status")).json();
    expect(def.seedProfile).toBeUndefined();
    expect(def.agentsUrl).toBe(voiced.url);
    const missing = await req(p, TEST_TOKEN, "/api/voice/status?profile=nope");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/unknown seed profile "nope".*prod/);
    expect((await req(p, TEST_TOKEN, "/api/voice/setup?profile=nope", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await req(p, TEST_TOKEN, "/api/voice/providers?profile=nope")).status).toBe(404);
  });

  test("setup of a profile registers the public MCP url on that server only and keeps its state apart", async () => {
    const before = voiced.actions.length;
    const r = await req(p, TEST_TOKEN, "/api/voice/setup?profile=prod", { method: "POST", body: JSON.stringify({ adopt: false }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.mcp).toMatchObject({ name: "cyberdeck", url: MCP_PUBLIC });
    expect(body.agent.origin).toBe("created");
    expect(hosted.mcp.get("cyberdeck")).toMatchObject({ url: MCP_PUBLIC, transport: "http" });
    expect(voiced.actions.length).toBe(before); // the default server saw nothing
    const state = JSON.parse(readFileSync(join(p.home, "seed-prod.json"), "utf8"));
    expect(state.agentId).toBe(body.agent.id);
    expect(existsSync(join(p.home, "seed.json"))).toBe(false); // the default bridge never wrote anything
    const s = await (await req(p, TEST_TOKEN, "/api/voice/status?profile=prod")).json();
    expect(s.agent).toEqual({ id: body.agent.id, name: "Cyberdeck" });
    expect(s.configured).toBe(false); // the hosted server has no voice pipeline
    expect(s.reason).toMatch(/no voice pipeline/);
    const list = await (await req(p, TEST_TOKEN, "/api/voice/profiles")).json();
    expect(list.profiles[1].agent).toEqual({ id: body.agent.id, name: "Cyberdeck" });
    expect(list.profiles[0].agent).toBeUndefined();
    // The call routes answer for the profile itself (no hub, no relay): not configured, not "hub unreachable".
    const call = await req(p, TEST_TOKEN, "/api/voice/livekit?profile=prod", { method: "POST" });
    expect(call.status).toBe(503);
    expect((await call.json()).reason).toMatch(/no voice pipeline/);
  });
});
