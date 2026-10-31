// The MCP server at /api/mcp, driven by the same client library Seed Agents uses.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { homedir } from "os";
import { startTestServer, testConfig, TEST_TOKEN, type TestServer } from "./helpers";
import { expandPath } from "../src/daemon/api/mcp-node";

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
let gateway: ReturnType<typeof Bun.serve>;
const gatewayHits: string[] = [];
process.env.CYBERDECK_OPENER = "echo opened";
delete process.env.CYBERDECK_SEED_OWNER_ACCOUNT;
delete process.env.CYBERDECK_SEED_GATEWAY;

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

const LIVE_REPO = join(SCRATCH, "Livedemo");
beforeAll(() => {
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: SCRATCH });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main", LIVE_REPO);
  writeFileSync(join(LIVE_REPO, "a.txt"), "1\n");
  git("-C", LIVE_REPO, "add", ".");
  git("-C", LIVE_REPO, "commit", "-qm", "first");
  writeFileSync(join(LIVE_REPO, "b.txt"), "x\n");
  gateway = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      gatewayHits.push(u.pathname + u.search);
      if (u.pathname === "/api/Resource") {
        const id = u.searchParams.get("id") ?? "";
        if (id === "hm://z6MkOwner/notes/yacht-sync") return Response.json({ json: { type: "document", id, document: {
          account: "z6MkOwner", path: "/notes/yacht-sync", authors: ["z6MkOwner"], version: "bafyv1", visibility: "PUBLIC",
          createTime: "2026-09-01T10:00:00.000Z", updateTime: "2026-09-02T12:00:00.000Z",
          metadata: { name: "Desktop sync failure on yacht", summary: "Two daemons shared one identity" },
          content: [
            { block: { type: "Paragraph", text: "Two Seed daemons on yacht shared one libp2p identity." }, children: [] },
            { block: { type: "Heading", text: "What happened", attributes: { childrenType: "Group" } }, children: [
              { block: { type: "Paragraph", text: "The desktop app and the dev daemon both loaded the same key." }, children: [] },
              { block: { type: "Code", text: "lsof -i :58001", attributes: { language: "sh" } }, children: [] },
            ] },
            { block: { type: "Heading", text: "Fix", attributes: { childrenType: "Ordered" } }, children: [
              { block: { type: "Paragraph", text: "Stop the dev daemon." }, children: [] },
              { block: { type: "Paragraph", text: "Give it its own data dir." }, children: [] },
            ] },
            { block: { type: "Image", text: "the two processes", link: "ipfs://bafyimg" }, children: [] },
          ],
        } } });
        if (id === "hm://z6MkOwner/hm26") return Response.json({ json: { type: "comment", id, comment: {} } });
        return new Response("not found", { status: 404 });
      }
      if (u.pathname !== "/api/Query") return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
      const includes = JSON.parse(u.searchParams.get("includes") ?? "[]") as { space: string }[];
      if (includes[0]?.space === "z6MkEmpty") return Response.json({ json: { results: [] } });
      const uid = includes[0]?.space ?? "z6MkOwner";
      const doc = (path: string[], name: string, summary: string, updated: number, created = updated - 3600) => ({
        type: "document", id: { id: `hm://${uid}/${path.join("/")}`, uid, path }, path, metadata: { name, summary }, visibility: "PUBLIC",
        createTime: { seconds: String(created), nanos: 0 }, updateTime: { seconds: String(updated), nanos: 0 }, sortTime: new Date(updated * 1000).toISOString(),
      });
      const now = Math.floor(Date.now() / 1000);
      // Out of order on purpose: the tool sorts by the newest publish.
      return Response.json({ json: { results: [
        doc(["notes", "clipper-bootstrap"], "Clipper bootstrap guide", "How the Mac mini was set up", now - 9 * 86400),
        doc(["notes", "yacht-sync"], "Desktop sync failure on yacht", "Two daemons shared one identity", now - 86400),
        doc(["hm26"], "", "", now - 20 * 86400),
      ] } });
    },
  });
  srv = startTestServer(testConfig({ fleetDir: FLEET_STUB, nodeName: "test-node", seed: { ownerAccount: "z6MkOwner", gatewayUrl: `http://127.0.0.1:${gateway.port}` } }));
  srv.db.query(
    `INSERT INTO repos (path, name, head_branch, dirty_files, ahead, remotes, risk, risk_reasons, scanned_at)
     VALUES ('/home/x/Code/lonely', 'lonely', 'main', 2, 0, '[]', 'at-risk', '["no remote"]', 1),
            ('/home/x/Code/fine', 'fine', 'main', 0, 0, '["origin"]', 'safe', '[]', 1),
            ('${LIVE_REPO}', 'Livedemo', 'main', 1, 3, '[]', 'at-risk', '["no remote"]', 1)`
  ).run();
  bare = startTestServer(testConfig({ fleetDir: null, nodeName: "bare" }));
}, 60_000);
afterAll(() => {
  srv.stop();
  bare.stop();
  gateway.stop(true);
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
    expect(names).toEqual(["announce", "collab_add", "collab_run", "collab_tasks", "deck_context", "delegate", "delegate_result", "documents", "edit_file", "fleet_status", "grep", "handoff", "handoff_note", "hosts", "list_dir", "listen", "media", "note", "open_url", "projects", "read_document", "read_file", "repos", "repos_detail", "run_log", "scan", "service_logs", "services", "services_restart", "sessions", "sessions_search", "shell", "status", "todo", "todo_add", "todo_done", "write_file"]);
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
    expect(r.node.repos).toBe(3);
    expect(r.node.atRisk).toBe(2);
    expect(r.peers).toEqual([]);
    await client.close();
  });

  test("repos defaults to at-risk, filters and limits, and carries structured content", async () => {
    const client = await connect(srv.base);
    const atRisk = await call(client, "repos");
    expect(parsed(atRisk).items.map((r: any) => r.name).sort()).toEqual(["Livedemo", "lonely"]);
    expect(parsed(atRisk).items.find((r: any) => r.name === "lonely").risk_reasons).toEqual(["no remote"]);
    expect((atRisk.structuredContent as any).total).toBe(2);
    const all = parsed(await call(client, "repos", { risk: "all", limit: 1 }));
    expect(all.total).toBe(3);
    expect(all.items.length).toBe(1);
    const byQuery = parsed(await call(client, "repos", { risk: "all", query: "FINE" }));
    expect(byQuery.items.map((r: any) => r.name)).toEqual(["fine"]);
    // kind narrows to what the owner asks by voice: "which repos have unpushed commits?"
    expect(parsed(await call(client, "repos", { kind: "unpushed" })).items.map((r: any) => r.name)).toEqual(["Livedemo"]);
    expect(parsed(await call(client, "repos", { kind: "remote-less" })).items.map((r: any) => r.name).sort()).toEqual(["Livedemo", "lonely"]);
    expect(parsed(await call(client, "repos", { risk: "all", kind: "dirty" })).items.map((r: any) => r.name).sort()).toEqual(["Livedemo", "lonely"]);
    expect(parsed(await call(client, "repos", { risk: "safe", kind: "dirty" })).total).toBe(0);
    expect(parsed(await call(client, "repos"))).toMatchObject({ unpushed: 1, remoteless: 2 });
    const unknown = await call(client, "repos", { node: "nowhere" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("No paired node");
    await client.close();
  });
  test("repos node=all asks every paired node, tags the rows and names the peer that did not answer", async () => {
    // bare is a reachable peer with one unpushed repo; "ghost" is paired but gone.
    bare.db.query(`INSERT INTO repos (path, name, head_branch, dirty_files, ahead, remotes, risk, risk_reasons, scanned_at)
      VALUES ('/srv/Code/far', 'far', 'main', 0, 2, '["origin"]', 'at-risk', '["unpushed"]', 1)`).run();
    srv.db.query("INSERT INTO nodes (id, name, url, token, added_at) VALUES (?, ?, ?, ?, ?)").run("n-bare", "bare", bare.base, TEST_TOKEN, Date.now());
    srv.db.query("INSERT INTO nodes (id, name, url, token, added_at) VALUES (?, ?, ?, ?, ?)").run("n-ghost", "ghost", "http://127.0.0.1:9", "x", Date.now());
    const client = await connect(srv.base);
    try {
      const all = parsed(await call(client, "repos", { node: "all", kind: "unpushed" }));
      expect(all).toMatchObject({ node: "all", total: 2, unpushed: 2, nodes: ["test-node", "bare", "ghost"], unreachable: ["ghost"] });
      expect(all.items.map((r: any) => `${r.node}/${r.name}`).sort()).toEqual(["bare/far", "test-node/Livedemo"]);
      expect(all.brief).toBe("the fleet has 2 repos at risk with unpushed commits: test-node 1 (Livedemo), bare 1 (far). ghost did not answer.");
      const brief = await call(client, "repos", { node: "fleet", risk: "safe", brief: true });
      expect(brief.content[0].text).toBe("the fleet has 1 safe repos: test-node 1 (fine). ghost did not answer.");
      // a single node still answers for itself
      expect(parsed(await call(client, "repos", { node: "bare", kind: "unpushed" }))).toMatchObject({ node: "bare", total: 1 });
    } finally {
      srv.db.query("DELETE FROM nodes WHERE id IN ('n-bare', 'n-ghost')").run();
      bare.db.query("DELETE FROM repos WHERE path = '/srv/Code/far'").run();
      await client.close();
    }
  }, 30_000);

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

  test("repos_detail reads an indexed repo live, by folder name; refuses unknown ones", async () => {
    const client = await connect(srv.base);
    const r = await call(client, "repos_detail", { repo: "livedemo" });
    const d = parsed(r);
    expect(d.node).toBe("test-node");
    expect(d.brief).toBe("Livedemo is on main with 1 uncommitted file, no remote at all.");
    expect(d.dirty.files).toEqual([{ status: "untracked", path: "b.txt" }]);
    expect(d.lastCommit.subject).toBe("first");
    const missing = await call(client, "repos_detail", { repo: "/etc" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("No indexed repo");
    const ghost = await call(client, "repos_detail", { repo: "lonely" });
    expect(ghost.isError).toBe(true); // indexed, but the directory is gone
    expect((await call(client, "repos_detail", { repo: "x", node: "nowhere" })).content[0].text).toContain("No paired node");
    await client.close();
  }, 30_000);

  test("GET /api/repos/detail serves a peer's repos_detail and only for indexed repos", async () => {
    const ok = await srv.api(`/api/repos/detail?repo=${encodeURIComponent(LIVE_REPO)}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).branch).toBe("main");
    const no = await srv.api("/api/repos/detail?repo=/no/such-repo-zz");
    expect(no.status).toBe(404);
    expect((await no.json()).error).toContain("No indexed repo");
  }, 30_000);

  test("sessions_search returns resume hints and a brief", async () => {
    const client = await connect(srv.base);
    const r = parsed(await call(client, "sessions_search", { query: "abc" }));
    expect(r.total).toBe(1);
    expect(r.items[0].resume).toEqual({ host: "test-node", command: "cd /tmp && claude --resume abc" });
    expect(r.brief).toStartWith("One session matches; the newest is Claude Code on test-node");
    expect(parsed(await call(client, "sessions_search", { tool: "cx" })).total).toBe(0);
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
    expect(r).toEqual({ brief: "result.md of run nope is empty so far.", id: "nope", file: "result.md", text: "", size: 0 });
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

describe("read_document", () => {
  test("reads a document as text from the gateway, by address, URL, or the newest matching query, and says what it is in brief", async () => {
    const client = await connect(srv.base);
    gatewayHits.length = 0;
    const raw = await call(client, "read_document", { ref: "hm://z6MkOwner/notes/yacht-sync" });
    const r = parsed(raw);
    expect(new URL(`http://x${gatewayHits[0]}`).pathname).toBe("/api/Resource");
    expect(r.document).toMatchObject({
      title: "Desktop sync failure on yacht", summary: "Two daemons shared one identity", hm: "hm://z6MkOwner/notes/yacht-sync", path: "notes/yacht-sync",
      url: `http://127.0.0.1:${gateway.port}/hm/z6MkOwner/notes/yacht-sync`, updated: "2026-09-02T12:00:00.000Z", authors: ["z6MkOwner"], version: "bafyv1",
      headings: ["What happened", "Fix"], truncated: false,
    });
    expect(r.document.text).toBe([
      "Two Seed daemons on yacht shared one libp2p identity.",
      "# What happened",
      "The desktop app and the dev daemon both loaded the same key.",
      "```sh\nlsof -i :58001\n```",
      "# Fix",
      "1. Stop the dev daemon.\n\n2. Give it its own data dir.",
      "[image: the two processes]",
    ].join("\n\n"));
    expect(r.document.words).toBe(41);
    expect(r.brief).toBe('"Desktop sync failure on yacht", published on 2026-09-02, 41 words in 2 sections: Two daemons shared one identity');
    // The same document by its web URL and by uid/path; a cut-down read says so.
    const byUrl = parsed(await call(client, "read_document", { ref: `http://127.0.0.1:${gateway.port}/hm/z6MkOwner/notes/yacht-sync?v=1#abc` }));
    expect(byUrl.document.hm).toBe("hm://z6MkOwner/notes/yacht-sync");
    const short = parsed(await call(client, "read_document", { ref: "z6MkOwner/notes/yacht-sync", maxChars: 200 }));
    expect(short.document.truncated).toBe(true);
    expect(short.document.text).toMatch(/\[\.\.\. \d+ more characters\]$/);
    expect(short.document.headings).toEqual(["What happened", "Fix"]);
    // No ref: the owner's newest document (Query, then Resource); with a query, the newest match; the brief carries the pointers.
    gatewayHits.length = 0;
    const newest = await call(client, "read_document", { brief: true });
    expect(gatewayHits.map((h) => new URL(`http://x${h}`).pathname)).toEqual(["/api/Query", "/api/Resource"]);
    expect(newest.content[0]?.text).toBe('"Desktop sync failure on yacht", published on 2026-09-02, 41 words in 2 sections: Two daemons shared one identity');
    expect(newest.structuredContent).toMatchObject({ title: "Desktop sync failure on yacht", hm: "hm://z6MkOwner/notes/yacht-sync", words: 41, headings: ["What happened", "Fix"], truncated: false });
    const none = await call(client, "read_document", { query: "nothing like this", brief: true });
    expect(none.content[0]?.text).toBe('No published document matches "nothing like this".');
    // Not a document, not on the gateway, not an address: readable failures.
    const comment = await call(client, "read_document", { ref: "hm://z6MkOwner/hm26" });
    expect(comment.isError).toBe(true);
    expect(comment.content[0]?.text).toContain("is a comment, not a document");
    const missing = await call(client, "read_document", { ref: "hm://z6MkOwner/notes/none" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("has no document at hm://z6MkOwner/notes/none");
    const junk = await call(client, "read_document", { ref: "https://example.com/not-seed" });
    expect(junk.isError).toBe(true);
    expect(junk.content[0]?.text).toContain("is not a Seed document address");
    await client.close();
  });
});

describe("documents", () => {
  test("lists the owner's published documents from the gateway, newest publish first, filters by words, and says when the newest was published", async () => {
    const client = await connect(srv.base);
    gatewayHits.length = 0;
    const r = parsed(await call(client, "documents", {}));
    expect(r.account).toBe("z6MkOwner");
    expect(r.documents.map((d: { title: string }) => d.title)).toEqual(["Desktop sync failure on yacht", "Clipper bootstrap guide", "hm26"]);
    expect(r.documents[0]).toMatchObject({
      url: `http://127.0.0.1:${gateway.port}/hm/z6MkOwner/notes/yacht-sync`, hm: "hm://z6MkOwner/notes/yacht-sync", path: "notes/yacht-sync",
      summary: "Two daemons shared one identity", visibility: "PUBLIC",
    });
    expect(r.brief).toBe('The newest document is "Desktop sync failure on yacht", published yesterday; before it "Clipper bootstrap guide", published 9 days ago.');
    const hit = new URL(`http://x${gatewayHits[0]}`);
    expect(hit.pathname).toBe("/api/Query");
    expect(JSON.parse(hit.searchParams.get("includes")!)).toEqual([{ space: "z6MkOwner", mode: "AllDescendants" }]);
    expect(JSON.parse(hit.searchParams.get("sort")!)).toEqual([{ term: "updated", reverse: true }]);
    expect(hit.searchParams.get("limit")).toBe("5");
    const q = parsed(await call(client, "documents", { query: "clipper guide", limit: 2 }));
    expect(q.documents.map((d: { title: string }) => d.title)).toEqual(["Clipper bootstrap guide"]);
    expect(q.brief).toBe('1 document matches "clipper guide": the newest is "Clipper bootstrap guide", published 9 days ago.');
    expect(new URL(`http://x${gatewayHits.at(-1)}`).searchParams.get("limit")).toBe("60");
    const none = await call(client, "documents", { query: "nothing like this", brief: true });
    expect(none.content[0].text).toBe('No published document matches "nothing like this".');
    const brief = await call(client, "documents", { brief: true, limit: 1 });
    expect(brief.content[0].text).toBe('The newest document is "Desktop sync failure on yacht", published yesterday.');
    expect(brief.structuredContent).toMatchObject({ account: "z6MkOwner", count: 1, title: "Desktop sync failure on yacht", hm: "hm://z6MkOwner/notes/yacht-sync" });
    const other = parsed(await call(client, "documents", { account: "hm://z6MkEmpty/whatever" }));
    expect(other).toMatchObject({ account: "z6MkEmpty", documents: [] });
    expect(other.brief).toBe("No published documents were found for that account.");
    await client.close();
    // A node without an owner account says what to configure; a node whose gateway is not a Seed site says so.
    const c2 = await connect(bare.base);
    const unset = await call(c2, "documents", {});
    expect(unset.isError).toBe(true);
    expect(unset.content[0].text).toContain("seed.ownerAccount");
    await c2.close();
    const odd = startTestServer(testConfig({ fleetDir: null, nodeName: "odd", seed: { ownerAccount: "z6MkOwner", gatewayUrl: `http://127.0.0.1:${gateway.port}/nope` } }));
    try {
      const c3 = await connect(odd.base);
      const bad = await call(c3, "documents", {});
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain("answered 404");
      await c3.close();
    } finally { odd.stop(); }
  });
});

describe("mcp brief mode", () => {
  const sentence = (r: ToolResult) => {
    const t = r.content[0]?.text ?? "";
    expect(r.isError).toBeFalsy();
    expect(t).not.toContain("\n");
    expect(t.startsWith("{")).toBe(false);
    expect(t.length).toBeGreaterThan(10);
    expect(t.length).toBeLessThan(400);
    expect((r.structuredContent as any).brief).toBe(t);
    return t;
  };

  test("every tool accepts brief", async () => {
    const client = await connect(srv.base);
    const { tools } = await client.listTools();
    for (const t of tools) expect((t.inputSchema as any).properties?.brief?.type, t.name).toBe("boolean");
    await client.close();
  });

  test("read tools answer with one spoken sentence and the key numbers", async () => {
    const client = await connect(srv.base);
    expect(sentence(await call(client, "status", { brief: true }))).toContain("test-node runs Cyberdeck");
    const fleet = await call(client, "fleet_status", { brief: true });
    expect(sentence(fleet)).toContain("2 of 2 hosts online");
    expect((fleet.structuredContent as any).hostsOnline).toBe(2);
    expect(sentence(await call(client, "hosts", { brief: true }))).toBe("The fleet manifest lists 3 hosts: test-node (laptop), other (server), phone (phone).");
    expect(sentence(await call(client, "projects", { brief: true }))).toBe("1 project, 1 active: Demo.");
    const todo = await call(client, "todo", { brief: true });
    expect(sentence(todo)).toBe("2 handoff entries in 2 sections; the newest, from 2026-10-07, says: Demo thing; the oldest, from 2026-09-15, says: Old thing nobody did");
    expect(todo.structuredContent).toMatchObject({ entries: 2, sections: 2, newest: "2026-10-07", oldest: "2026-09-15" });
    expect(sentence(await call(client, "todo", { brief: true, query: "demo" }))).toBe("1 handoff entry mention \"demo\" in 1 section; the newest, from 2026-10-07, says: Demo thing");
    expect(sentence(await call(client, "todo", { brief: true, query: "nothing-like-this" }))).toContain("no entries");
    expect(sentence(await call(client, "handoff", { brief: true }))).toBe("1 agent note: cc on test-node.");
    expect(sentence(await call(client, "sessions", { brief: true }))).toMatch(/^1 session; the newest is (Claude Code|Codex) on /);
    const repos = await call(client, "repos", { brief: true });
    expect(sentence(repos)).toBe("test-node has 2 repos at risk: 1 with unpushed commits (Livedemo), 2 with no remote (lonely, Livedemo).");
    expect((repos.structuredContent as any).total).toBe(2);
    expect(sentence(await call(client, "repos", { kind: "unpushed", brief: true }))).toBe("test-node has 1 repos at risk with unpushed commits, such as Livedemo.");
    expect(sentence(await call(client, "repos", { risk: "safe", brief: true }))).toBe("test-node has 1 safe repos, such as fine.");
    expect(sentence(await call(client, "repos_detail", { repo: "Livedemo", brief: true }))).toContain("Livedemo");
    expect(sentence(await call(client, "sessions_search", { query: "zzz-none", brief: true }))).toContain("No cc or cx sessions match");
    const services = await call(client, "services", { probe: true, brief: true });
    expect(sentence(services)).toContain("3 services checked, 1 down: web-api on other.");
    expect((services.structuredContent as any).down).toEqual(["web-api on other"]);
    expect(sentence(await call(client, "collab_tasks", { brief: true }))).toContain("collab task");
    expect(sentence(await call(client, "scan", { brief: true }))).toMatch(/^(Rescan started on test-node|test-node is already scanning)/);
    // no node in the test fleet has a kiosk screen: the tool says so instead of failing
    const media = await call(client, "media", { brief: true });
    expect(sentence(media)).toBe("No fleet screen is configured (none of test-node has a kiosk).");
    expect((media.structuredContent as any).ok).toBe(false);
    await client.close();
  });

  test("media asks a named peer's screen over the fleet pairing and names unknown hosts", async () => {
    srv.db.query("INSERT INTO nodes (id, name, url, token, added_at) VALUES (?, ?, ?, ?, ?)").run("n-bare-m", "bare", bare.base, TEST_TOKEN, Date.now());
    const client = await connect(srv.base);
    try {
      const r = parsed(await call(client, "media", { host: "bare", action: "pause" }));
      expect(r).toMatchObject({ ok: false, screens: [{ name: "bare", noScreen: true }] });
      expect(r.brief).toBe("No fleet screen is configured (none of bare has a kiosk).");
      const unknown = await call(client, "media", { host: "nowhere" });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0].text).toContain("No paired node is called nowhere");
      const all = parsed(await call(client, "media"));
      expect(all.screens.map((s: any) => s.name)).toEqual(["test-node", "bare"]);
    } finally {
      srv.db.query("DELETE FROM nodes WHERE id = 'n-bare-m'").run();
      await client.close();
    }
  });

  test("full answers still carry the data, with the sentence first", async () => {
    const client = await connect(srv.base);
    const status = parsed(await call(client, "status"));
    expect(Object.keys(status)[0]).toBe("brief");
    expect(status.node.nodeName).toBe("test-node");
    expect(parsed(await call(client, "hosts")).length).toBe(3);
    const services = parsed(await call(client, "services"));
    expect(services.brief).toContain("1 down");
    expect(services.rows.length).toBe(3);
    await client.close();
  });

  test("write tools say what they did", async () => {
    const client = await connect(srv.base);
    expect(sentence(await call(client, "todo_add", { text: "**Brief** check", brief: true }))).toBe("Added to the handoff list under Open: Brief check");
    expect(sentence(await call(client, "todo_done", { match: "Demo", brief: true }))).toBe("Removed from the handoff list: 2026-10-07 Demo thing");
    expect(sentence(await call(client, "handoff_note", { host: "other", text: "checked", brief: true }))).toBe("Recorded on other's handoff note (handoff/other-seed.md).");
    expect(sentence(await call(client, "note", { text: "hello **there**", brief: true }))).toBe("Noted in the inbox: hello there");
    // listen writes a control notice on this daemon's own Seed bridge; a live Desk or iPad call polls it.
    const before = await (await fetch(`${srv.base}/api/voice/control`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } })).json();
    expect(sentence(await call(client, "listen", { action: "mute", brief: true }))).toBe("Muted; I stop listening until you unmute.");
    expect(parsed(await call(client, "listen", { action: "hangup" }))).toMatchObject({ action: "hangup", notice: { text: "Call ended at your request.", control: { action: "hangup" } } });
    const pending = await (await fetch(`${srv.base}/api/voice/control?since=${before.now - 1}`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } })).json();
    expect(pending.controls.map((n: any) => n.control.action)).toEqual(["mute", "hangup"]);
    // announce writes to this daemon's own Seed bridge (no agents server needed): the Desk transcript shows it.
    expect(sentence(await call(client, "announce", { title: "Check the **backups**", status: "succeeded", runId: "r1", sessionId: "s1", brief: true }))).toBe('Announced on the Desk: Done: "Check the backups" finished.');
    expect(parsed(await call(client, "announce", { text: "Enuc is back.", runId: "r2", sessionId: "s2" }))).toMatchObject({ announced: true, notice: { text: "Enuc is back.", run: { id: "r2", sessionId: "s2" } } });
    expect(parsed(await call(client, "announce", { title: "Await step", status: "succeeded", runId: "r3" }))).toMatchObject({ announced: false, reason: expect.stringMatching(/no session/) });
    const logs = await call(client, "service_logs", { host: "test-node", name: "x", lines: 5, brief: true });
    expect(sentence(logs)).toMatch(/^(The last 5 lines of x on test-node end with: |x on test-node has no log lines\.|Could not read the log of x on test-node)/);
    await client.close();
  });
});

