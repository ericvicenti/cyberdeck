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
supports follow-up messages, history, stop, rename and deletion. Queries go to a separate harness
agent (`Cyberdeck` on the server) that Cyberdeck configures like the terminal agents: a system
prompt carrying this node's `~/Code/AGENTS.md` and `Deck/AGENTS.md`, a memory pack with Claude
Code's project notes, the configured model and reasoning level, and MCP tools that reach the
machine (shell, files, `deck_context`) besides the deck tools. The voice companion keeps its spoken
persona. `cyberdeck seed sync` reapplies all of it; see docs/AGENTS.md "The harness".

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

### Music (inside Afterglow)

Afterglow has two halves in Cyberdeck: the media site in its frame (films, series, your
library) and the listening room Cyberdeck renders itself at **Applications → Afterglow →
Music** (`#/applications?app=afterglow&tab=music`). The listening room plays full music in
this browser through Spotify's Web Playback SDK with your existing Premium subscription and
can control Spotify Connect devices: home/search/history shelves, album, artist and playlist
pages, playlist editing, the queue, your library, radio mixes, in-page video, saved
recordings of what played here, fullscreen artwork and an immersive visualizer. There is no
standalone Spotify tab: `#/spotify` links are rewritten to the music tab.

One-time setup: create an app at <https://developer.spotify.com/dashboard>, enable Web API
and Web Playback SDK, and register the exact redirect URI displayed in the setup card
(e.g. `http://127.0.0.1:4777/`). Paste the public Client ID and choose Connect Spotify. No client
secret is needed. Spotify requires HTTPS except for literal loopback IPs. Tokens live only in
this tab's sessionStorage and go directly to Spotify; no Spotify credentials enter daemon
config or Git. To revoke app access, remove Cyberdeck from your Spotify account's connected apps.

### Casework: the whole deck on the iPad, and the kitchen sink

Pair the Casework Desk app with any node (Home → Casework Desk, or Applications → Connect Casework
remote; Tailscale on, scan the QR, **Use this server**). The app opens on **Deck**: the entire
Cyberdeck web UI in its native WebView, with a full-screen mode. **Apps** lists the example apps that
run natively on the device; the first is the **Kitchen sink**, the complete Casework capability gallery
(camera and QR, audio, calls, native video, the GL game, sensors, files, web), served by this node.

In any browser, **Applications → Kitchen sink** is its console: send the app to a paired device, switch
its tabs, scan a QR with its camera, watch its motion, uploads and events arrive, and place or answer
calls. Details: `docs/CASEWORK.md`.

### Full host desktop

Open **Desktop** (`#/desktop`) and select a host in the top-right node selector. **Connect**
shows its physical desktop with mouse, keyboard, touch, fullscreen and a text-entry field.
Disconnecting or changing hosts closes the control connection and leaves the desktop running.
The older kiosk remote still controls only Chromium; Desktop reaches the host's other apps too.

On GNOME/Wayland (enuc), enable **Settings → System → Remote Desktop → Desktop Sharing**
and run `desktop/install-remote-desktop.sh`. It builds the pinned Apache Guacamole 1.6.0
RDP gateway with the upstream GUACAMOLE-2328 compatibility fix for FreeRDP 3.31+, binds it only to `127.0.0.1:4822`, and reuses the existing GNOME credentials in
`~/.cyberdeck/desktop-rdp.json` (mode 600). It does not create a virtual desktop or change
GNOME's listener settings. The user service is `cyberdeck-desktop.service`.

On macOS, enable **System Settings → General → Sharing → Screen Sharing**, allow your
Mac user, and set `"desktop": { "enabled": true, "backend": "vnc" }` in
`~/.cyberdeck/config.json`, then restart Cyberdeck. Sign in with the Mac username/password
in the Desktop page. Credentials are used only for that connection, never saved. Use
Cyberdeck's private HTTPS address or localhost (SSH tunnel); Mac authentication requires a
secure browser context. Each host connects to its own loopback desktop service, including
when selected through another Cyberdeck node.

Both `/api/desktop/status` and `/api/desktop/stream` require full owner authentication;
Casework pairing keys cannot access them. The fleet WebSocket relay preserves binary VNC
frames. RDP credentials and targets stay server-side; clients cannot select arbitrary hosts
or ports. Desktop is disabled until configured. No new public ports are opened.

### Enuc desktop and buoy remote

Enuc opens the full Cyberdeck Home at login. **Applications → Afterglow** embeds the
private app while keeping Cyberdeck navigation. Configure applications in
`~/.cyberdeck/config.json` as `{ "applications": [{ "id": "afterglow", "name": "Afterglow",
"description": "Films and series", "url": "http://127.0.0.1:13031/" }], "kiosk": { "enabled": true } }`.
These URLs belong to the browser's machine: enuc's local tunnel is available on its
physical desktop; a remote controller sees that desktop rather than loading the app locally.

