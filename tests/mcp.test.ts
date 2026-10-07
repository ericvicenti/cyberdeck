// The MCP server at /api/mcp, driven by the same client library Seed Agents uses.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, testConfig, TEST_TOKEN, type TestServer } from "./helpers";

const FLEET_STUB = join(import.meta.dir, "fixtures", "fleet");

let srv: TestServer;
let bare: TestServer;

async function connect(base: string, token = TEST_TOKEN): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport, { timeout: 10_000 });
  return client;
}

type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const parsed = (r: ToolResult) => JSON.parse(r.content[0]?.text ?? "null");

beforeAll(() => {
  srv = startTestServer(testConfig({ fleetDir: FLEET_STUB, nodeName: "test-node" }));
  srv.db.query(
    `INSERT INTO repos (path, name, head_branch, dirty_files, remotes, risk, risk_reasons, scanned_at)
     VALUES ('/home/x/Code/lonely', 'lonely', 'main', 2, '[]', 'at-risk', '["no remote"]', 1),
            ('/home/x/Code/fine', 'fine', 'main', 0, '["origin"]', 'safe', '[]', 1)`
  ).run();
  bare = startTestServer(testConfig({ fleetDir: null, nodeName: "bare" }));
});
afterAll(() => {
  srv.stop();
  bare.stop();
});

describe("mcp transport", () => {
  test("rejects a client without the bearer token", async () => {
    const client = new Client({ name: "anon", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/api/mcp`));
    await expect(client.connect(transport, { timeout: 5000 })).rejects.toThrow(/unauthorized/);
  });
  test("query-string token also works (the daemon's second auth form)", async () => {
    const res = await fetch(`${srv.base}/api/mcp?token=${TEST_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "curl", version: "0" } } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("cyberdeck");
    expect(body.result.instructions).toContain("Cyberdeck");
  });
  test("GET and DELETE are refused (stateless)", async () => {
    expect((await srv.api("/api/mcp")).status).toBe(405);
    expect((await srv.api("/api/mcp", { method: "DELETE" })).status).toBe(405);
  });
  test("every request stands alone: no session id is issued", async () => {
    const client = await connect(srv.base);
    const t = client.transport as StreamableHTTPClientTransport;
    expect(t.sessionId).toBeUndefined();
    await client.close();
  });
});

describe("mcp tools", () => {
  test("lists the deck tool set with provider-safe names", async () => {
    const client = await connect(srv.base);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["collab_add", "collab_run", "collab_tasks", "fleet_status", "handoff", "hosts", "note", "projects", "repos", "run_log", "scan", "services", "sessions", "status", "todo"]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]{1,40}$/);
      expect(t.description?.length ?? 0).toBeGreaterThan(20);
    }
    await client.close();
  });

  test("status reports this node and its peers", async () => {
    const client = await connect(srv.base);
    const r = parsed(await call(client, "status"));
    expect(r.node.nodeName).toBe("test-node");
    expect(r.node.repos).toBe(2);
    expect(r.node.atRisk).toBe(1);
    expect(r.peers).toEqual([]);
    await client.close();
  });

  test("repos defaults to at-risk, filters and limits, and carries structured content", async () => {
    const client = await connect(srv.base);
    const atRisk = await call(client, "repos");
    expect(parsed(atRisk).items.map((r: any) => r.name)).toEqual(["lonely"]);
    expect(parsed(atRisk).items[0].risk_reasons).toEqual(["no remote"]);
    expect((atRisk.structuredContent as any).total).toBe(1);
    const all = parsed(await call(client, "repos", { risk: "all", limit: 1 }));
    expect(all.total).toBe(2);
    expect(all.items.length).toBe(1);
    const byQuery = parsed(await call(client, "repos", { risk: "all", query: "FINE" }));
    expect(byQuery.items.map((r: any) => r.name)).toEqual(["fine"]);
    const unknown = await call(client, "repos", { node: "nowhere" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("No paired node");
    await client.close();
  });

  test("deck-backed tools read through the control module", async () => {
    const client = await connect(srv.base);
    expect(parsed(await call(client, "fleet_status")).host).toBe("test-node");
    expect(parsed(await call(client, "projects"))[0].slug).toBe("demo");
    const todo = parsed(await call(client, "todo", { query: "demo" }));
    expect(todo.sections[0].entries[0].text).toContain("Demo");
    expect(parsed(await call(client, "todo", { query: "zzz" })).sections).toEqual([]);
    expect(parsed(await call(client, "handoff"))[0].agent).toBe("cc");
    expect(parsed(await call(client, "sessions", { query: "t", tool: "cc" }))[0].id).toBe("abc");
    const collab = parsed(await call(client, "collab_tasks"));
    expect(collab.tasks[0].id).toBe("t1");
    expect(collab.runs).toEqual([]);
    const added = parsed(await call(client, "collab_add", { title: "Do a thing", project: "demo", worker: "cx" }));
    expect(added.id).toBe("t2");
    await client.close();
  });

  test("services returns the probe (fresh when asked)", async () => {
    const client = await connect(srv.base);
    const fresh = parsed(await call(client, "services", { probe: true }));
    expect(fresh.rows[0].service).toBe("x");
    const cached = parsed(await call(client, "services"));
    expect(cached.probedAt).toBe(fresh.probedAt);
    await client.close();
  });

  test("run_log refuses unknown files and reports empty logs", async () => {
    const client = await connect(srv.base);
    const r = parsed(await call(client, "run_log", { id: "nope" }));
    expect(r).toEqual({ id: "nope", file: "result.md", text: "", size: 0 });
    const bad = await call(client, "run_log", { id: "../etc", file: "result.md" });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  test("a node without a Deck checkout still serves status and repos but explains the rest", async () => {
    const client = await connect(bare.base);
    expect(parsed(await call(client, "status")).node.nodeName).toBe("bare");
    expect(parsed(await call(client, "repos", { risk: "all" })).total).toBe(0);
    const r = await call(client, "todo");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("no Deck checkout");
    await client.close();
  });
});
