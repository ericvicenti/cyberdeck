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

Open **Spotify** in the sidebar or Applications for the custom **Listening room**. Catalog
navigation stays inside Cyberdeck: search songs/artists/albums/playlists, follow artist credits,
open album and playlist pages, browse liked songs, saved albums, followed artists, recent plays,
and your listening journal. Create private playlists, rename editable playlists, add/remove songs,
and move tracks up. Queue supports viewing and adding songs; Spotify does not expose removal or
reordering of its live queue. Radio mixes searches available playlists, not personalized radio.
Some development-mode apps cannot read other owners' playlist contents; context playback remains
available and the page explains the restriction. Search pages through ten results per category at a time.

Playback uses the Web Playback SDK and Spotify Connect. Press Play on a song, album, or playlist;
with no selected or active device, the browser player connects automatically before playback starts.
Other devices can be selected under Playback & connection. Shuffle/repeat, seek, volume, skip and
transfer stay in-app. Clicking artwork opens
a full-viewport listening view, with browser fullscreen where supported and an explicit close
button (Escape also exits). The player remains mounted across dashboard navigation. Changing the
fleet node selector does not move playback or the music archive.

Eligible music videos appear automatically in Spotify's embedded track panel. **Watch here** pauses
SDK/Connect audio before enabling interaction; resuming custom audio remounts the preview so the
players do not overlap. The frame cannot open popups or navigate the parent app. Spotify decides
video eligibility, sign-in and autoplay behavior; the SDK itself is audio-only. This is not a
custom video streaming API and video availability has not been verified with Eric's account.

The public Client ID `6dc6300fa4364a81acb8a5f5e920f809` is hardcoded from Eric's existing
**Cyberdeck** app, verified in Spotify's dashboard on 2026-10-11. No setup field or client
secret is needed. Its currently registered callback is `http://127.0.0.1:4777/`; other origins
must be registered in that existing app before they can authorize. Premium and DRM-capable browser playback are required. Spotify
requires HTTPS except literal loopback IPs; plain HTTP tailnet URLs and `localhost` are unsupported.
OAuth sign-in necessarily visits Spotify and returns here; there are no external player links.
PKCE uses a one-use state with a ten-minute expiry. Tokens stay in tab sessionStorage and are sent
only to Spotify. The public Client ID is shared in source. **Renew permissions** grants the new
library/playlist scopes to an existing connection. Other accounts must be permitted in the app's
Spotify User Management when development-mode restrictions apply.

Fetched metadata and observed playback transitions are saved automatically to IndexedDB and to
this serving node's `music_archive` table in `~/.cyberdeck/cyberdeck.db`, with account isolation and
no automatic expiry/pruning. API responses are latest snapshots per request path; the listening
journal appends observed track changes. This is not a complete Spotify lifetime history. Polling
runs every ten seconds while the document is visible, and SDK events capture browser track changes.
Play defaults to this browser, including when another device is active. Explicit device selections
remain available in Playback & connection.
Browser playback also records audio through a same-origin SDK frame and the media element's Web
Audio output. The vendored bootstrap changes only its frame URL; the official embedded player still
handles authorization and protected playback. The tap never reads keys or licenses. MediaRecorder
checkpoints real WebM/Opus (or supported MP4) audio in IndexedDB every two seconds, finalizes on
pause/seek/track change, and backs up finalized intervals in SQLite. Ten-minute segments bound memory.
Listening journal → Saved audio plays local blobs without Spotify or a network and exports audio.
It records only portions actually played here, not unplayed songs, videos, artwork bytes, or another
device's output. Unsupported/silent output and storage failures are shown, not marked saved.
Keep the page open when offline; reopening localhost works while this node is running. Browser
storage can be evicted unless persistence is granted; back up the node's SQLite database normally. Browser-local writes survive node sync failures;
opening the journal/export retries them. Storage errors remain visible rather than claiming a save.
**Music archive → Export metadata** downloads a portable JSON backup of browser and node records;
**Protect storage** requests browser persistence where supported. Disconnect deletes this account's
browser/node archive and tokens; export first to retain a backup. Account disconnect is kept pending
if node deletion fails, so it can be retried. Existing Spotify playlists/likes remain on Spotify.

Validation: `bun run typecheck`, `bun run build`, then
`bun test tests/music.test.ts tests/spotify.test.ts tests/spotify-e2e.test.ts`. Browser tests use an
isolated account/API/SDK fixture; they do not establish real Premium audio or video availability.

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
