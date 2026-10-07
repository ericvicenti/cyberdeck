// MCP server: Cyberdeck as a tool server for Seed Agents (and any other MCP client).
//
// Seed Agents is an MCP client for remote Streamable HTTP servers with static auth headers
// (hypermedia/agent/mcp.md in the Seed repo). This module mounts one at POST /api/mcp, behind
// the same bearer-token / tailscale-identity gate as every other /api route, and exposes the
// deck as tools: node status and repo risk from the indexer, hosts / projects / handoff /
// sessions / services from the Deck repo through the control module, and the cc/cx collab
// queue so a Seed agent can delegate work to a laptop agent and read the result.
//
// Stateless: every POST gets a fresh McpServer + transport (the documented pattern for a
// server with no per-session state), so a node restart never strands a client session.
// Tool names stay short because Seed prefixes them with the server name (`cyberdeck__status`).
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { CyberdeckConfig } from "../config";
import type { RepoRow } from "../db";
import type { NodeStatus } from "../status";
import type { Control } from "./control";
import { peerFetch, type NodeRow } from "./fleet";
import { runScan, isScanRunning } from "../indexer/scan";

export const MCP_PATH = "/api/mcp";
export const MCP_SERVER_NAME = "cyberdeck";

/** How many repo rows a single `repos` answer may carry (Seed bounds a tool result at 256 KiB). */
const REPOS_DEFAULT_LIMIT = 50;
const REPOS_MAX_LIMIT = 500;
const LOG_DEFAULT_TAIL = 20_000;

const INSTRUCTIONS = `Cyberdeck is the daemon on each of the owner's machines (laptops and servers). It indexes ~/Code,
scores every git repo's risk (dirty, unpushed, remote-less), pairs with the other nodes, and reads the
owner's private Deck repo: the fleet manifest (hosts and the services they must run), the project tree,
the running handoff (TODO) that every coding agent (cc = Claude Code, cx = Codex) maintains, the
cross-host index of those agents' sessions, and the collab queue through which a task is handed to cc
or cx on a given host and reviewed by the other.

Start with \`status\` (this node and its peers) or \`fleet_status\` (every host, online or not). Use
\`todo\` and \`handoff\` to learn what is in flight before proposing work. Use \`repos\` to find
uncommitted or unpushed work. Queue work for a laptop agent with \`collab_add\`, start it with
\`collab_run\`, and read its result with \`run_log\`. \`note\` drops a line into the owner's inbox that
every agent reads at session start. All times are ISO 8601 or Unix milliseconds.`;

type RepoOut = Omit<RepoRow, "remotes" | "risk_reasons"> & { remotes: unknown; risk_reasons: unknown };

export type McpDeps = {
  /** The node summary behind GET /api/status. */
  status: () => NodeStatus;
  version: string;
};

function text(value: unknown): { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> } {
  const structured = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { items: value };
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}

