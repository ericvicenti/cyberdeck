# Cyberdeck for agents

Cyberdeck is the machine-side half of Eric's agent setup. Coding agents (`cc` = Claude Code,
`cx` = Codex) run in terminals on the laptops; Seed Agents run on a hosted agents server and
talk to the world through tools. This document covers how a Seed agent (or any MCP client)
reaches Cyberdeck, what it can do there, and the deployment choices that make that reachable.

The companion is the private Deck repo (`~/Code/Deck`): the fleet manifest, project tree,
handoff, session index, and collab queue that Cyberdeck reads through the `deck` CLI
(`src/daemon/api/control.ts`). Nothing in this document changes that data layout; the MCP
server is one more reader and writer of it.

## The MCP server

`POST /api/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over
Streamable HTTP (`src/daemon/api/mcp.ts`). It is **stateless**: every POST builds a fresh
`McpServer` and transport, answers, and tears them down, so no session id is issued and a
daemon restart (self-update) never strands a client. `GET` and `DELETE` answer 405.

Auth is the daemon's normal `/api` gate: `Authorization: Bearer <~/.cyberdeck/token>` (or a
`?token=` query), or a tailnet identity when the request arrives through `tailscale serve`.
MCP clients send static headers, so the bearer token is the form that matters.

`cyberdeck mcp` prints the URL, the header, and the transport; `cyberdeck mcp --json` prints the
same as JSON for scripts. `cyberdeck seed setup` does the registration for you on the configured
Seed agents server (stores the token as the `cyberdeck-mcp-token` secret, saves the `cyberdeck`
MCP server, and grants it to the voice agent; see `docs/VOICE.md`).

### Tools

| Tool | Does | Writes? |
|---|---|---|
| `status` | this node (version, scan state, repo risk counts, junk bytes) and whether each paired node answers right now | no |
| `fleet_status` | every host in the manifest with tailnet liveness, the Deck repo's sync state, open handoff count (`deck status`) | no |
| `hosts` | the manifest: kind, OS, ssh alias, tailnet name, roles, agents, Cyberdeck URL, expected services | no |
| `projects` | the project tree; with `dir`, the project owning that directory | no |
| `todo` | `handoff/TODO.md` by section; `query` filters entries | no |
| `handoff` | the per-agent `handoff/<host>-<agent>.md` notes | no |
| `sessions` | search the cross-host cc/cx session index (`query`, `host`, `tool`) | no |
| `sessions_search` | words matched across title, folder, project, branch and id (`query`, `host`, `tool`, `limit` ≤ 50, default 8), newest first, each with `spoken` and a `resume` hint (`command` on its host; for other hosts `ssh -t <alias> …` and `deck sessions pull <id>`), plus a `brief` | no |
| `repos` | indexed repos with risk; `risk` (default `at-risk`), `node` (a paired node by name, fetched over the fleet token), `query`, `limit` | no |
| `repos_detail` | one indexed repo read live with git (`repo` = folder name, path or part of one; `node` = a paired node, via its `GET /api/repos/detail`): branch, upstream, ahead/behind, dirty files (first 30), stashes, last commit, local branches no remote has, and a spoken `brief` | no |
| `services` | last service probe; `probe: true` runs one now (up to 60 s) | no |
| `service_logs` | recent log lines of one manifest service on its host (`host`, `name`, `lines` ≤ 500): journal, launchd stdout/stderr files, docker logs | no |
| `services_restart` | restart one manifest service on its host (`host`, `name`, `reason`), re-check its state, retry once; ≤ 3 per service per 30 min; refuses this node's own daemon; audited | yes (restarts a service) |
| `todo_add` | add a dated entry to `handoff/TODO.md` (`text`, optional `section` prefix; default the first section), signed `(seed@<node>)` | yes (Deck repo) |
| `todo_done` | remove the one `handoff/TODO.md` entry containing `match`; refuses none/several and lists the candidates | yes (Deck repo) |
| `handoff_note` | prepend a dated line to `handoff/<host>-seed.md` (`host`, `text`); `handoff` returns it next to the cc/cx notes | yes (Deck repo) |
| `collab_tasks` | the collab queue and its runs | no |
| `collab_add` | queue a task for cc/cx on a host (`title`, `project`, `host`, `worker`, `body`); returns the id | yes (Deck repo) |
| `collab_run` | start a queued task on this node, detached; refuses while a run is active | yes (spawns agents) |
| `run_log` | tail of `worker.log`, `reviewer.log` or `result.md` for a run | no |
| `note` | append a dated line to `notes/inbox.md` | yes (Deck repo) |
| `scan` | rescan this node's roots now | no (indexer) |
| `deck_context` | the `deck context [dir]` briefing every coding agent runs first (host, project of `dir`, handoff entries, inbox, collab tasks) | no |
| `shell` | run a command line through the owner's login shell on this node, in `cwd`; `host` runs it on a manifest host over ssh; `timeoutSec` ≤ 600; long output is saved to an `outputFile` | yes (whatever the command does; audited) |
| `read_file` | numbered lines of a text file from `offset`, up to `limit`, with `nextOffset` to continue | no |
| `write_file` | create or overwrite a text file (parents created) | yes (audited) |
| `edit_file` | replace one exact occurrence (or all) of `old` with `new`; refuses on zero or several matches | yes (audited) |
| `list_dir` | entries with type and size, `depth` 1–3, junk dirs skipped | no |
| `grep` | regex search of file contents (ripgrep or grep -rn) under `path`, optional `glob`, junk dirs skipped | no |

The last seven are the **node tools** (`src/daemon/api/mcp-node.ts`): the reach cc and cx have on
the machine, offered to the Seed agent through the same server. `config.mcp.nodeTools: false`
leaves them off (the harness prompt then says the agent has no machine access).

Every result is JSON text plus the same object as `structuredContent`. Object results start with
a `brief` sentence a voice agent can read as-is. **Every tool also takes `brief: true`** (voice
mode): the text is then just that one spoken sentence (what was found, the counts, the names that
matter) and `structuredContent` carries the sentence plus the key numbers, so a call on a live
call costs one short turn instead of a page of JSON. On a node without a
Deck checkout (`fleetDir` unset: the Linux servers today) the deck-backed tools answer with a
clear error and `status`, `repos`, `scan` still work.

The server's `instructions` (sent on `initialize`) tell the agent what Cyberdeck and the deck
are and which tool to start with, so an agent that has never seen a tool description can
orient itself.

### The node tools and their guardrails

Until 2026-10-16 the server deliberately offered only the deck's vocabulary, so a hosted agent
could see every machine but not touch one. Eric then asked for the Seed agent to be configured
like cc and cx, which run on the laptops with `--dangerously-skip-permissions` / `--yolo`, so the
node tools give it the same reach: a login shell on this node (and on any manifest host that has
an ssh alias, over the daemon's ssh), and files on this node. What keeps that honest:

- **The same gate as everything else.** The tools sit behind the daemon's bearer token or tailnet
  identity; the agents server that holds the token is Eric's own instance on the node (yacht, clipper)
  or a server he operates. A leaked token is rotated like before (`~/.cyberdeck/token`, re-pair).
- **Bounded, non-interactive, time-limited.** No TTY, a hard timeout (default 120 s, max 600 s;
  the whole process group is killed), output cut to about 6 KB in the result (the agents server
  itself cuts tool results at 8 KB) with the full text in `~/.cyberdeck/tool-output/` for paging.
- **Audited.** Every `shell`, `write_file` and `edit_file` call writes a JSON line to
  `~/.cyberdeck/audit.log` (`by: "mcp"`, host, cwd, command or path).
- **Opt-out per node.** `config.mcp.nodeTools: false` removes them from the server; the deck tools
  stay. Use it on a node whose agents server you do not control.
- **The agent's own sandbox is not the machine.** The harness prompt says so, and says to prefer
  these tools over `execute` for anything that involves the repos, keys or tools on the machine.

Add deck-level tools at the deck's altitude as before; add node-level tools only here, with the
same bounds and audit line.

## The harness: prompt, memory, model

A Seed agent is only as capable as its system prompt, its memory and its tools, so Cyberdeck
configures all three from files on the node (`src/daemon/harness.ts`, applied by
`SeedBridge.syncHarness` in `src/daemon/seed.ts`), the same way on every instance:

- **Prompt.** The harness agent (the one behind the prompt bar and the Seed view, named
  `Cyberdeck` on the agents server) gets a persona and working rules written for this surface
  (orient with `deck_context`, use the node tools, bounded results, leave a trace, finish the job),
  then **the node's `~/Code/AGENTS.md` and `Deck/AGENTS.md` verbatim**: exactly what cc and cx read
  at session start. `cyberdeck seed prompt-text` prints it. The voice companion keeps its spoken
  persona (`fleetPrompt`) and gets the same two files appended once `cyberdeck seed sync --voice`
  adopts it (never silently: Casework may have tuned that agent by hand).
- **Memory.** A *fleet pack* is synced into each agent's `~/memory/fleet/`: `README.md` (an index),
  `code-agents.md` and `deck-protocol.md` (the same two files, for re-reading mid-session) and
  `notes/*.md`, Claude Code's auto-memory for the Code root on this node
  (`~/.claude/projects/<cwd slug>/memory`, 47 project notes on yacht today). The sync writes only
  files whose hash changed and deletes pack files that disappeared; the agent is told not to edit
  the pack and to keep its own learnings in `~/memory/notes/`. `seed.memoryDirs` adds sources.
- **Definition.** `seed.model`, `seed.modelProvider` and `seed.reasoningLevel` (default `medium`,
  the level cx runs with is `high`; `""` leaves the provider default) are applied to the harness
  agent; the `cyberdeck` MCP grant is re-added if it went missing. The voice agent's model is never
  touched.

The sync runs five seconds after every daemon start (after the MCP tool-list refresh) when the node
has a configured identity and agents server, and on `cyberdeck seed sync` (`--voice` adopts the
companion, `--force` rewrites prompts whose hash matches). It stores the hash of the prompt it wrote
in the agent's `metadata.cyberdeck` on the server, so a deploy that changes the prompt updates the
agent exactly once and a node reinstall finds the agent already current. The pack manifest lives in
`seed.json` (`memoryPacks`). `cyberdeck seed status` shows whether each agent's prompt is current
and how many pack files it holds.

Every prompt-bar message also carries context lines (`turnContext` in `src/daemon/api/sessions.ts`):
the fleet machine chosen (with a hint to use `shell`'s `host` when it is another one), the working
directory, its Deck project, the git branch with dirty/ahead/behind counts, and the time.

`service_logs` and `services_restart` are the one place the agent touches a machine, and they stay
inside that rule: the target must be a service the fleet manifest lists for that host (`deck hosts
--json`), the command is a fixed one per service type (`src/shared/services.ts`, the same builders the
Services view's Logs/Restart buttons use; names quoted, `sudo -n` so nothing prompts), and it runs
through `bash -s` locally or `ssh -o BatchMode=yes <alias>` (`src/daemon/servicectl.ts`). Restarts
re-check the state after each attempt (two at most), are limited to three per service per 30
minutes, and each writes a JSON line to `~/.cyberdeck/audit.log`.

## Connecting a Seed agent

Seed Agents is an MCP client for **remote HTTP servers with static headers** (no stdio, no
OAuth); see `hypermedia/agent/mcp.md` in the Seed repo. In the agent's **Tools** tab, under
**MCP servers**, choose **Add server**, name it `cyberdeck`, paste the URL and the
`Authorization` header from `cyberdeck mcp`, leave the transport on auto (it tries Streamable
HTTP first), and enable it for the agent. Seed discovers the tools on save and projects them
into the agent's `~/tools/` as `cyberdeck__status`, `cyberdeck__repos`, and so on; the agent
calls them through `call` and later turns promote them to first-class tools.

### Reachability

The agents server has to be able to open a connection to the node:

- **Local agents server** (the Seed dev server on the same laptop, `localhost:3051`): use
  `http://127.0.0.1:4777/api/mcp` directly.
- **Agents server on the tailnet**: with `cyberdeck serve` on the node, use
  `https://<node>.<tailnet>.ts.net/api/mcp`. The bearer header still goes along: the serve
  identity shortcut only applies to a device logged in as the owner, and the agents server is
  not one.
- **Hosted agents server off the tailnet** (`agent.hm` today): the node must be reachable from
  the public internet. The clean option is Tailscale Funnel on the node
  (`tailscale funnel --bg --https=443 http://127.0.0.1:4777`), which keeps TLS on the tailnet
  cert and leaves the bearer token as the only gate. Rotate the token (`~/.cyberdeck/token`,
  then `cyberdeck restart`) if it ever leaks; every paired node must be re-paired after a
  rotation. Seed refuses to send a header to an agents server that is not on HTTPS, which is
  not a constraint here because the hosted server is.

Alternatively run the agents server on the tailnet (the self-hosted option in Seed's
`apps/agents.md`) and skip the public route altogether.

## New queries

The query bar defaults to Seed agents. `/api/harness/caps` reports `seed: true` when this node's
configured agents server is healthy, the local signing identity loads, and MCP setup is complete.
The planner picks a ready node; an explicit node pin fails visibly if unavailable. Browser clients
reach a remote node through Cyberdeck's authenticated fleet proxy. The agents server stays private.

On first query, `SeedBridge` creates the harness agent (`Cyberdeck`, see above: the harness prompt
built from this node's AGENTS.md files, the configured model and reasoning level, the `cyberdeck` MCP
grant, and the memory pack). Its id is stored as `queryAgentId` in `seed.json`; an older node keeps
its `Cyberdeck Queries` agent and the sync upgrades its prompt, model and memory in place.
The Sessions API signs CreateSession, MessageSession, GetSession, ListSessions, StopSession,
UpdateSession and DeleteSession actions. Query ids carry a `seed-` prefix in Cyberdeck;
transcripts and lifecycle stay on the Seed server. All reads and writes require normal Cyberdeck
authentication; the Casework voice pairing key cannot use the query routes. Voice state is separate.

## Seed's agents UI

The **Seed** view (`#/seed?r=<path>`, `ui/views/SeedAgents.tsx`) is Seed's own agents UI, the code the
Seed desktop and web apps render, from the `@seed-hypermedia/agents-ui` package: every agent on this
node's agents server with its sessions, triggers, memory, tools and MCP servers, system prompt,
collaborators and settings, and sessions with tool calls, plans, sub-sessions and runs. `r` is the
path after `/hm/agents/` in Seed's web URLs (`session/<id>?agent=<id>`), so links match the Seed apps.
Seed query sessions in **Sessions** render with the same UI.

Cyberdeck only hosts it (`ui/lib/seed-agents.ts`, `src/daemon/api/seed-agents.ts`): the daemon signs
`AgentsAction` envelopes for the bridge's identity and nothing else, and proxies the agents server and
the Seed API on the same origin behind an HttpOnly cookie, so the browser never holds the key or talks
to the private agents server directly. Remote nodes' Seed sessions still use the plain transcript pane.

Cyberdeck consumes the published `@seed-hypermedia/agents-ui` package at an exact version. Upgrade it
with Bun after a compatible Seed release is published. Restyling goes through Seed's supported CSS
variables (`ui/views/seed-agents.css`), not its markup.

## Cross-agent session index (planned)

The Deck session index covers cc and cx transcripts. Seed agent sessions live in the agents
server's `session_events` table and are the next source (DESIGN.md §9 phase 4 in the Deck
repo); once indexed they appear in `sessions` like any other.