Embedded Afterglow mirrors its nested route into Cyberdeck as the encoded `route` parameter,
for example `#/applications?app=afterglow&route=title%2Fseries%2Ftt123%3Fseason%3D2`.
Refresh and Back/Forward restore that location; using Back after visiting another application
returns to the same Afterglow route. In-app URL changes do not remount the iframe. The bridge accepts messages only from
the configured frame and exact origin; it passes only Cyberdeck's origin to Afterglow, never a
token or the outer URL. Afterglow remains responsible for its standalone fragment history.

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


### TV and controller input

The fullscreen Linux kiosk supports spatial focus with **arrow keys**, **Enter/Space**
to select, and **Escape/Back** to close or return. A lime outline marks the selected
control. Selecting a text field opens an on-screen keyboard; selecting a slider
enters adjustment mode (Left/Right adjusts, Select/Back finishes). Lists and
confirmation dialogs remain inside the page, so gamepads can operate them.

Open **Controls** in the sidebar (also linked from Applications) for the controller
diagram, live button/axis display, remapping, stick calibration, and reset. Default
standard gamepads use D-pad for focus, A for Select, B for Back, X for the keyboard,
Y for Play/Pause, Back/Select for Home, Start for Controls, and LB/RB for page
scrolling. The left stick scrolls continuously with an adjustable dead zone and
speed. Other layouts can map both buttons and directional axes; duplicate button
assignments swap. Inputs must return to neutral after connecting or remapping.

The kiosk injects the input layer into embedded apps, including Afterglow, and
routes the controller to the focused frame (it follows `document.activeElement` down
through iframes on every press). Opening an app puts focus inside it; Down from its
title bar re-enters it; Up past its top edge or Back at its home leaves it. Every
connected controller works at once (wireless receivers often expose a second idle
pad). Back returns out of an app to the deck;
Home and Controls are always fixed Cyberdeck destinations. The kiosk starts at
`http://127.0.0.1:4777` (a secure browser context for Gamepad API), authenticates from
its existing local Cyberdeck token without a token URL, and saves mappings per
controller ID in `~/.cyberdeck/input.json` (mode 600). Pairing QR codes still use the
trusted fleet address from `CYBERDECK_KIOSK_URL`, so an iPad never pairs to its own
loopback address. Its service restarts after a
browser exit. App frame policies must allow that exact loopback origin as well as
any existing fleet origin. CDP stays on loopback; Casework's existing authenticated
remote-screen connection continues controlling this same browser.

Outside the kiosk, keyboard navigation and Controls also work in the web UI;
controller settings are local to that browser. Embedded cross-origin app control
requires the kiosk injection. Gamepad detection requires a compatible browser,
a secure origin, and usually a first button press. The diagram describes the
standard mapping, not a promise about an untested controller's printed labels.

### Retro games

Applications shows **Retro games** on nodes with RetroArch (`apt install retroarch
libretro-snes9x`; N64 uses `mupen64plus_next_libretro.so` from the libretro buildbot
in `~/.config/retroarch/cores`). ROMs go in `~/Games/snes` and `~/Games/n64` (one
subfolder level is scanned; config `games.dir` moves it). Selecting a game runs
RetroArch fullscreen on the node's screen; the deck ignores the controller until the
game exits. Cyberdeck layers `~/.cyberdeck/retroarch/cyberdeck.cfg` over the user's
RetroArch config (Xbox-pad autoconfig, auto save/load state so games resume, hotkeys
**Back + X** menu, **Back + RB/LB** save/load state). The way out does not depend on
RetroArch: while a game runs the daemon reads every controller's evdev device itself and
ends the game on **Home/Guide** or **Back + Start**, and RetroArch shows that hint on
screen a few seconds after starting (stdin `SHOW_MSG`). The kiosk polls
`/api/games/status` and ignores the controller while any game runs. **Add games**
(Applications, in any browser other than the TV itself) uploads ROMs or zips to the right
folder; nothing is overwritten. Each ROM is identified by CRC32 against the No-Intro DATs
from libretro-database (cached in `~/.cyberdeck/games-db`, refreshed monthly; N64 dumps are
normalised to .z64 byte order, SNES copier headers skipped), so `mk64.z64` shows as Mario
Kart 64 with libretro-thumbnails box art (cached in `~/.cyberdeck/games-art`). Audio goes
to PipeWire's default sink like every other app. API: `GET /api/games`, `GET
/api/games/status`, `POST /api/games/upload?name=`, `POST /api/games/:id/launch`,
`POST /api/games/stop`.

Validation: `bun test tests/tv-input.test.ts tests/tv-browser.test.ts tests/kiosk.test.ts tests/games.test.ts`
(browser tests launch an isolated headless Chromium with fixture pages and a virtual
controller; they do not start media downloads or operate fleet services).
