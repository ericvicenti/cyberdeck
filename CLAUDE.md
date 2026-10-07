# Cyberdeck — agent notes

Bun + TypeScript daemon (Hono, bun:sqlite) with a React/Vite/Tailwind UI. No Node, no npm —
use `bun` for everything.

- `src/daemon/` — the service. Entry: `main.ts`. HTTP+WS on 127.0.0.1:4777, bearer-token
  auth (`~/.cyberdeck/token`). SQLite at `~/.cyberdeck/cyberdeck.db`.
- `src/daemon/indexer/` — fs/git scanning and risk scoring.
- `src/cli/cyberdeck.ts` — CLI; installed as a shim by `install.sh`.
- `ui/` — Vite root; builds to `dist/ui`, served by the daemon.
- `src/daemon/api/control.ts` — the control module (Projects / Agents / Services views). It never
  parses the private Fleet repo itself: it shells out to `<fleetDir>/bin/fleet.ts … --json` (config
  `fleetDir`, default `~/Code/Fleet`), caches reads 20 s, probes services every 5 min, serves collab run
  logs from `~/.fleet/runs/<id>/`, and (when `collab.auto` is on) runs `fleet collab tick` on a timer.
  The JSON contract lives with the CLI; tests use the stub in `tests/fixtures/fleet/bin/fleet.ts`.
- `src/daemon/api/mcp.ts` — the MCP server (`POST /api/mcp`, Streamable HTTP, a fresh
  McpServer per request) that makes the node and the deck callable from Seed Agents. It reuses
  the `Control` handle `registerControlRoutes` returns; tool names stay short because Seed
  prefixes them (`cyberdeck__status`). Tests drive it with the real MCP client (`tests/mcp.test.ts`).
  Keep `docs/AGENTS.md` in sync when adding a tool.
- `docs/` — the knowledgebase. `docs/BRIEF.md` is the authoritative vision;
  `docs/ARCHITECTURE.md` is canonical for schema/API; `docs/ROADMAP.md` tracks milestones.
  Keep docs in sync when changing schema or routes.

Verify changes with `bun run typecheck`, `bun run build`, and `bun run test`
(63+ tests: unit + API + PTY + a sandboxed install.sh run + Playwright e2e that boots a
real daemon and drives the built UI in headless Chromium — run `bun run build` first so
e2e tests the current UI). `bun run test:unit` is the fast subset.

Fleet nodes auto-update: each daemon checks origin hourly (and 90s after boot),
sweeps peers every 15 min, and nudges any node on a different commit to update
(`autoUpdate` in config; POST /api/system/update). A `git push` to main is a
fleet-wide deploy within the hour, or within ~30s of any UI being open.

Gotchas:
- bun:sqlite named params need `$`-prefixed keys at bind time.
- `~/Code` is itself a stray git repo; the scanner special-cases roots that contain `.git`.
- The installed service runs from `~/.cyberdeck/src` (a clone), not this checkout.
  Public repo: https://github.com/ericvicenti/cyberdeck — both this checkout and
  `~/.cyberdeck/src` track it as origin. Deploy = commit + `git push`, then
  `git -C ~/.cyberdeck/src pull && (cd ~/.cyberdeck/src && bun install && bun run build)
  && cyberdeck restart`. Servers install via the curl one-liner in README.md.
- Shell scripts must be pure ASCII (bash parses multibyte chars into variable names under
  `set -u`); tests/install.test.ts enforces this.
- node-pty does not work under Bun; the web terminal uses `bun-pty`.
- Playwright e2e needs `bunx playwright install chromium` once per machine.

cmux: `src/daemon/api/cmux.ts` drives Eric's cmux terminal multiplexer through its CLI (`/Applications/cmux.app/Contents/Resources/bin/cmux` or PATH) with validated argv only; `ui/views/Cmux.tsx` is the view.

Live sessions + prompt bar: a terminal is a daemon-owned session (`src/daemon/sessions.ts`, routes in
`src/daemon/api/sessions.ts`: `/api/sessions`, WS `/api/sessions/:id/attach`, `/api/harness/caps`), not a
per-WebSocket PTY, so it keeps running when the browser leaves and any number of clients can attach and get the
backlog replayed. Runner `tmux` (session `cd-<id>`, re-attached on boot) survives daemon restarts; runner `pty` does
not, and `setUpdateGuard` defers auto-updates while any pty session runs (manual `POST /api/system/update` still
applies). Remote nodes: REST through `/api/nodes/:id/proxy/sessions…`, attach through `/api/nodes/:id/sessions/:sid/attach`.
The sticky prompt bar (`ui/components/PromptBar.tsx`, mounted in `App.tsx`) starts sessions from any view; the
auto harness selector is the pure planner `src/shared/harness.ts` (shared by UI and tests): `$ cmd` = shell,
`cc:`/`cx:` prefixes, `@node`, `#project`, plus plain mentions of hosts, projects, repos, "claude"/"codex"; it
uses the project's `hosts` to pick the machine and each node's caps (claude/codex/tmux on the login shell PATH) to
pick agent and runner, and reports `reasons` + `pinned` for the chips. `ui/lib/sessions.ts` is the client
(explicit node addressing, `useLiveSessions` polls every online node); `ui/views/Term.tsx` is tabs-over-sessions;
`ui/lib/terms.ts` keeps `openTerminal` for other views. `/api/term` (ephemeral PTY) still exists for the fleet proxy
and tests. `CYBERDECK_SESSIONS_TMUX=0` forces the pty runner (the e2e daemons set it so test sessions die with them).
Starting a `cc` session pre-accepts Claude Code's folder-trust prompt for that cwd (`trustClaudeDir` writes
`projects[<cwd>].hasTrustDialogAccepted` into `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`), so the agent
starts straight into the prompt. Tests: `tests/sessions.test.ts`, `tests/harness.test.ts`, e2e "prompt bar"/"sessions survive".