// ---- node tools: the reach a terminal agent has, through the same server (src/daemon/api/mcp-node.ts) ----
describe("node tools", () => {
  const NODE_DIR = join(SCRATCH, "node-tools");
  beforeAll(() => {
    process.env.CYBERDECK_TOOL_OUTPUT_DIR = join(SCRATCH, "tool-output");
    Bun.spawnSync(["mkdir", "-p", join(NODE_DIR, "src"), join(NODE_DIR, "node_modules", "dep")]);
    writeFileSync(join(NODE_DIR, "src", "a.ts"), "const a = 1;\nconst b = 2;\nexport const sum = a + b;\n");
    writeFileSync(join(NODE_DIR, "node_modules", "dep", "index.js"), "const a = 1;\n");
    writeFileSync(join(NODE_DIR, "README.md"), "# node tools\n");
  });

  test("the tools are listed on a full node and withheld when config turns them off", async () => {
    const client = await connect(srv.base);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["shell", "open_url", "read_file", "write_file", "edit_file", "list_dir", "grep", "deck_context"]) expect(names).toContain(n);
    await client.close();
    const off = startTestServer(testConfig({ fleetDir: FLEET_STUB, nodeName: "quiet", mcp: { nodeTools: false } }));
    try {
      const c2 = await connect(off.base);
      const quiet = (await c2.listTools()).tools.map((t) => t.name);
      expect(quiet).toContain("status");
      expect(quiet).not.toContain("shell");
      expect(quiet).not.toContain("open_url");
      expect(quiet).not.toContain("read_file");
      await c2.close();
    } finally { off.stop(); }
  });

  test("shell runs in cwd through a login shell, reports the exit code, bounds long output to a file, and times out", async () => {
    // (long: three real shell runs plus a deliberate timeout)
    const client = await connect(srv.base);
    const r = parsed(await call(client, "shell", { command: "pwd; printf 'a\\nb\\n'; echo err 1>&2; exit 3", cwd: NODE_DIR }));
    expect(r).toMatchObject({ host: "test-node", cwd: NODE_DIR, code: 3, timedOut: false, truncated: false });
    expect(r.stdout.replace(/^\/private/, "")).toBe(`${NODE_DIR.replace(/^\/private/, "")}\na\nb\n`);
    expect(r.stderr).toBe("err\n");
    expect(r.brief).toContain("exit 3");
    const long = parsed(await call(client, "shell", { command: "seq 1 5000", cwd: "~" }));
    expect(long.code).toBe(0);
    expect(long.truncated).toBe(true);
    expect(long.stdout.trimEnd().endsWith("5000")).toBe(true);
    expect(long.stdout).toContain("characters dropped from the start");
    expect(existsSync(long.outputFile)).toBe(true);
    expect(readFileSync(long.outputFile, "utf8").split("\n").length).toBeGreaterThan(4999);
    const head = parsed(await call(client, "shell", { command: "seq 1 5000", keep: "head" }));
    expect(head.stdout.startsWith("1\n2\n")).toBe(true);
    const t0 = Date.now();
    const slow = parsed(await call(client, "shell", { command: "sleep 20; echo late", timeoutSec: 1 }));
    expect(slow).toMatchObject({ timedOut: true, code: null });
    expect(slow.stdout).toBe("");
    expect(Date.now() - t0).toBeLessThan(6000);
    const missing = parsed(await call(client, "shell", { command: "true", cwd: join(NODE_DIR, "nope") }));
    expect(missing.code).toBe(97);
    expect(missing.brief).toContain("could not cd");
    expect((await call(client, "shell", { command: "echo hi", brief: true })).content[0].text).toContain("exit 0");
    const audit = readFileSync(process.env.CYBERDECK_AUDIT_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.filter((e) => e.tool === "shell").at(-1)).toMatchObject({ by: "mcp", host: "test-node", command: "echo hi" });
    await client.close();
  }, 30_000);

  test("open_url opens through the opener here, over ssh on a manifest host, and refuses anything but web pages and hm documents", async () => {
    const client = await connect(srv.base);
    const here = parsed(await call(client, "open_url", { url: "https://hyper.media/hm/z6MkOwner/notes/yacht-sync" }));
    expect(here).toMatchObject({ host: "test-node", ok: true, code: 0, url: "https://hyper.media/hm/z6MkOwner/notes/yacht-sync" });
    expect(here.brief).toBe("Opened yacht-sync on hyper.media in the browser on test-node.");
    const remote = parsed(await call(client, "open_url", { url: "https://example.com/", host: "other" }));
    expect(remote).toMatchObject({ host: "other", ok: true });
    expect(remote.brief).toBe("Opened example.com in the browser on other.");
    const sshLog = readFileSync(SSH_LOG, "utf8");
    expect(sshLog).toContain("other-alias");
    // The remote machine decides its opener (the CYBERDECK_OPENER override is local only), from its home directory.
    expect(sshLog).toContain("cd ~ || exit 97");
    expect(sshLog).toContain("open \"$u\"");
    expect(sshLog).toContain("'https://example.com/'");
    expect(sshLog).not.toContain("echo opened '\\''https://example.com");
    const hm = parsed(await call(client, "open_url", { url: "hm://z6MkOwner/notes/yacht-sync", brief: true }));
    expect(hm.brief).toBe("Opened the Seed document yacht-sync in the browser on test-node.");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "not a url", "https://", "ftp://x.example/a"]) {
      expect((await call(client, "open_url", { url: bad })).isError).toBe(true);
    }
    expect((await call(client, "open_url", { url: "https://example.com", host: "nowhere" })).isError).toBe(true);
    expect((await call(client, "open_url", { url: "https://example.com", host: "phone" })).content[0].text).toContain("no ssh alias");
    const audit = readFileSync(process.env.CYBERDECK_AUDIT_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.tool === "open_url");
    expect(audit.map((e) => [e.host, e.url])).toEqual([
      ["test-node", "https://hyper.media/hm/z6MkOwner/notes/yacht-sync"],
      ["other", "https://example.com/"],
      ["test-node", "hm://z6MkOwner/notes/yacht-sync"],
    ]);
    await client.close();
  }, 20_000);

  test("shell on a manifest host goes over ssh; unknown hosts and hosts without an alias are refused", async () => {
    const client = await connect(srv.base);
    const remote = parsed(await call(client, "shell", { command: "uptime", host: "other", cwd: "/srv" }));
    expect(remote).toMatchObject({ host: "other", cwd: "/srv", code: 0 });
    expect(remote.stdout).toContain("stub log line from other-alias");
    expect((await call(client, "shell", { command: "uptime", host: "nowhere" })).isError).toBe(true);
    expect((await call(client, "shell", { command: "uptime", host: "phone" })).content[0].text).toContain("no ssh alias");
    const same = parsed(await call(client, "shell", { command: "echo local", host: "test-node" }));
    expect(same.stdout).toBe("local\n");
    await client.close();
  });

  test("read_file pages with offset and limit; write_file and edit_file change files and are audited", async () => {
    const client = await connect(srv.base);
    const file = join(NODE_DIR, "src", "a.ts");
    const r = parsed(await call(client, "read_file", { path: file, offset: 2, limit: 1 }));
    expect(r).toMatchObject({ path: file, totalLines: 3, offset: 2, returned: 1, nextOffset: 3 });
    expect(r.content).toBe("     2\tconst b = 2;");
    const all = parsed(await call(client, "read_file", { path: file }));
    expect(all.nextOffset).toBeUndefined();
    expect(all.content.split("\n")).toHaveLength(3);
    expect((await call(client, "read_file", { path: join(NODE_DIR, "missing.txt") })).isError).toBe(true);
    expect((await call(client, "read_file", { path: NODE_DIR })).content[0].text).toContain("list_dir");
    const made = parsed(await call(client, "write_file", { path: join(NODE_DIR, "new", "note.md"), content: "hello\nworld\n" }));
    expect(made).toMatchObject({ existed: false, bytes: 12 });
    expect(readFileSync(join(NODE_DIR, "new", "note.md"), "utf8")).toBe("hello\nworld\n");
    const edited = parsed(await call(client, "edit_file", { path: join(NODE_DIR, "new", "note.md"), old: "world", new: "fleet" }));
    expect(edited).toMatchObject({ replaced: 1, line: 2 });
    expect(readFileSync(join(NODE_DIR, "new", "note.md"), "utf8")).toBe("hello\nfleet\n");
    expect((await call(client, "edit_file", { path: join(NODE_DIR, "new", "note.md"), old: "nope", new: "x" })).content[0].text).toContain("not found");
    writeFileSync(join(NODE_DIR, "new", "dup.txt"), "x x x\n");
    expect((await call(client, "edit_file", { path: join(NODE_DIR, "new", "dup.txt"), old: "x", new: "y" })).content[0].text).toContain("occurs 3 times");
    expect(parsed(await call(client, "edit_file", { path: join(NODE_DIR, "new", "dup.txt"), old: "x", new: "y", replaceAll: true })).replaced).toBe(3);
    expect(readFileSync(join(NODE_DIR, "new", "dup.txt"), "utf8")).toBe("y y y\n");
    const audit = readFileSync(process.env.CYBERDECK_AUDIT_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.some((e) => e.tool === "write_file" && e.path === join(NODE_DIR, "new", "note.md"))).toBe(true);
    expect(audit.some((e) => e.tool === "edit_file" && e.replaced === 3)).toBe(true);
    expect(expandPath("~/x/y")).toBe(join(homedir(), "x", "y"));
    expect(expandPath("~")).toBe(homedir());
    expect(expandPath("/abs/p")).toBe("/abs/p");
    await client.close();
  });

  test("list_dir walks to a depth without junk dirs; grep finds matches and skips node_modules", async () => {
    const client = await connect(srv.base);
    const one = parsed(await call(client, "list_dir", { path: NODE_DIR }));
    expect(one.entries.map((e: any) => e.path)).toEqual(expect.arrayContaining(["src/", "node_modules/", "README.md"]));
    expect(one.entries.find((e: any) => e.path === "README.md").size).toBe(13);
    const deep = parsed(await call(client, "list_dir", { path: NODE_DIR, depth: 3 }));
    const paths = deep.entries.map((e: any) => e.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("node_modules/dep/");
    expect((await call(client, "list_dir", { path: join(NODE_DIR, "README.md") })).content[0].text).toContain("read_file");
    const g = parsed(await call(client, "grep", { pattern: "const a = 1", path: NODE_DIR }));
    expect(g.matches).toBe(1);
    expect(g.results).toContain("src/a.ts:1:const a = 1;");
    expect(g.results).not.toContain("node_modules");
    const ts = parsed(await call(client, "grep", { pattern: "CONST", path: NODE_DIR, glob: "*.ts", ignoreCase: true, limit: 1 }));
    expect(ts.matches).toBe(1);
    expect(ts.truncated).toBe(true);
    expect(parsed(await call(client, "grep", { pattern: "zzz-not-here", path: NODE_DIR })).matches).toBe(0);
    await client.close();
  });

  test("deck_context is the deck briefing; a node without a Deck checkout says so", async () => {
    const client = await connect(srv.base);
    const r = parsed(await call(client, "deck_context", { dir: "~/Code/demo" }));
    expect(r.context).toContain("host: test-node");
    expect(r.context).toContain("project: demo");
    expect(r.brief).toContain("Deck context: host: test-node");
    const noDir = parsed(await call(client, "deck_context", {}));
    expect(noDir.dir).toBeNull();
    await client.close();
    const c2 = await connect(bare.base);
    const b = await call(c2, "deck_context", {});
    expect(b.isError).toBe(true);
    expect(b.content[0].text).toContain("no Deck checkout");
    expect(parsed(await call(c2, "shell", { command: "echo still-works" })).stdout).toBe("still-works\n");
    await c2.close();
  });
});

test("delegate without a Seed bridge set up fails fast with the setup hint", async () => {
  const client = await connect(srv.base);
  const d = await call(client, "delegate", { task: "Check every host and tell me what is down.", title: "Fleet check" });
  expect(d.isError).toBe(true);
  expect(d.content[0]?.text).toMatch(/delegate failed: Seed is not set up on this node .*cyberdeck seed setup/);
  const dr = await call(client, "delegate_result", { sessionId: "nope" });
  expect(dr.isError).toBe(true);
  expect(dr.content[0]?.text).toMatch(/no delegated sessions yet/);
}, 30_000);
