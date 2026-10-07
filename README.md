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

Cyberdeck is an MCP server for [Seed Agents](https://hyper.media) and any other MCP client:
`POST /api/mcp` (Streamable HTTP, bearer token). Its tools expose the node and the deck: repo
risk, hosts and services, the project tree, the agents' handoff, the cross-host session index,
and the cc/cx collab queue, so a hosted agent can see every machine and hand work to a laptop
agent. `cyberdeck mcp` prints what to paste into the agent's Tools tab. Details: [docs/AGENTS.md](docs/AGENTS.md).

## Docs

Start at [docs/OVERVIEW.md](docs/OVERVIEW.md). The vision is in
[docs/BRIEF.md](docs/BRIEF.md), the milestone plan in [docs/ROADMAP.md](docs/ROADMAP.md).
