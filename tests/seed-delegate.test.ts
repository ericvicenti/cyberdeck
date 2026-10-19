// Voice-initiated workflows: the `delegate` MCP tool hands a job to the harness agent (a fresh session on
// the agents server), `delegate_result` reads the answer back, and a finished run's `announce` line carries
// that answer onto the Desk. A fake agents server plays the session API with signed envelopes.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { writeFileSync } from "fs";
import * as blobs from "@seed-hypermedia/client/blobs";
import * as cbor from "@seed-hypermedia/client/cbor";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initSchema } from "../src/daemon/db";
import { createServer } from "../src/daemon/server";
import { Tailscale } from "../src/daemon/tailscale";
import { testConfig, TEST_TOKEN, tmpHomeDir } from "./helpers";

process.env.CYBERDECK_SEED_KEY_SEED = "5e".repeat(32);
const VOICE_AGENT = "voice-agent-1";
const HARNESS_AGENT = "harness-agent-1";

type Ev = { seq: number; createdAt: number; event: { type: string; role: string; content: string } };
const sessions = new Map<string, { title: string; status: string; events: Ev[] }>();
const actions: any[] = [];
let agents: ReturnType<typeof Bun.serve>;
let stop: () => void, cleanup: () => void, base: string;

function reply(value: unknown) {
  return new Response(cbor.encode(value as any) as unknown as BodyInit, { headers: { "content-type": "application/cbor", "x-agents-protocol": "3" } });
}

beforeAll(() => {
  agents = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return Response.json({ status: "ok", protocol: 3, voice: true });
      if (url.pathname !== "/api/message" || req.method !== "POST") return new Response("nope", { status: 404 });
      const env: any = cbor.decode(new Uint8Array(await req.arrayBuffer()));
      await blobs.nativeCryptoReady;
      if (!blobs.verify(env)) return new Response(cbor.encode({ _: "Error", message: "Invalid signature" }) as unknown as BodyInit, { status: 401 });
      const a = env.action;
      actions.push(a);
      if (a._ === "CreateSession") {
        const id = `s-${sessions.size + 1}`;
        sessions.set(id, { title: a.title, status: "idle", events: [] });
        return reply({ _: "CreateSessionResponse", sessionId: id });
      }
      if (a._ === "MessageSession") {
        const s = sessions.get(a.sessionId);
        if (!s) return reply({ _: "Error", message: "no such session" });
        s.events.push({ seq: s.events.length + 1, createdAt: Date.now(), event: { type: "message", role: "user", content: a.content[0].text } });
        s.status = "streaming";
        return reply({ _: "MessageSessionResponse" });
      }
      if (a._ === "GetSession") {
        const s = sessions.get(a.sessionId);
        if (!s) return new Response(cbor.encode({ _: "Error", message: "session not found" }) as unknown as BodyInit, { status: 404 });
        return reply({ _: "GetSessionResponse", session: { id: a.sessionId, agentId: HARNESS_AGENT, title: s.title, status: s.status }, events: s.events, hasMoreBefore: false });
      }
      return reply({ _: `${a._}Response` });
    },
  });
  const home = tmpHomeDir("seed-delegate");
  cleanup = home.cleanup;
  // A node whose bridge is set up: the companion agent exists, the MCP server is registered, and the harness agent too.
  writeFileSync(join(home.dir, "seed.json"), JSON.stringify({ agentId: VOICE_AGENT, mcpRegisteredAt: Date.now(), queryAgentId: HARNESS_AGENT }));
  const db = new Database(":memory:");
  initSchema(db);
  const s = createServer(db, testConfig({ seed: { agentsUrl: `http://127.0.0.1:${agents.port}` } }), TEST_TOKEN, "stw-test", {
    persistOwner: false, cloudSync: false, tailscale: new Tailscale(async () => null),
    seed: { home: home.dir, companionFile: join(home.dir, "companion.json"), runtimeFile: join(home.dir, "runtime.json") },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: s.fetch, websocket: s.websocket });
  base = `http://127.0.0.1:${server.port}`;
  stop = () => { s.sessions.close(); void server.stop(true); };
});
afterAll(() => { stop(); agents.stop(true); cleanup(); });

type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
async function mcp(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } } }), { timeout: 10_000 });
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
const parsed = (r: ToolResult) => JSON.parse(r.content[0]?.text ?? "null");

describe("delegate", () => {
  test("hands the task to the harness agent, reads the answer back, and the announcement carries it", async () => {
    const client = await mcp();
    // 1. the voice agent hands the job off and is free again
    const d = await call(client, "delegate", { task: "Check every host and tell me what is down.\nName the hosts.", title: "Fleet check", brief: true });
    expect(d.isError).toBeFalsy();
    expect(d.content[0]?.text).toBe('Handed "Fleet check" to the fleet agent; a line appears on the Desk when it is done.');
    const sessionId = d.structuredContent?.sessionId as string;
    expect(sessionId).toBe("s-1");
    expect(actions.map((a) => a._)).toEqual(["CreateSession", "MessageSession"]);
    expect(actions[0]).toMatchObject({ agentId: HARNESS_AGENT, title: "Fleet check" });
    expect(actions[1]).toMatchObject({ sessionId: "s-1", content: [{ type: "text", text: "Check every host and tell me what is down.\nName the hosts." }] });

    // 2. still running: no answer yet
    const running = parsed(await call(client, "delegate_result", { sessionId }));
    expect(running).toMatchObject({ brief: '"Fleet check" is still running.', state: "running", sessionId: "s-1", turns: 1 });
    expect(running.answer).toBeUndefined();

    // 3. the harness agent answers
    const s = sessions.get("s-1")!;
    s.events.push({ seq: 2, createdAt: Date.now(), event: { type: "message", role: "assistant", content: "Two hosts are down: starlight and clipper. The other seven answer." } });
    s.status = "idle";
    const done = await call(client, "delegate_result", { sessionId: `seed-${sessionId}`, brief: true });
    expect(done.content[0]?.text).toBe('"Fleet check" finished: Two hosts are down: starlight and clipper. The other seven answer.');
    expect(done.structuredContent).toMatchObject({ state: "done", sessionId: "s-1" });

    // 4. the run-completed trigger's headless announce shows the answer on the Desk, not just "done"
    const a = parsed(await call(client, "announce", { title: "Fleet check", status: "succeeded", runId: "r1", sessionId }));
    expect(a).toMatchObject({ announced: true, notice: { text: 'Done: "Fleet check" finished: Two hosts are down: starlight and clipper. The other seven answer.', run: { id: "r1", sessionId: "s-1" } } });
    // a failed run, or one that gave text, is left alone
    expect(parsed(await call(client, "announce", { title: "Fleet check", status: "failed", runId: "r2", sessionId })).notice.text).toBe('Failed: "Fleet check" failed.');

    // 5. the default title is the task's first line; unknown sessions fail with the server's words
    const d2 = parsed(await call(client, "delegate", { task: "Probe all services on enuc.\nThen read the kiosk log." }));
    expect(d2).toMatchObject({ delegated: true, title: "Probe all services on enuc.", sessionId: "s-2" });
    const missing = await call(client, "delegate_result", { sessionId: "s-9" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toMatch(/delegate_result failed: /);
  }, 20_000);
});
