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
import type { Control, ServiceProbe } from "./control";
import { peerFetch, type NodeRow } from "./fleet";
import { runScan, isScanRunning } from "../indexer/scan";
import { resolveService, serviceLogs, restartService, restartBudget, type ManifestHost, type ServiceTarget } from "../servicectl";
import { matchRepo, repoDetail, type RepoDetail } from "../repodetail";
import { registerNodeTools } from "./mcp-node";
import type { Kiosk } from "./kiosk";
import { MEDIA_ACTIONS, mediaSentence, type MediaState } from "../screenmedia";
import type { AnnounceInput, AnnounceResult, ControlAction, DelegateResult, DelegateStatus, Notice } from "../seed";

export const MCP_PATH = "/api/mcp";
export const MCP_SERVER_NAME = "cyberdeck";

/** How many repo rows a single `repos` answer may carry (Seed bounds a tool result at 256 KiB). */
const REPOS_DEFAULT_LIMIT = 50;
const REPOS_MAX_LIMIT = 500;
const LOG_DEFAULT_TAIL = 20_000;
const SESSIONS_DEFAULT_LIMIT = 8;

const INSTRUCTIONS = `Cyberdeck is the daemon on each of the owner's machines (laptops and servers). It indexes ~/Code,
scores every git repo's risk (dirty, unpushed, remote-less), pairs with the other nodes, and reads the
owner's private Deck repo: the fleet manifest (hosts and the services they must run), the project tree,
the running handoff (TODO) that every coding agent (cc = Claude Code, cx = Codex) maintains, the
cross-host index of those agents' sessions, and the collab queue through which a task is handed to cc
or cx on a given host and reviewed by the other.

Start with \`status\` (this node and its peers) or \`fleet_status\` (every host, online or not). Use
\`todo\` and \`handoff\` to learn what is in flight before proposing work. Use \`repos\` to find
uncommitted or unpushed work and \`repos_detail\` to look inside one repo (it starts with a \`brief\` sentence
you can say as-is). \`sessions_search\` finds a past cc/cx session and tells the owner how to resume it. Queue work for a laptop agent with \`collab_add\`, start it with
\`collab_run\`, and read its result with \`run_log\`. When \`services\` shows something down, read
\`service_logs\` first and say what you found; call \`services_restart\` only after the owner agrees. \`media\` reads and drives the fleet's screen (the kiosk TV running
Afterglow): what is playing, play/pause/seek/volume, a search or a downloaded title put on the screen. \`todo_add\` / \`todo_done\` keep the handoff list current (confirm before removing), \`handoff_note\` records what you did on a host, and \`note\` drops a line into the owner's inbox that
every agent reads at session start. \`listen\` is the owner's voice control over the call itself: "stop listening" mutes the microphone (action mute), "listen again" unmutes, "that's all / hang up" ends the call (say goodbye first, then action hangup). All times are ISO 8601 or Unix milliseconds.

On this node the server also carries the reach a terminal coding agent has: \`shell\` (a command through the owner's
login shell on this node, or on another fleet host with \`host\`), \`read_file\`, \`write_file\`, \`edit_file\`, \`list_dir\`
and \`grep\` on this node's filesystem, and \`deck_context\` (the \`deck context\` briefing cc and cx run first; start
there). Results are bounded to about 6 KB: read in pieces (\`offset\`), ask for the tail or head, and page through an
\`outputFile\` with \`read_file\` rather than re-running a command. Writes and commands are audited.

Every tool takes \`brief: true\`: then it answers with one spoken sentence instead of the data (say it as-is), with the
key numbers as structured content. Use it on a voice call unless the owner asks for details; without it, object
answers still start with a \`brief\` sentence you can read first.`;

type RepoOut = Omit<RepoRow, "remotes" | "risk_reasons"> & { remotes: unknown; risk_reasons: unknown };

export type McpDeps = {
  /** The node summary behind GET /api/status. */
  status: () => NodeStatus;
  version: string;
  /** Leave a line on the Desk transcript (SeedBridge.announce); absent when this daemon has no bridge. */
  announce?: (input: AnnounceInput) => AnnounceResult;
  /** The `listen` tool: mute / unmute the owner's microphone or leave the call, applied by the Desk and the iPad (`SeedBridge.control`). */
  control?: (action: ControlAction) => Notice;
  /** Hand a task to the harness agent (SeedBridge.delegate); absent without a bridge. */
  delegate?: (task: string, title?: string) => Promise<DelegateResult>;
  /** Read a delegated session's newest answer (SeedBridge.delegateResult); absent without a bridge. */
  delegateResult?: (sessionId: string) => Promise<DelegateStatus>;
  /** This node's kiosk screen (registerKioskRoutes); `media` reaches peers' screens over the fleet pairing. */
  kiosk?: Kiosk;
};

function text(value: unknown): { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> } {
  const structured = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { items: value };
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}