function fail(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function parseRepo(r: RepoRow): RepoOut {
  const safe = (s: string) => { try { return JSON.parse(s); } catch { return []; } };
  return { ...r, remotes: safe(r.remotes), risk_reasons: safe(r.risk_reasons) };
}

/** Builds the tool set over this node's db and the control module. Exported so tests can list it. */
export function buildMcpServer(db: Database, cfg: CyberdeckConfig, control: Control, deps: McpDeps): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: deps.version }, { instructions: INSTRUCTIONS });
  const peers = (): NodeRow[] => db.query("SELECT * FROM nodes ORDER BY name").all() as NodeRow[];
  const needDeck = () => (control.fleetDir() ? null : fail("This node has no Deck checkout (config fleetDir), so hosts, projects, handoff, sessions, services and collab are unavailable here. Ask a laptop node."));

  server.tool(
    "status",
    "This Cyberdeck node (name, version, scan state, repo risk counts, reclaimable junk) and whether each paired node is reachable right now.",
    {},
    async () => {
      const self = deps.status();
      const nodes = await Promise.all(
        peers().map(async (n) => {
          try {
            const res = await peerFetch(n, "/api/status", { signal: AbortSignal.timeout(3000) });
            if (!res.ok) throw new Error(String(res.status));
            const s = (await res.json()) as NodeStatus;
            return { name: n.name, url: n.url, online: true, version: s.version, commit: s.commit, repos: s.repos, atRisk: s.atRisk, attention: s.attention, lastScanAt: s.lastScanAt };
          } catch {
            return { name: n.name, url: n.url, online: false, lastSeen: n.last_seen };
          }
        })
      );
      return text({ node: self, peers: nodes });
    }
  );

  server.tool(
    "fleet_status",
    "Every host in the Deck manifest (laptops, servers, phone) with whether it is online on the tailnet, plus the Deck repo's sync state and how many handoff entries are open.",
    {},
    async () => needDeck() ?? text(await control.cached("status", ["status", "--json"], null))
  );

  server.tool(
    "hosts",
    "The fleet manifest: each host's kind, OS, ssh alias, tailnet name, roles, which agents (cc/cx) it runs, its Cyberdeck URL, and the services it must keep running.",
    {},
    async () => needDeck() ?? text(await control.cached("hosts", ["hosts", "--json"], []))
  );

  server.tool(
    "projects",
    "The project tree from the Deck repo (name, status, repos, hosts where its work happens, links, description). With `dir`, only the project that owns that directory.",
    { dir: z.string().optional().describe("Absolute directory; returns the project whose repos cover it, or null") },
    async ({ dir }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      if (dir) {
        const r = await control.cli(["projects", "--for", dir, "--json"]);
        return text(r ? parseLast(r.out) : null);
      }
      return text(await control.cached("projects", ["projects", "--json"], []));
    }
  );

  server.tool(
    "todo",
    "The running handoff (handoff/TODO.md): dated entries of unfinished work across every host and repo, grouped by section. `query` filters entries by substring.",
    { query: z.string().optional().describe("Case-insensitive substring to keep only matching entries") },
    async ({ query }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const todo = await control.cached<{ sections: { title: string; entries: { date: string; text: string }[] }[] }>("todo", ["todo", "--json"], { sections: [] });
      if (!query) return text(todo);
      const q = query.toLowerCase();
      return text({ sections: todo.sections.map((s) => ({ ...s, entries: s.entries.filter((e) => e.text.toLowerCase().includes(q)) })).filter((s) => s.entries.length) });
    }
  );

  server.tool(
    "handoff",
    "Each coding agent's own note (handoff/<host>-<agent>.md): what cc and cx on each laptop were last doing and what not to duplicate.",
    {},
    async () => needDeck() ?? text(await control.cached("handoff", ["handoff", "--json"], []))
  );

  server.tool(
    "sessions",
    "Search the cross-host index of cc and cx sessions (title, cwd, project, branch, times, transcript path). Any host, including offline ones.",
    {
      query: z.string().optional().describe("Words to match in session titles"),
      host: z.string().optional().describe("Only sessions on this host"),
      tool: z.enum(["cc", "cx"]).optional().describe("Only Claude Code (cc) or Codex (cx) sessions"),
    },
    async ({ query, host, tool }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const args = ["sessions", "--json"];
      if (host) args.push("--host", host);
      if (tool) args.push("--tool", tool);
      if (query) args.push(query);
      const r = await control.cli(args);
      return text(r ? parseLast(r.out) ?? [] : []);
    }
  );

  server.tool(
    "repos",
    "Git repos this node (or a paired node) indexed under its roots, with risk: at-risk = work that exists nowhere else (remote-less or unpushed), attention = dirty/stashed/behind, safe. `ahead` counts commits on any local branch that no remote has.",
    {
      risk: z.enum(["at-risk", "attention", "safe", "all"]).default("at-risk").describe("Which risk class to list; default at-risk"),
      node: z.string().optional().describe("Name of a paired node to ask instead of this one"),
      query: z.string().optional().describe("Substring of the repo path"),
      limit: z.number().int().min(1).max(REPOS_MAX_LIMIT).default(REPOS_DEFAULT_LIMIT),
    },
    async ({ risk, node, query, limit }) => {
      let rows: RepoOut[];
      if (node && node.toLowerCase() !== cfg.nodeName.toLowerCase()) {
        const peer = peers().find((n) => n.name.toLowerCase() === node.toLowerCase());
        if (!peer) return fail(`No paired node named "${node}". Paired: ${peers().map((n) => n.name).join(", ") || "none"}.`);
        try {
          const res = await peerFetch(peer, "/api/repos", { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return fail(`${peer.name} answered ${res.status}`);
          rows = (await res.json()) as RepoOut[];
        } catch (err) {
          return fail(`${peer.name} is unreachable: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        rows = (db.query("SELECT * FROM repos ORDER BY path").all() as RepoRow[]).map(parseRepo);
      }
      const q = query?.toLowerCase();
      const filtered = rows.filter((r) => (risk === "all" || r.risk === risk) && (!q || r.path.toLowerCase().includes(q)));
      return text({ node: node ?? cfg.nodeName, risk, total: filtered.length, items: filtered.slice(0, limit) });
    }
  );

  server.tool(
    "services",
    "The last probe of every expected service on every reachable host (state, ok, error). `probe: true` runs a fresh probe first (up to a minute).",
    { probe: z.boolean().default(false) },
    async ({ probe }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      if (probe) {
        const r = await Promise.race([control.probe(), new Promise<null>((res) => setTimeout(() => res(null), 60_000))]);
        return text(r ?? control.lastProbe() ?? { probedAt: null, rows: [], error: "probe did not finish in time" });
      }
      return text(control.lastProbe() ?? { probedAt: null, rows: [], note: "no probe yet; call with probe: true" });
    }
  );

  server.tool(
    "collab_tasks",
    "The collab queue: tasks handed to cc or cx on a host (open, running, review, done) and the runs that executed them, newest first.",
    {},
    async () => {
      const blocked = needDeck(); if (blocked) return blocked;
      const [tasks, runs] = await Promise.all([control.tasks(), control.runs()]);
      return text({ tasks, runs });
    }
  );

  server.tool(
    "collab_add",
    "Queue a task for a laptop coding agent. The worker (cx by default) does the work on the named host and the other agent reviews it. Returns the task id; start it with collab_run.",
    {
      title: z.string().min(1).describe("One-line title"),
      project: z.string().optional().describe("Project slug from `projects`"),
      host: z.string().optional().describe("Host to run on (must have the agents, see `hosts`)"),
      worker: z.enum(["cc", "cx"]).optional().describe("Which agent does the work; the other reviews"),
      body: z.string().optional().describe("The full task description the worker reads"),
    },
    async ({ title, project, host, worker, body }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const args = ["collab", "add", "--title", title];
      if (project) args.push("--project", project);
      if (host) args.push("--host", host);
      if (worker) args.push("--worker", worker);
      if (body) args.push("--body", body);
      const r = await control.cli(args);
      control.invalidate("collab.tasks");
      if (!r || r.code !== 0) return fail(`deck collab add failed: ${(r?.err ?? "").trim() || "no output"}`);
      const id = r.out.trim().split("\n").pop() ?? "";
      return text({ id, output: (r.out + r.err).trim() });
    }
  );

  server.tool(
    "collab_run",
    "Start a queued task now on this node (worker then reviewer, detached). Returns at once; poll collab_tasks and read run_log for progress.",
    { id: z.string().regex(/^[\w.-]+$/).describe("Task id from collab_add or collab_tasks") },
    async ({ id }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const active = (await control.runs()).some((r) => r.status === "running");
      if (active) return fail("A collab run is already in progress on this node; wait for it or read collab_tasks.");
      const r = control.startCollab(["collab", "run", id], id);
      return r ? text({ id, ...r }) : fail("could not start the run");
    }
  );

  server.tool(
    "run_log",
    "Tail of a collab run's log: worker.log (the agent doing the work), reviewer.log, or result.md (the summary).",
    {
      id: z.string().regex(/^[\w.-]+$/).describe("Run id from collab_tasks"),
      file: z.enum(["worker.log", "reviewer.log", "result.md"]).default("result.md"),
      tail: z.number().int().min(1000).max(2_000_000).default(LOG_DEFAULT_TAIL).describe("Bytes from the end"),
    },
    async ({ id, file, tail }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const r = control.runLog(id, file, tail);
      return r ? text({ id, file, ...r }) : fail("bad run id or file");
    }
  );

  server.tool(
    "note",
    "Append a dated line to the owner's inbox (notes/inbox.md in the Deck repo), which every agent reads at session start. Use it to leave a finding or a request for the owner.",
    { text: z.string().min(1).max(4000) },
    async ({ text: line }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const r = await control.cli(["note", line]);
      if (!r || r.code !== 0) return fail(`deck note failed: ${(r?.err ?? "").trim() || "no output"}`);
      return text({ ok: true });
    }
  );

  server.tool(
    "scan",
    "Rescan this node's roots for repos now (normally hourly plus on file changes). Returns at once; `status` shows scanning until it finishes.",
    {},
    async () => {
      if (!isScanRunning()) runScan(db, cfg).catch((err) => console.error("mcp scan error:", err));
      return text({ started: true, roots: cfg.roots });
    }
  );

  return server;
}

/** The last line of CLI output that parses as JSON (the CLI may print warnings first). */
function parseLast(out: string): unknown {
  for (const line of [out.trim(), ...out.trim().split("\n").reverse()]) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

export function registerMcpRoutes(app: Hono, db: Database, cfg: CyberdeckConfig, control: Control, deps: McpDeps) {
  app.post(MCP_PATH, async (c) => {
    const server = buildMcpServer(db, cfg, control, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(c.req.raw);
      // The response is fully buffered (JSON mode), so the pair can go now.
      void res.clone().arrayBuffer().finally(() => { void transport.close(); void server.close(); });
      return res;
    } catch (err) {
      void transport.close(); void server.close();
      return c.json({ jsonrpc: "2.0", error: { code: -32603, message: `mcp: ${err instanceof Error ? err.message : err}` }, id: null }, 500);
    }
  });
  // Stateless mode has no standalone event stream and no session to delete.
  app.get(MCP_PATH, (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless; POST JSON-RPC here" }, id: null }, 405));
  app.delete(MCP_PATH, (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: stateless server" }, id: null }, 405));
}
