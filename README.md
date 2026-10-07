# 🛡️ Cyberdeck

Self-hosted fleet-and-data guardian. Cyberdeck runs as a background service on every machine
you own and makes sure all novel data is known, synced, and redundantly backed up — and that
every machine converges to your desired setup.

## Install (one line)

On any Mac or Linux box (needs git; Linux also needs unzip and curl):

```sh
curl -fsSL https://raw.githubusercontent.com/ericvicenti/cyberdeck/main/install.sh | bash
```

From a source checkout: `./install.sh`. Re-running either form updates and restarts.

This installs bun if needed, clones the source to `~/.cyberdeck/src`, builds the UI, registers
a launchd (macOS) or systemd (Linux) service, and opens the web UI at
`http://127.0.0.1:4777`.

From other devices use the tailnet: the daemon only answers tailnet and loopback addresses, and a
device logged in as the node's owner needs no token. For HTTPS (phones, PWAs) run
`cyberdeck serve` once per node and open `https://<node>.<your-tailnet>.ts.net`. Pair nodes from
one machine with `curl -X POST .../api/fleet/pair-direct -d '{"url":"http://<peer>.<tailnet>:4777"}'`.
Pass `--owner you@example.com` to the installer to pin the trusted Tailscale login up front.

## Develop

```sh
bun install
bun run dev        # daemon with hot reload on :4777
bun run dev:ui     # vite dev server for the UI (proxies /api to :4777)
bun run build      # build UI into dist/ui (daemon serves it)
```

## CLI

`cyberdeck status | open | scan | restart | stop | start | logs | update`

`cyberdeck update` pulls Cyberdeck's own source, rebuilds, and restarts the service —
Cyberdeck manages itself.

## Agents

The prompt bar at the bottom of every view starts an agent session with one line: type the task, and the
auto harness selector proposes the machine, the agent (Claude Code `cc` or Codex `cx`), the project directory
and the runner from what you wrote and where you are (`@yacht`, `#seed`, `cc:`/`cx:`, or `$ cmd` for a plain
shell; or just mention a host, project or repo). Every choice is a chip you can override before sending.
Sessions are owned by the daemon, so they keep running when you close the tab; the live strip above the bar
and the Sessions view lead back into them from any browser, and tmux-backed sessions survive daemon updates
(`tmux attach -t cd-<id>` works from a real terminal too).

Cyberdeck is an MCP server for [Seed Agents](https://hyper.media) and any other MCP client:
`POST /api/mcp` (Streamable HTTP, bearer token). Its tools expose the node and the deck: repo
risk, hosts and services, the project tree, the agents' handoff, the cross-host session index,
and the cc/cx collab queue, so a hosted agent can see every machine and hand work to a laptop
agent. `cyberdeck mcp` prints what to paste into the agent's Tools tab. Details: [docs/AGENTS.md](docs/AGENTS.md).

## Docs

Start at [docs/OVERVIEW.md](docs/OVERVIEW.md). The vision is in
[docs/BRIEF.md](docs/BRIEF.md), the milestone plan in [docs/ROADMAP.md](docs/ROADMAP.md).