function fail(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The optional voice switch every tool takes: one spoken sentence instead of the data. */
const BRIEF = z.boolean().default(false).describe("Voice mode: answer with one spoken sentence instead of the data (the counts still come along as structured content)");

/**
 * A tool answer with a spoken sentence. In brief mode the text is just that sentence (and the
 * structured content carries it with a few numbers); otherwise the full value, with `brief` first
 * when the value is an object.
 */
function spoken(brief: string, full: unknown, wantBrief: boolean, summary: Record<string, unknown> = {}) {
  if (wantBrief) return { content: [{ type: "text" as const, text: brief }], structuredContent: { brief, ...summary } };
  const value = full !== null && typeof full === "object" && !Array.isArray(full) ? { brief, ...(full as Record<string, unknown>) } : full;
  return text(value);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listOf = (items: string[], max = 5) => (items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`);
const clip = (s: string, max = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 3)}...` : t; };
/** Markdown bold/links/code stripped, for reading an entry aloud. */
const plain = (s: string) => clip(s.replace(/\*\*|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "";

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
    { brief: BRIEF },
    async ({ brief }) => {
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
      const online = nodes.filter((n) => n.online).map((n) => n.name);
      const offline = nodes.filter((n) => !n.online).map((n) => n.name);
      const sentence =
        `${self.nodeName} runs Cyberdeck ${self.version}${self.scanning ? " and is scanning now" : ""}: ${plural(self.repos ?? 0, "repo")}, ${self.atRisk ?? 0} at risk, ${self.attention ?? 0} needing attention; ` +
        (nodes.length ? `${online.length} of ${plural(nodes.length, "paired node")} online${offline.length ? ` (${listOf(offline)} offline)` : ""}.` : "no paired nodes.");
      return spoken(sentence, { node: self, peers: nodes }, brief, { repos: self.repos, atRisk: self.atRisk, attention: self.attention, peersOnline: online.length, peersTotal: nodes.length });
    }
  );

  server.tool(
    "fleet_status",
    "Every host in the Deck manifest (laptops, servers, phone) with whether it is online on the tailnet, plus the Deck repo's sync state and how many handoff entries are open.",
    { brief: BRIEF },
    async ({ brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const st = await control.cached<DeckStatus | null>("status", ["status", "--json"], null);
      if (!st) return spoken("The Deck CLI did not answer, so the fleet state is unknown right now.", null, brief);
      const hosts = st.hosts ?? [];
      const up = hosts.filter((h) => h.online === true).map((h) => h.name);
      const down = hosts.filter((h) => h.online === false).map((h) => h.name);
      const unknown = hosts.filter((h) => h.online !== true && h.online !== false).map((h) => h.name);
      const repo = st.repo;
      const sentence =
        `${up.length} of ${plural(hosts.length, "host")} online${down.length ? `, ${listOf(down)} offline` : ""}${unknown.length ? `, ${listOf(unknown)} unknown` : ""}` +
        (repo ? `; the Deck repo is on ${repo.branch}${repo.dirty ? ` with ${plural(repo.dirty, "dirty file")}` : ""}${repo.behind ? `, ${repo.behind} behind` : ""}${repo.ahead ? `, ${repo.ahead} unpushed` : ""}` : "") +
        `; ${plural(st.handoffOpen ?? 0, "handoff entry", "handoff entries")} open.`;
      return spoken(sentence, st, brief, { hostsOnline: up.length, hostsTotal: hosts.length, offline: down, handoffOpen: st.handoffOpen ?? 0 });
    }
  );

  server.tool(
    "hosts",
    "The fleet manifest: each host's kind, OS, ssh alias, tailnet name, roles, which agents (cc/cx) it runs, its Cyberdeck URL, and the services it must keep running.",
    { brief: BRIEF },
    async ({ brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const hosts = await control.cached<ManifestHost[]>("hosts", ["hosts", "--json"], []);
      const named = hosts.map((h) => `${h.name}${(h as { kind?: string }).kind ? ` (${(h as { kind?: string }).kind})` : ""}`);
      return spoken(`The fleet manifest lists ${plural(hosts.length, "host")}: ${listOf(named, 8) || "none"}.`, hosts, brief, { hosts: hosts.length });
    }
  );

  server.tool(
    "projects",
    "The project tree from the Deck repo (name, status, repos, hosts where its work happens, links, description). With `dir`, only the project that owns that directory.",
    { dir: z.string().optional().describe("Absolute directory; returns the project whose repos cover it, or null"), brief: BRIEF },
    async ({ dir, brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      if (dir) {
        const r = await control.cli(["projects", "--for", dir, "--json"]);
        const p = (r ? parseLast(r.out) : null) as DeckProject | null;
        return spoken(p ? `${dir} belongs to the project ${p.name}${p.status ? ` (${p.status})` : ""}.` : `No project covers ${dir}.`, p, brief, { project: p?.slug ?? null });
      }
      const all = await control.cached<DeckProject[]>("projects", ["projects", "--json"], []);
      const active = all.filter((p) => p.status === "active");
      const top = (active.length ? active : all).filter((p) => !p.depth).map((p) => p.name);
      return spoken(`${plural(all.length, "project")}, ${active.length} active${top.length ? `: ${listOf(top, 6)}` : ""}.`, all, brief, { projects: all.length, active: active.length });
    }
  );

  server.tool(
    "todo",
    "The running handoff (handoff/TODO.md): dated entries of unfinished work across every host and repo, grouped by section. `query` filters entries by substring. The brief names the newest and the oldest entry.",
    { query: z.string().optional().describe("Case-insensitive substring to keep only matching entries"), brief: BRIEF },
    async ({ query, brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const all = await control.cached<{ sections: { title: string; entries: { date: string; text: string }[] }[] }>("todo", ["todo", "--json"], { sections: [] });
      const q = query?.toLowerCase();
      const todo = q ? { sections: all.sections.map((s) => ({ ...s, entries: s.entries.filter((e) => e.text.toLowerCase().includes(q)) })).filter((s) => s.entries.length) } : all;
      const entries = todo.sections.flatMap((s) => s.entries);
      const byDate = [...entries].sort((a, b) => b.date.localeCompare(a.date));
      const newest = byDate[0];
      const oldest = byDate[byDate.length - 1];
      // The oldest entry is the one the owner keeps asking about ("what has been waiting longest?"): say it too.
      const sentence = entries.length
        ? `${plural(entries.length, "handoff entry", "handoff entries")}${q ? ` mention "${query}"` : ""} in ${plural(todo.sections.length, "section")}; the newest, from ${newest.date}, says: ${plain(newest.text)}${oldest !== newest ? `; the oldest, from ${oldest.date}, says: ${plain(oldest.text)}` : ""}`
        : `The handoff list has no entries${q ? ` mentioning "${query}"` : ""}.`;
      return spoken(sentence, todo, brief, { entries: entries.length, sections: todo.sections.length, ...(newest ? { newest: newest.date, oldest: oldest.date } : {}) });
    }
  );

  server.tool(
    "handoff",
    "Each coding agent's own note (handoff/<host>-<agent>.md): what cc and cx on each laptop were last doing and what not to duplicate.",
    { brief: BRIEF },
    async ({ brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const notes = await control.cached<{ file: string; host: string; agent: string; text: string }[]>("handoff", ["handoff", "--json"], []);
      const who = notes.map((n) => `${n.agent} on ${n.host}`);
      return spoken(notes.length ? `${plural(notes.length, "agent note")}: ${listOf(who, 8)}.` : "No agent has left a handoff note yet.", notes, brief, { notes: notes.length });
    }
  );

  server.tool(
    "sessions",
    "Search the cross-host index of cc and cx sessions (title, cwd, project, branch, times, transcript path). Any host, including offline ones.",
    {
      query: z.string().optional().describe("Words to match in session titles"),
      host: z.string().optional().describe("Only sessions on this host"),
      tool: z.enum(["cc", "cx"]).optional().describe("Only Claude Code (cc) or Codex (cx) sessions"),
      brief: BRIEF,
    },
    async ({ query, host, tool, brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const args = ["sessions", "--json"];
      if (host) args.push("--host", host);
      if (tool) args.push("--tool", tool);
      if (query) args.push(query);
      const r = await control.cli(args);
      const list = (r ? parseLast(r.out) ?? [] : []) as DeckSession[];
      const newest = [...list].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))[0];
      const sentence = newest
        ? `${plural(list.length, "session")}${query ? ` match "${query}"` : ""}${host ? ` on ${host}` : ""}; the newest is ${newest.tool === "cc" ? "Claude Code" : "Codex"} on ${newest.host}: ${clip(newest.title, 90)}.`
        : `No ${tool ?? "cc or cx"} sessions${query ? ` match "${query}"` : ""}${host ? ` on ${host}` : ""}.`;
      return spoken(sentence, list, brief, { sessions: list.length });
    }
  );

  server.tool(
    "repos",
    "Git repos this node (or a paired node) indexed under its roots, with risk: at-risk = work that exists nowhere else (remote-less or unpushed), attention = dirty/stashed/behind, safe. `ahead` counts commits on any local branch that no remote has. `kind` narrows to unpushed, remote-less or dirty repos; the brief says how many of each.",
    {
      risk: z.enum(["at-risk", "attention", "safe", "all"]).default("at-risk").describe("Which risk class to list; default at-risk"),
      kind: z.enum(["any", "unpushed", "remote-less", "dirty"]).default("any").describe("unpushed = local commits no remote has; remote-less = no remote at all; dirty = uncommitted or untracked files"),
      node: z.string().optional().describe("Name of a paired node to ask instead of this one; `all` asks this node and every paired node together (rows carry `node`)"),
      query: z.string().optional().describe("Substring of the repo path"),
      limit: z.number().int().min(1).max(REPOS_MAX_LIMIT).default(REPOS_DEFAULT_LIMIT),
      brief: BRIEF,
    },
    async ({ risk, kind, node, query, limit, brief }) => {
      let rows: (RepoOut & { node?: string })[];
      const unreachable: string[] = [];
      const fleet = node !== undefined && ["all", "fleet", "*"].includes(node.toLowerCase());
      if (fleet) {
        // Every node at once, each tagged; a peer that does not answer is named, not fatal.
        const local = (db.query("SELECT * FROM repos ORDER BY path").all() as RepoRow[]).map(parseRepo).map((r) => ({ ...r, node: cfg.nodeName }));
        const remote = await Promise.all(peers().map(async (peer) => {
          try {
            const res = await peerFetch(peer, "/api/repos", { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return ((await res.json()) as RepoOut[]).map((r) => ({ ...r, node: peer.name }));
          } catch { unreachable.push(peer.name); return [] as (RepoOut & { node: string })[]; }
        }));
        rows = [...local, ...remote.flat()];
      } else if (node && node.toLowerCase() !== cfg.nodeName.toLowerCase()) {
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
      const isUnpushed = (r: RepoOut) => (r.ahead ?? 0) > 0;
      const isRemoteless = (r: RepoOut) => !(Array.isArray(r.remotes) && r.remotes.length);
      const isDirty = (r: RepoOut) => (r.dirty_files ?? 0) + (r.untracked_files ?? 0) > 0;
      const ofKind = (r: RepoOut) => kind === "any" || (kind === "unpushed" ? isUnpushed(r) : kind === "remote-less" ? isRemoteless(r) : isDirty(r));
      const filtered = rows.filter((r) => (risk === "all" || r.risk === risk) && ofKind(r) && (!q || r.path.toLowerCase().includes(q)));
      const label = risk === "all" ? "indexed repos" : risk === "at-risk" ? "repos at risk" : risk === "attention" ? "repos needing attention" : "safe repos";
      const kindLabel = kind === "any" ? "" : kind === "unpushed" ? " with unpushed commits" : kind === "remote-less" ? " with no remote" : " with uncommitted work";
      const unpushed = filtered.filter(isUnpushed);
      const remoteless = filtered.filter(isRemoteless);
      // The at-risk brief breaks the set down: the owner wants to know what is unpushed vs what has no remote at all, by name.
      const breakdown = kind === "any" && (unpushed.length || remoteless.length)
        ? [unpushed.length ? `${unpushed.length} with unpushed commits (${listOf(unpushed.map((r) => r.name), 4)})` : "", remoteless.length ? `${remoteless.length} with no remote (${listOf(remoteless.map((r) => r.name), 4)})` : ""].filter(Boolean).join(", ")
        : "";
      const where = fleet ? "the fleet" : node ?? cfg.nodeName;
      // Fleet-wide: the count per node, by name, is what the owner wants to hear ("yacht 3, enuc 1").
      const perNode = fleet ? [...new Set(filtered.map((r) => r.node!))].map((n) => { const own = filtered.filter((r) => r.node === n); return `${n} ${own.length} (${listOf(own.map((r) => r.name), 3)})`; }) : [];
      const tail = fleet ? (perNode.length ? `: ${perNode.join(", ")}` : "") : breakdown ? `: ${breakdown}` : filtered.length ? `, such as ${listOf(filtered.slice(0, 3).map((r) => r.name), 3)}` : "";
      const missing = unreachable.length ? ` ${listOf(unreachable)} did not answer.` : "";
      const sentence = `${where} has ${filtered.length} ${label}${kindLabel}${q ? ` matching "${query}"` : ""}${tail}.${missing}`;
      const nodeOut = fleet ? "all" : node ?? cfg.nodeName;
      return spoken(sentence, { node: nodeOut, risk, kind, total: filtered.length, unpushed: unpushed.length, remoteless: remoteless.length, ...(fleet ? { nodes: [cfg.nodeName, ...peers().map((n) => n.name)], unreachable } : {}), items: filtered.slice(0, limit) }, brief, { node: nodeOut, risk, kind, total: filtered.length, unpushed: unpushed.length, remoteless: remoteless.length });
    }
  );

  server.tool(
    "repos_detail",
    "Look inside one git repo right now (live git, not the last scan): branch, upstream, ahead/behind, uncommitted files, stashes, last commit, and local branches no remote has. `brief` is one sentence to say first. `repo` is a folder name (\"Cyberdeck\"), a path, or part of one.",
    {
      repo: z.string().min(1).max(500).describe("Repo folder name, absolute path, or a distinctive part of the path"),
      node: z.string().optional().describe("Name of a paired node whose copy to read instead of this one"),
      brief: BRIEF,
    },
    async ({ repo, node, brief }) => {
      if (node && node.toLowerCase() !== cfg.nodeName.toLowerCase()) {
        const peer = peers().find((n) => n.name.toLowerCase() === node.toLowerCase());
        if (!peer) return fail(`No paired node named "${node}". Paired: ${peers().map((n) => n.name).join(", ") || "none"}.`);
        try {
          const res = await peerFetch(peer, `/api/repos/detail?repo=${encodeURIComponent(repo)}`, { signal: AbortSignal.timeout(20_000) });
          if (!(res.headers.get("content-type") ?? "").includes("json")) return fail(`${peer.name} runs an older Cyberdeck without repo detail; it updates within the hour.`);
          const body = (await res.json()) as RepoDetail | { error: string; candidates?: string[] };
          if ("error" in body) return fail(`${peer.name}: ${body.error}${body.candidates?.length ? `\nCandidates:\n${body.candidates.join("\n")}` : ""}`);
          return spoken(body.brief, { node: peer.name, ...body }, brief, { node: peer.name, path: body.path });
        } catch (err) {
          return fail(`${peer.name} is unreachable: ${err instanceof Error ? err.message : err}`);
        }
      }
      const r = await localRepoDetail(db, repo);
      if ("error" in r) return fail(`${r.error}${r.candidates?.length ? `\nCandidates:\n${r.candidates.join("\n")}` : ""}`);
      return spoken(r.brief, { node: cfg.nodeName, ...r }, brief, { node: cfg.nodeName, path: r.path });
    }
  );

  server.tool(
    "sessions_search",
    "Find past cc / cx coding sessions on any host (offline ones too) by words in their title, folder, project or branch, newest first, each with a resume hint: the command that reopens it on its host, over ssh from here, or `deck sessions pull` to move it to this machine. `brief` is one sentence to say first.",
    {
      query: z.string().max(300).optional().describe("Words that must all appear (title, folder, project, branch or id); omit for the most recent"),
      host: z.string().optional().describe("Only sessions on this host"),
      tool: z.enum(["cc", "cx"]).optional().describe("Only Claude Code (cc) or Codex (cx) sessions"),
      limit: z.number().int().min(1).max(50).default(SESSIONS_DEFAULT_LIMIT),
      brief: BRIEF,
    },
    async ({ query, host, tool, limit, brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const [all, hosts, status] = await Promise.all([
        control.cached<DeckSession[]>("sessions.all", ["sessions", "--json"], []),
        control.cached<ManifestHost[]>("hosts", ["hosts", "--json"], []),
        control.cached<{ host?: string } | null>("status", ["status", "--json"], null),
      ]);
      const found = searchSessions(all, { query, host, tool, limit }, { here: status?.host ?? cfg.nodeName, hosts, now: Date.now() });
      return spoken(found.brief, found, brief, { total: found.total });
    }
  );

  server.tool(
    "services",
    "The last probe of every expected service on every reachable host (state, ok, error). `probe: true` runs a fresh probe first (up to a minute).",
    { probe: z.boolean().default(false), brief: BRIEF },
    async ({ probe, brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      let result: ServiceProbe | { probedAt: null; rows: []; error?: string; note?: string };
      if (probe) {
        const r = await Promise.race([control.probe(), new Promise<null>((res) => setTimeout(() => res(null), 60_000))]);
        result = r ?? control.lastProbe() ?? { probedAt: null, rows: [], error: "probe did not finish in time" };
      } else {
        result = control.lastProbe() ?? { probedAt: null, rows: [], note: "no probe yet; call with probe: true" };
      }
      const rows = result.rows as ServiceProbe["rows"];
      // A service probed more than once on a host (two types in the manifest) is said once.
      const down = [...new Set(rows.filter((r) => r.ok === false).map((r) => `${r.service} on ${r.host}`))];
      const unknown = [...new Set(rows.filter((r) => r.ok === null).map((r) => `${r.service} on ${r.host}`))];
      const sentence = !result.probedAt
        ? "No service probe has run yet; ask again with probe true."
        : `Probe ${ago(Date.now() - Date.parse(result.probedAt))}: ${plural(rows.length, "service")} checked, ${down.length ? `${down.length} down: ${listOf(down)}` : "all up"}${unknown.length ? `; ${listOf(unknown)} unknown` : ""}.`;
      return spoken(sentence, result, brief, { probedAt: result.probedAt, services: rows.length, down, unknown });
    }
  );

  /** A manifest service on a host, or the refusal to hand back. */
  const target = async (host: string, name: string): Promise<ServiceTarget | ReturnType<typeof fail>> => {
    const blocked = needDeck(); if (blocked) return blocked;
    const [hosts, status] = await Promise.all([
      control.cached<ManifestHost[]>("hosts", ["hosts", "--json"], []),
      control.cached<{ host?: string } | null>("status", ["status", "--json"], null),
    ]);
    const r = resolveService(hosts, status?.host ?? cfg.nodeName, host, name);
    return "error" in r ? fail(r.error) : r;
  };

  server.tool(
    "service_logs",
    "Recent log lines of one service from the fleet manifest (systemd journal, launchd stdout/stderr files, docker logs), read on the host that runs it. Use it to explain why a service is down before proposing a restart.",
    {
      host: z.string().min(1).describe("Host name from `hosts` / `services`"),
      name: z.string().min(1).describe("Service name exactly as the manifest lists it (e.g. com.casework.console, caddy)"),
      lines: z.number().int().min(1).max(500).default(60),
      brief: BRIEF,
    },
    async ({ host, name, lines, brief }) => {
      const t = await target(host, name);
      if ("isError" in t) return t;
      const r = await serviceLogs(t, lines);
      const last = lastLine(r.output);
      const sentence = !r.ok
        ? `Could not read the log of ${r.service} on ${r.host}: ${clip(last || "no output", 120)}`
        : last ? `The last ${plural(r.lines, "line")} of ${r.service} on ${r.host} end with: ${clip(last, 160)}` : `${r.service} on ${r.host} has no log lines.`;
      return spoken(sentence, r, brief, { host: r.host, service: r.service, ok: r.ok, lastLine: clip(last, 200) });
    }
  );

  server.tool(
    "services_restart",
    "Restart one service from the fleet manifest on its host (systemctl / launchctl kickstart / docker restart), then re-check its state; retries once if it does not come up. At most 3 restarts per service per 30 minutes; every restart is audited. Ask the owner before calling this.",
    {
      host: z.string().min(1).describe("Host name from `hosts` / `services`"),
      name: z.string().min(1).describe("Service name exactly as the manifest lists it"),
      reason: z.string().max(500).optional().describe("Why (goes into the audit line)"),
      brief: BRIEF,
    },
    async ({ host, name, reason, brief }) => {
      const t = await target(host, name);
      if ("isError" in t) return t;
      if (t.local && /(^|\.)cyberdeck(\.daemon)?$/i.test(t.service)) return fail("That is the Cyberdeck daemon answering this call; restarting it from here would cut the call off. Use `cyberdeck restart` on the machine.");
      if (restartBudget(t) <= 0) return fail(`${t.service} on ${t.host} was already restarted 3 times in the last 30 minutes; read service_logs and tell the owner instead.`);
      const r = await restartService(t, `mcp${reason ? `: ${reason}` : ""}`);
      control.probe().catch(() => {});
      const sentence = r.ok
        ? `Restarted ${r.service} on ${r.host}; it is ${r.state} now${r.attempts > 1 ? ` after ${plural(r.attempts, "attempt")}` : ""} (it was ${r.before}).`
        : `${r.service} on ${r.host} did not come back: still ${r.state} after ${plural(r.attempts, "attempt")}; read its logs.`;
      return spoken(sentence, r, brief, { host: r.host, service: r.service, ok: r.ok, state: r.state, attempts: r.attempts });
    }
  );

  server.tool(
    "collab_tasks",
    "The collab queue: tasks handed to cc or cx on a host (open, running, review, done) and the runs that executed them, newest first.",
    { brief: BRIEF },
    async ({ brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const [tasks, runs] = await Promise.all([control.tasks(), control.runs()]);
      const list = tasks as { status?: string; title?: string; host?: string }[];
      const counts = new Map<string, number>();
      for (const t of list) counts.set(t.status ?? "unknown", (counts.get(t.status ?? "unknown") ?? 0) + 1);
      const running = list.find((t) => t.status === "running");
      const sentence = list.length
        ? `${plural(list.length, "collab task")}: ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}${running ? `; running now: ${clip(running.title ?? "", 80)}${running.host ? ` on ${running.host}` : ""}` : ""}.`
        : "The collab queue is empty.";
      return spoken(sentence, { tasks, runs }, brief, { tasks: list.length, runs: runs.length, byStatus: Object.fromEntries(counts) });
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
      brief: BRIEF,
    },
    async ({ title, project, host, worker, body, brief }) => {
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
      return spoken(`Queued task ${id}, "${clip(title, 80)}"${host ? ` for ${worker ?? "cx"} on ${host}` : worker ? ` for ${worker}` : ""}; it starts when you say so.`, { id, output: (r.out + r.err).trim() }, brief, { id });
    }
  );

  server.tool(
    "collab_run",
    "Start a queued task now on this node (worker then reviewer, detached). Returns at once; poll collab_tasks and read run_log for progress.",
    { id: z.string().regex(/^[\w.-]+$/).describe("Task id from collab_add or collab_tasks"), brief: BRIEF },
    async ({ id, brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const active = (await control.runs()).some((r) => r.status === "running");
      if (active) return fail("A collab run is already in progress on this node; wait for it or read collab_tasks.");
      const r = control.startCollab(["collab", "run", id], id);
      return r ? spoken(`Started task ${id} on ${cfg.nodeName}; the worker is running and the result will be in its run log.`, { id, ...r }, brief, { id }) : fail("could not start the run");
    }
  );

  server.tool(
    "run_log",
    "Tail of a collab run's log: worker.log (the agent doing the work), reviewer.log, or result.md (the summary).",
    {
      id: z.string().regex(/^[\w.-]+$/).describe("Run id from collab_tasks"),
      file: z.enum(["worker.log", "reviewer.log", "result.md"]).default("result.md"),
      tail: z.number().int().min(1000).max(2_000_000).default(LOG_DEFAULT_TAIL).describe("Bytes from the end"),
      brief: BRIEF,
    },
    async ({ id, file, tail, brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const r = control.runLog(id, file, tail);
      if (!r) return fail("bad run id or file");
      const last = lastLine(r.text);
      const sentence = last ? `${file} of run ${id} is ${r.size} bytes and ends with: ${clip(last, 160)}` : `${file} of run ${id} is empty so far.`;
      return spoken(sentence, { id, file, ...r }, brief, { id, file, size: r.size });
    }
  );

  server.tool(
    "note",
    "Append a dated line to the owner's inbox (notes/inbox.md in the Deck repo), which every agent reads at session start. Use it to leave a finding or a request for the owner.",
    { text: z.string().min(1).max(4000), brief: BRIEF },
    async ({ text: line, brief }) => {
      const blocked = needDeck(); if (blocked) return blocked;
      const r = await control.cli(["note", line]);
      if (!r || r.code !== 0) return fail(`deck note failed: ${(r?.err ?? "").trim() || "no output"}`);
      return spoken(`Noted in the inbox: ${plain(line.length > 100 ? line.slice(0, 100) : line)}${line.length > 100 ? "..." : ""}`, { ok: true }, brief, { ok: true });
    }
  );

  server.tool(
    "announce",
    "Tell the owner something on the Desk transcript (web Desk and iPad Talk tab) without waiting to be asked: a short line under the conversation, kept until the owner clears it. Give `text`, or the finished run's `title`, `status` (succeeded / failed / canceled), `runId` and `sessionId` and the line is composed for you; the run-completed trigger calls it that way. A run without a sessionId is an internal sub-step and is skipped: do not retry it.",
    {
      text: z.string().max(400).optional().describe("The line to show, as the owner should read it"),
      title: z.string().max(400).optional().describe("The finished run's title"),
      status: z.string().max(40).optional().describe("The run's terminal status: succeeded, failed or canceled"),
      runId: z.string().max(200).optional(),
      sessionId: z.string().max(200).optional(),
      brief: BRIEF,
    },
    async ({ text: line, title, status, runId, sessionId, brief }) => {
      if (!deps.announce) return fail("This node has no Seed bridge to announce through.");
      // A finished harness run carries its answer onto the Desk line, so the owner reads the result, not just "done".
      let summary: string | undefined;
      if (!line && sessionId && status === "succeeded" && deps.delegateResult) {
        const r = await deps.delegateResult(sessionId).catch(() => undefined);
        if (r?.answer) summary = r.answer;
      }
      const r = deps.announce({ text: line, title, status, runId, sessionId, summary });
      if (!r.announced) return spoken(`Not announced: ${r.reason ?? "nothing to say"}.`, { announced: false, reason: r.reason }, brief, { announced: false });
      return spoken(`Announced on the Desk: ${plain(r.notice!.text)}`, { announced: true, notice: r.notice }, brief, { announced: true, id: r.notice!.id });
    }
  );

  server.tool(
    "listen",
    "Control the owner's microphone and the call from inside the conversation. Owner says stop listening, mute, be quiet, hold on: action mute (then stay silent until unmuted). Owner says you can listen again, unmute: action unmute. Owner says that's all, hang up, goodbye, end the call: say a short goodbye first, then action hangup, because nothing said after it is heard. The web Desk and the iPad apply it within a few seconds; the transcript shows a line saying so.",
    { action: z.enum(["mute", "unmute", "hangup"]).describe("mute, unmute or hangup"), brief: BRIEF },
    async ({ action, brief }) => {
      if (!deps.control) return fail("This node has no Seed bridge to control the call through.");
      const notice = deps.control(action);
      const line = action === "mute" ? "Muted; I stop listening until you unmute." : action === "unmute" ? "Listening again." : "Ending the call.";
      return spoken(line, { action, notice }, brief, { action, id: notice.id });
    }
  );

  server.tool(
    "delegate",
    "Hand a job to the fleet agent (the Seed harness agent behind the prompt bar) and come back at once: a fresh session titled `title` gets `task` as its first turn and runs on its own with the same cyberdeck tools. Use it for anything that touches several machines or takes more than a few seconds (check every host and say what is down, probe all services, read logs on several servers). When the run finishes, the run-completed trigger leaves its answer on the Desk transcript; `delegate_result` reads it back at any time. Returns the session id.",
    {
      task: z.string().min(1).max(4000).describe("The job, in full sentences, with what to report back"),
      title: z.string().max(120).optional().describe("A short title for the session (default: the task's first line)"),
      brief: BRIEF,
    },
    async ({ task, title, brief }) => {
      if (!deps.delegate) return fail("This node has no Seed bridge to delegate through.");
      try {
        const r = await deps.delegate(task, title);
        return spoken(`Handed "${plain(r.title)}" to the fleet agent; a line appears on the Desk when it is done.`, { delegated: true, ...r }, brief, { delegated: true, sessionId: r.sessionId });
      } catch (e) {
        return fail(`delegate failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "delegate_result",
    "Where a delegated job stands: the fleet agent's newest answer in that session (`sessionId` from `delegate`, or the one a Desk announcement names) and whether it is still running, waiting for the next turn, or done.",
    { sessionId: z.string().min(1).max(200).describe("The session id `delegate` returned"), brief: BRIEF },
    async ({ sessionId, brief }) => {
      if (!deps.delegateResult) return fail("This node has no Seed bridge to read a delegated session from.");
      try {
        const r = await deps.delegateResult(sessionId);
        const line = r.state === "running" ? `"${plain(r.title)}" is still running${r.answer ? `; so far: ${clip(r.answer, 200)}` : ""}.`
          : r.answer ? `"${plain(r.title)}" ${r.state === "done" ? "finished" : "answered"}: ${clip(r.answer, 260)}`
          : `"${plain(r.title)}" has no answer yet.`;
        return spoken(line, r, brief, { state: r.state, sessionId: r.sessionId });
      } catch (e) {
        return fail(`delegate_result failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  /** A Deck write through the CLI (`deck … --json`); the JSON it prints, or the refusal. */
  type DeckWriteOut = { ok?: boolean; error?: string; candidates?: string[]; section?: string; entry?: string; removed?: string; file?: string };
  const deckWrite = async (args: string[], invalidates: string[], sentence: (out: DeckWriteOut) => string, brief: boolean) => {
    const blocked = needDeck(); if (blocked) return blocked;
    const r = await control.cli([...args, "--json"]);
    control.invalidate(...invalidates);
    const out = parseLast(r?.out ?? "") as DeckWriteOut | null;
    if (!r || r.code !== 0 || !out?.ok) {
      const why = out?.error ?? ((r?.err ?? "").trim() || "no output");
      return fail(`deck ${args.slice(0, 2).join(" ")} failed: ${why}${out?.candidates?.length ? `\nMatching entries:\n${out.candidates.join("\n")}` : ""}`);
    }
    return spoken(sentence(out), out, brief, { ok: true });
  };
  const by = () => `seed@${cfg.nodeName.toLowerCase()}`;

  server.tool(
    "todo_add",
    "Add a dated entry to the fleet handoff list (handoff/TODO.md in the Deck repo), at the top of the first section (\"Needs a decision or action from Eric\") unless `section` names another. Write it like the others: a **bold title**, then one or two sentences with the host and a pointer. Your name is appended.",
    {
      text: z.string().min(3).max(2000),
      section: z.string().max(120).optional().describe("Start of a section title from `todo`, e.g. \"Open PRs\""),
      brief: BRIEF,
    },
    async ({ text: entry, section, brief }) =>
      deckWrite(["todo", "add", ...(section ? ["--section", section] : []), `${entry.trim()} (${by()})`], ["todo"], (out) => `Added to the handoff list${out.section ? ` under ${out.section}` : ""}: ${plain(entry)}`, brief)
  );

  server.tool(
    "todo_done",
    "Remove the one entry of the fleet handoff list whose text contains `match` (case-insensitive), because it is finished. Refuses when nothing or several entries match and lists them; read `todo` first and confirm with the owner. Returns the removed entry.",
    { match: z.string().min(3).max(300).describe("A distinctive piece of the entry, e.g. its bold title"), brief: BRIEF },
    async ({ match, brief }) => deckWrite(["todo", "done", match], ["todo"], (out) => `Removed from the handoff list: ${plain((out.removed ?? match).replace(/^-\s*/, ""))}`, brief)
  );

  server.tool(
    "handoff_note",
    "Prepend a dated line to the per-host handoff note for the Seed agent (handoff/<host>-seed.md), which the laptop agents read at session start. Use it to record what you checked or changed on a machine.",
    {
      host: z.string().min(1).describe("Host name from `hosts`"),
      text: z.string().min(3).max(2000),
      brief: BRIEF,
    },
    async ({ host, text: line, brief }) => deckWrite(["handoff", "note", host.toLowerCase(), "seed", line], ["handoff"], (out) => `Recorded on ${host}'s handoff note${out.file ? ` (${out.file})` : ""}.`, brief)
  );

  server.tool(
    "media",
    `What is playing on a fleet screen (the kiosk TV that shows Afterglow, the owner's films, series and music), and the controls: play, pause, toggle, seek (value = seconds, negative to go back), mute, unmute, volume (value 0-100), library, music, search (value = what to look for; the results appear on the screen), watch (value = the title to play from the downloaded library), open (value = an Afterglow route such as discover, saved, series or title/movie/tt0123456). Without \`host\` the first screen in the fleet answers. Start with status before changing anything.`,
    {
      action: z.enum(MEDIA_ACTIONS).default("status"),
      value: z.union([z.string().max(500), z.number()]).optional().describe("Seconds for seek, 0-100 for volume, the query for search, the title for watch, the route for open"),
      host: z.string().max(80).optional().describe("Host name of the screen (e.g. enuc); default: the first fleet screen that answers"),
      brief: BRIEF,
    },
    async ({ action, value, host, brief }) => {
      const body = JSON.stringify({ action, value });
      const ask = async (name: string, run: () => Promise<Response | MediaState>): Promise<{ name: string; state?: MediaState; noScreen?: boolean; error?: string }> => {
        try {
          const r = await run();
          if (!(r instanceof Response)) return { name, state: r };
          const data = (await r.json().catch(() => ({}))) as Partial<MediaState> & { error?: string; screen?: boolean };
          if (r.status === 409 || (r.status === 404 && !data.error)) return { name, noScreen: true };
          if (!r.ok) return { name, error: clip(String(data.error ?? `${name} answered ${r.status}`).split("\n")[0], 160) };
          return { name, state: data as MediaState };
        } catch (err) {
          return { name, error: clip((err instanceof Error ? err.message : String(err)).split("\n")[0], 160) };
        }
      };
      const local = cfg.nodeName;
      const wanted = host?.trim().toLowerCase();
      const peer = (n: NodeRow) => ask(n.name, () => peerFetch(n, "/api/kiosk/media", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(20_000) }));
      const here = () => ask(local, async () => (deps.kiosk?.enabled ? deps.kiosk.media({ action, value }) : new Response(JSON.stringify({ error: "no screen" }), { status: 409 })));
      let answers: { name: string; state?: MediaState; noScreen?: boolean; error?: string }[];
      if (wanted) {
        if (wanted === local.toLowerCase()) answers = [await here()];
        else {
          const n = peers().find((p) => p.name.toLowerCase() === wanted);
          if (!n) return fail(`No paired node is called ${host}; the screens I can reach are on ${listOf([local, ...peers().map((p) => p.name)])}.`);
          answers = [await peer(n)];
        }
      } else {
        // The first screen that answers; a status asks everyone, an action stops at the first screen.
        answers = [await here()];
        if (!answers[0].state) answers = [...answers, ...(await Promise.all(peers().map(peer)))];
      }
      const hit = answers.find((a) => a.state);
      if (!hit?.state) {
        const errors = answers.filter((a) => a.error).map((a) => `${a.name}: ${a.error}`);
        const sentence = errors.length ? `No screen answered: ${listOf(errors, 3)}.` : `No fleet screen is configured (none of ${listOf(answers.map((a) => a.name))} has a kiosk).`;
        return spoken(sentence, { ok: false, screens: answers }, brief, { ok: false });
      }
      const s = hit.state;
      const sentence = mediaSentence(hit.name, s);
      const out = { host: hit.name, ...s };
      return s.ok ? spoken(sentence, out, brief, { host: hit.name, ok: true, playing: s.video?.playing ?? false, route: s.afterglow.route, did: s.did }) : spoken(sentence, out, brief, { host: hit.name, ok: false, error: s.error });
    }
  );

  server.tool(
    "scan",
    "Rescan this node's roots for repos now (normally hourly plus on file changes). Returns at once; `status` shows scanning until it finishes.",
    { brief: BRIEF },
    async ({ brief }) => {
      const already = isScanRunning();
      if (!already) runScan(db, cfg).catch((err) => console.error("mcp scan error:", err));
      return spoken(already ? `${cfg.nodeName} is already scanning; status will show when it is done.` : `Rescan started on ${cfg.nodeName} over ${plural(cfg.roots.length, "root")}.`, { started: true, roots: cfg.roots }, brief, { started: true });
    }
  );

  if (cfg.mcp?.nodeTools !== false) {
    registerNodeTools(server, cfg, control, {
      hosts: () => (control.fleetDir() ? control.cached<ManifestHost[]>("hosts", ["hosts", "--json"], []) : Promise.resolve([])),
      deckContext: async (dir) => {
        if (!control.fleetDir()) return null;
        const r = await control.cli(dir ? ["context", dir] : ["context"]);
        return r ? { code: r.code, out: r.out, err: r.err } : { code: 1, out: "", err: "deck CLI did not answer" };
      },
    });
  }
  return server;
}

/** The last line of CLI output that parses as JSON (the CLI may print warnings first). */
function parseLast(out: string): unknown {
  for (const line of [out.trim(), ...out.trim().split("\n").reverse()]) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

/** A repo this node indexed, read live; or why not. */
async function localRepoDetail(db: Database, repo: string): Promise<RepoDetail | { error: string; candidates?: string[] }> {
  const paths = (db.query("SELECT path FROM repos ORDER BY path").all() as { path: string }[]).map((r) => r.path);
  const m = matchRepo(paths, repo);
  if ("error" in m) return m;
  try {
    return await repoDetail(m.path);
  } catch (err) {
    return { error: `${m.path}: ${err instanceof Error ? err.message : err}` };
  }
}

type DeckStatus = { host?: string; hosts?: { name: string; online?: boolean | null }[]; repo?: { branch: string; dirty: number; ahead: number; behind: number }; handoffOpen?: number };
type DeckProject = { slug: string; name: string; status?: string; depth?: number };

export type DeckSession = { host: string; tool: "cc" | "cx"; id: string; title: string; cwd: string; branch?: string; project?: string; started: string; updated: string; file: string };

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 2) return "just now";
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Session search with resume hints, newest first. Pure (the caller passes the index, the manifest and the clock). */
export function searchSessions(
  all: DeckSession[],
  f: { query?: string; host?: string; tool?: "cc" | "cx"; limit: number },
  ctx: { here: string; hosts: { name: string; ssh?: string | null }[]; now: number },
) {
  const words = (f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const here = ctx.here.toLowerCase();
  const hit = all
    .filter((s) => (!f.host || s.host.toLowerCase() === f.host.toLowerCase()) && (!f.tool || s.tool === f.tool))
    .filter((s) => {
      const hay = [s.title, s.cwd, s.project, s.branch, s.id].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  const items = hit.slice(0, f.limit).map((s) => {
    const cmd = `cd ${shq(s.cwd)} && ${s.tool === "cc" ? `claude --resume ${s.id}` : `codex resume ${s.id}`}`;
    const local = s.host.toLowerCase() === here;
    const alias = ctx.hosts.find((h) => h.name.toLowerCase() === s.host.toLowerCase())?.ssh;
    const title = s.title.length > 90 ? `${s.title.slice(0, 87)}...` : s.title;
    return {
      ...s,
      spoken: `${s.tool === "cc" ? "Claude Code" : "Codex"} on ${s.host}, ${ago(ctx.now - Date.parse(s.updated))}${s.project ? `, project ${s.project}` : ""}: ${title}`,
      resume: {
        host: s.host,
        command: cmd,
        ...(local ? {} : { ssh: alias ? `ssh -t ${alias} ${shq(cmd)}` : null, pull: `deck sessions pull ${s.id}` }),
      },
    };
  });
  const brief = !items.length
    ? `No ${f.tool ?? "cc or cx"} sessions match${f.query ? ` "${f.query}"` : ""}${f.host ? ` on ${f.host}` : ""}.`
    : `${hit.length === 1 ? "One session matches" : `${hit.length} sessions match`}; the newest is ${items[0].spoken}.`;
  return { brief, total: hit.length, items };
}

export function registerMcpRoutes(app: Hono, db: Database, cfg: CyberdeckConfig, control: Control, deps: McpDeps) {
  // A peer's `repos_detail` reads this node's copy here (mounted with the MCP route so server.ts stays untouched).
  app.get("/api/repos/detail", async (c) => {
    const r = await localRepoDetail(db, c.req.query("repo") ?? "");
    return c.json(r, "error" in r ? 404 : 200);
  });
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
