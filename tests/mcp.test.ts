// The MCP server at /api/mcp, driven by the same client library Seed Agents uses.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, testConfig, TEST_TOKEN, type TestServer } from "./helpers";

const FLEET_STUB = join(import.meta.dir, "fixtures", "fleet");
const SCRATCH = mkdtempSync(join(tmpdir(), "cd-servicectl-"));
const SSH_LOG = join(SCRATCH, "ssh.log");
process.env.CYBERDECK_AUDIT_LOG = join(SCRATCH, "audit.log");
process.env.CYBERDECK_SSH = join(import.meta.dir, "fixtures", "ssh-stub.sh");
process.env.SSH_STUB_LOG = SSH_LOG;
process.env.CYBERDECK_SERVICECTL_SETTLE_MS = "0";
const DECK_LOG = join(SCRATCH, "deck.log");
process.env.DECK_STUB_LOG = DECK_LOG;

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
    expect(names).toEqual(["collab_add", "collab_run", "collab_tasks", "fleet_status", "handoff", "handoff_note", "hosts", "note", "projects", "repos", "run_log", "scan", "service_logs", "services", "services_restart", "sessions", "status", "todo", "todo_add", "todo_done"]);
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

  test("service_logs and services_restart only reach manifest services", async () => {
    const client = await connect(srv.base);
    const refusals: [string, Record<string, unknown>, string][] = [
      ["service_logs", { host: "nowhere", name: "x" }, "No host"],
      ["service_logs", { host: "other", name: "rm -rf /" }, "Its services: web-api, db"],
      ["service_logs", { host: "test-node", name: "cyberdeck" }, "http probe"],
      ["service_logs", { host: "phone", name: "app" }, "no ssh alias"],
      ["services_restart", { host: "test-node", name: "sh.cyberdeck.daemon" }, "cut the call off"],
    ];
    for (const [tool, args, msg] of refusals) {
      const r = await call(client, tool, args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(msg);
    }
    expect(existsSync(SSH_LOG)).toBe(false);
    await client.close();
  });

  test("service_logs reads a remote service over ssh with a quoted, bounded command", async () => {
    const client = await connect(srv.base);
    const r = parsed(await call(client, "service_logs", { host: "OTHER", name: "web-api", lines: 25 }));
    expect(r).toMatchObject({ host: "other", service: "web-api", type: "systemd", lines: 25, ok: true });
    expect(r.output).toContain("stub log line from other-alias");
    const log = readFileSync(SSH_LOG, "utf8");
    expect(log).toContain("BatchMode=yes other-alias bash -s");
    expect(log).toContain("journalctl --no-pager -u 'web-api' -n 25");
    expect(log).toContain("sudo -n journalctl");
    await client.close();
  });

  test("services_restart restarts, re-checks, audits, and stops after three in the window", async () => {
    const client = await connect(srv.base);
    const r = parsed(await call(client, "services_restart", { host: "other", name: "db", reason: "test" }));
    expect(r).toMatchObject({ host: "other", service: "db", type: "docker", ok: true, state: "active", attempts: 1 });
    expect(readFileSync(SSH_LOG, "utf8")).toContain("docker restart 'db'");
    const audit = readFileSync(process.env.CYBERDECK_AUDIT_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ action: "service-restart", by: "mcp: test", host: "other", service: "db", ok: true });
    await call(client, "services_restart", { host: "other", name: "db" });
    await call(client, "services_restart", { host: "other", name: "db" });
    const fourth = await call(client, "services_restart", { host: "other", name: "db" });
    expect(fourth.isError).toBe(true);
    expect(fourth.content[0].text).toContain("3 times");
    await client.close();
  });

  test("todo_add, todo_done and handoff_note write through the deck CLI", async () => {
    const client = await connect(srv.base);
    const added = parsed(await call(client, "todo_add", { text: "**Voice** check the backups", section: "Open" }));
    expect(added).toMatchObject({ ok: true, section: "Open" });
    const done = parsed(await call(client, "todo_done", { match: "Demo" }));
    expect(done).toMatchObject({ ok: true, removed: "- 2026-10-07 **Demo** thing" });
    const miss = await call(client, "todo_done", { match: "nothing like it" });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text).toContain("no entry contains");
    expect(parsed(await call(client, "handoff_note", { host: "OTHER", text: "restarted db" }))).toMatchObject({ ok: true, file: "handoff/other-seed.md" });
    const bad = await call(client, "handoff_note", { host: "nowhere", text: "x y z" });
    expect(bad.isError).toBe(true);
    const calls = readFileSync(DECK_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls[0]).toEqual(["todo", "add", "--section", "Open", expect.stringMatching(/^\*\*Voice\*\* check the backups \(seed@[a-z0-9-]+\)$/)]);
    expect(calls[1]).toEqual(["todo", "done", "Demo"]);
    expect(calls[3]).toEqual(["handoff", "note", "other", "seed", "restarted db"]);
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
