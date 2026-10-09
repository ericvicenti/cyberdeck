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
| `repos` | indexed repos with risk; `risk` (default `at-risk`), `node` (a paired node by name, fetched over the fleet token), `query`, `limit` | no |
| `services` | last service probe; `probe: true` runs one now (up to 60 s) | no |
| `collab_tasks` | the collab queue and its runs | no |
| `collab_add` | queue a task for cc/cx on a host (`title`, `project`, `host`, `worker`, `body`); returns the id | yes (Deck repo) |
| `collab_run` | start a queued task on this node, detached; refuses while a run is active | yes (spawns agents) |
| `run_log` | tail of `worker.log`, `reviewer.log` or `result.md` for a run | no |
| `note` | append a dated line to `notes/inbox.md` | yes (Deck repo) |
| `scan` | rescan this node's roots now | no (indexer) |

Every result is JSON text plus the same object as `structuredContent`. On a node without a
Deck checkout (`fleetDir` unset: the Linux servers today) the deck-backed tools answer with a
clear error and `status`, `repos`, `scan` still work.

The server's `instructions` (sent on `initialize`) tell the agent what Cyberdeck and the deck
are and which tool to start with, so an agent that has never seen a tool description can
orient itself.

### Why these tools and not a shell

A Seed agent that enables an MCP server gets a grant as strong as `execute` on that server
(Seed's words), so the surface is deliberately the deck's vocabulary rather than raw file or
terminal access: an agent can learn what every machine is doing, queue work for a laptop agent,
and read the result, but it cannot read arbitrary files, run commands, or touch the terminal
sessions. Those stay with the humans and the laptop agents. Add tools at that altitude.

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

On first query, `SeedBridge` creates a dedicated `Cyberdeck Queries` agent with the existing
`cyberdeck` MCP grant and configured model. Its id is stored as `queryAgentId` in `seed.json`.
The Sessions API signs CreateSession, MessageSession, GetSession, ListSessions, StopSession,
UpdateSession and DeleteSession actions. Query ids carry a `seed-` prefix in Cyberdeck;
transcripts and lifecycle stay on the Seed server. All reads and writes require normal Cyberdeck
authentication; the Casework voice pairing key cannot use the query routes. Voice state is separate.

## Cross-agent session index (planned)

The Deck session index covers cc and cx transcripts. Seed agent sessions live in the agents
server's `session_events` table and are the next source (DESIGN.md §9 phase 4 in the Deck
repo); once indexed they appear in `sessions` like any other.
