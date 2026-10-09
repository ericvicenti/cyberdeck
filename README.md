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

The prompt bar at the bottom of every view starts a **Seed agents** conversation by default. It
chooses a reachable fleet node with a configured Seed server and signing identity; Yacht already
hosts one. A query creates a durable session on that server, opens its replies in Sessions, and
supports follow-up messages, history, stop, rename and deletion. Queries use a separate Cyberdeck
Queries agent so voice calls and their short spoken-reply instructions remain independent.

Use `seed:`, `cc:`, `cx:` or `$` to choose Seed, Claude Code, Codex or a shell explicitly. The agent
chip and default-preference control offer the same choices (shell is per query). `@node` pins the
server/machine; `#project` and the current view supply work context. If no Seed server is ready,
Start is disabled with an explanation. Configure a node with `cyberdeck seed setup`; text queries
do not require voice support. Terminal sessions retain their existing PTY/tmux behavior.

Cyberdeck is an MCP server for [Seed Agents](https://hyper.media) and any other MCP client:
`POST /api/mcp` (Streamable HTTP, bearer token). Its tools expose the node and the deck: repo
risk, hosts and services, the project tree, the agents' handoff, the cross-host session index,
and the cc/cx collab queue, so a hosted agent can see every machine and hand work to a laptop
agent. `cyberdeck mcp` prints what to paste into the agent's Tools tab. Details: [docs/AGENTS.md](docs/AGENTS.md).

## Docs

Start at [docs/OVERVIEW.md](docs/OVERVIEW.md). The vision is in
[docs/BRIEF.md](docs/BRIEF.md), the milestone plan in [docs/ROADMAP.md](docs/ROADMAP.md).

### Network constellation

Home includes an interactive logical topology of paired machines plus hosts and expected
services from Deck's `fleet.json`. Choose a source and destination or click a host to see
both transfer directions, median HTTP round-trip latency, sample age, and failures. These
are host-to-host application measurements, not physical routing, live service health,
UDP voice quality, or a saturated line-speed benchmark. A gray host dot means telemetry
is unavailable; it does not prove the machine is offline. Unpaired hosts remain visible.

Each daemon tests one due peer at a time, staggered at startup and checked every two
minutes. A peer is due six hours after its last attempt, including failures. Each attempt
uses three small round trips and 4 MiB of random data each way (8 MiB total). Manual tests
have a one-minute per-peer cooldown; receivers cap test traffic at 32 MiB/minute and each
transfer times out after 15 seconds. The newest 512 samples persist in the daemon's SQLite
database across restarts. Tests continue with the dashboard closed. Set
`"network": {"automatic": false}` in `~/.cyberdeck/config.json` and restart to pause automatic
tests; manual tests still work.

All network routes require normal Cyberdeck authentication: `GET /api/network` returns
inventory/history, `POST /api/network/test` accepts `{ "target": "<paired node id>" }`, and
`GET /api/network/ping` plus `GET/POST /api/network/payload` implement the bounded probe.
Remote-source tests run on that source through the existing fleet proxy, with its own
paired credentials. Every participating daemon needs the network update; an unpaired or
unreachable source/target reports that condition rather than an inferred speed.

### Spotify app

Open **Spotify** in the sidebar or Applications, then **Open Spotify player**. The default
experience uses Spotify's official web player in a separate tab with your existing Spotify
login and subscription: no Developer app, Client ID, or configuration. **Open Spotify app**
launches the installed app on the viewing device; search opens Spotify's own search. Keep the
player tab open while using Cyberdeck. Spotify's full website does not allow embedding in
Cyberdeck (its Content-Security-Policy restricts frame ancestors).

The collapsed **Advanced: custom Cyberdeck player** option is for users who explicitly want
custom controls. It plays full music through Spotify's Web Playback SDK with your existing Premium subscription and can control Spotify Connect
devices. Search songs, play a Spotify track/album/playlist link, browse your playlists, and
use play/pause, skip, seek, volume, and device transfer. The player stays mounted while you
browse other dashboard views; closing/reloading the page disconnects the browser player.
The fleet node selector does not move playback to that machine.

One-time setup: create an app at <https://developer.spotify.com/dashboard>, enable Web API
and Web Playback SDK, and register the exact redirect URI displayed in Spotify's setup card
(e.g. `http://127.0.0.1:4777/`). Paste the public Client ID and choose Connect Spotify. No client
secret is needed. Spotify requires HTTPS except for literal loopback IPs; plain HTTP tailnet
URLs and `localhost` are not supported. On a remote machine use Cyberdeck's HTTPS URL.
In development mode, add any other account under the Spotify app's User Management.

After connecting, choose **Enable browser playback**, then play a song or choose **Listen
here** to transfer your current music. Protected-content/DRM support is required; if the
browser cannot play, select a Spotify desktop/mobile device instead. Playback only starts
on an explicit action. Autoplay restrictions may require pressing Play again.

OAuth uses PKCE, a single-use state with a ten-minute expiry, and automatic token refresh.
Spotify tokens live only in this tab's sessionStorage and go directly to Spotify; the
public Client ID is remembered in localStorage. Disconnect clears local tokens and stops
this browser player (other Spotify devices keep their playback). To revoke app access
entirely, remove Cyberdeck from your Spotify account's connected apps. Sign in separately
on each browser/origin. Search uses the current development-mode limit of ten results;
rate-limit responses honor Retry-After. No Spotify credentials enter daemon config or Git.


### Casework: the whole deck on the iPad, and the kitchen sink

Pair the Casework Desk app with any node (Home → Casework Desk, or Applications → Connect Casework
remote; Tailscale on, scan the QR, **Use this server**). The app opens on **Deck**: the entire
Cyberdeck web UI in its native WebView, with a full-screen mode. **Apps** lists the example apps that
run natively on the device; the first is the **Kitchen sink**, the complete Casework capability gallery
(camera and QR, audio, calls, native video, the GL game, sensors, files, web), served by this node.

In any browser, **Applications → Kitchen sink** is its console: send the app to a paired device, switch
its tabs, scan a QR with its camera, watch its motion, uploads and events arrive, and place or answer
calls. Details: `docs/CASEWORK.md`.

### Enuc desktop and buoy remote

Enuc opens the full Cyberdeck Home at login. **Applications → Afterglow** embeds the
private app while keeping Cyberdeck navigation. Configure applications in
`~/.cyberdeck/config.json` as `{ "applications": [{ "id": "afterglow", "name": "Afterglow",
"description": "Films and series", "url": "http://127.0.0.1:13031/" }], "kiosk": { "enabled": true } }`.
These URLs belong to the browser's machine: enuc's local tunnel is available on its
physical desktop; a remote controller sees that desktop rather than loading the app locally.

`desktop/kiosk.ts` owns a fullscreen Chromium window in `~/.cyberdeck/kiosk-profile`,
independent of the daemon. `desktop/install-linux-kiosk.sh` creates GNOME autostart and
`cyberdeck-kiosk.service`; run with `CYBERDECK_KIOSK_URL=http://enuc.tail0bb35a.ts.net:4777`.
The browser waits for authenticated Cyberdeck access and does not wait for Afterglow.
Install the matching browser first (`bun x --no-install playwright install chromium`).
Chromium sandboxing stays enabled. Ubuntu may require an AppArmor `userns` profile
for the exact installed Chromium executable; enuc's is `/etc/apparmor.d/cyberdeck-kiosk`.
After Playwright upgrades, update this profile to the new executable path. The current
2× device scale makes the 4K display render a 1920×1080 CSS viewport.

On buoy, keep Tailscale connected and open Casework **Server settings → Scan pairing QR**.
Show the QR from enuc's **Applications → Connect Casework remote**, then select **Use this server**.
The existing native app downloads `casework/screen-remote.tsx`; no new app build is needed.
This grants control of the whole Cyberdeck screen, including its terminal/file interfaces.
The remote shows enuc's actual window, supports tap/drag, scroll mode, hardware keys,
text entry, navigation and playback keys. Sound remains on enuc. It reconnects automatically;
remote devices never resize the physical display. `#/remote` also works in a trusted browser.

Only the authenticated `/api/kiosk/stream` route exposes the screen. The Casework key is
allowed this route, not other browser profiles. Chromium debugging stays at loopback
`127.0.0.1:9223`. The Afterglow tunnel stays at loopback `127.0.0.1:13031`; its server allows
framing only by the configured exact Cyberdeck origin. Original Firefox profile and launcher
remain as a fallback; the old Afterglow GNOME autostart is renamed `.desktop.disabled`.
