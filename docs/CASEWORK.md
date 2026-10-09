# Casework Desk as a Cyberdeck client

Casework Desk is Eric's server-driven Expo app for iPad and iPhone (source: `~/Code/remote-control`,
TestFlight 1.0.0 (2)). It trusts one "workflow server" that supplies screens (TSX experiences),
receives device events and uploads, and can invoke native actions. Every Cyberdeck node is such a
server, so the app is a native client of the fleet: the protocol is implemented in
`src/daemon/api/casework.ts`, the screen in `casework/cyberdeck.tsx`.

## Pairing the app

1. Open the Cyberdeck Home page on the node you want the app to talk to (for the phone this is the
   HTTPS tailnet URL, e.g. `https://yacht.tail0bb35a.ts.net`, served by `cyberdeck serve`).
2. Scroll to **Casework Desk**: a QR code plus the address and pairing key. Beside it, **Phone · Desk**
   is a second QR for any phone browser: it opens the web Desk on the https tailnet origin, ready for
   Add to Home Screen (docs/VOICE.md, Phone home-screen button).
3. In the app open **Server settings** → **Scan pairing QR** (or type the address and key) →
   **Test connection** → **Use this server**.

The pairing key lives at `~/.cyberdeck/casework-key` (mode 0600) and is NOT the node token: a key
holder only reaches `/api/state`, `/api/modules/*`, `/api/command`, uploads, read-only control routes
(overview, sessions) and the collab `tick`/`run` actions (`caseworkAllows`). The node token works as a
pairing key too, for scripts. **Rotate key** on the card replaces it and disconnects paired devices.
Pairing grants the server authority to execute JavaScript inside the app, which is why the key must
only travel over the tailnet (HTTPS) and never through chat or notes.

## Screens

The home scene is the `RemoteModule` named `cyberdeck` (bundled from `casework/cyberdeck.tsx` with
`Bun.build`: CommonJS, native modules external, production JSX runtime). Tabs:

- **Deck**: the entire Cyberdeck web UI, every view the browser has, in the app's native WebView
  (inline, or **full screen** in a modal that keeps the current page). No credential is handed to the
  page: a device on the tailnet as the owner is trusted by the daemon exactly as in Safari; any other
  device gets the web UI's token prompt. The owner's device keeps full access even when the page carries
  the scoped pairing key (the screen remote stores it as the page token): the key narrows access for a
  holder who has nothing else and never downgrades the owner (`authenticate` in `server.ts`).
- **Apps**: what Applications shows in the browser. Example apps open natively on the device; web
  applications open in the Deck tab.

- **Fleet**: nodes online with repo/risk counts (`/api/fleet/nodes`), the manifest hosts, services
  that are not active, open handoff and task counts (`/api/control/overview`).
- **Agents**: the collab queue and runs; **Run next task** → `POST /api/control/collab/tick`, per-task
  **Run** → `POST /api/control/collab/run`.
- **Sessions**: searchable cc/cx sessions from every host (`/api/control/sessions`).
- **Run**: a bounded non-interactive command on the node (`POST /api/casework/run`, 60 s limit, output
  trimmed to 60 kB). Quick picks for `deck status`, `deck todo`, `deck services`.

Edit the TSX and `POST /api/experiences/validate` (or restart the daemon): connected devices get
`modules.changed` and reload. A screen that throws reports back to `/api/experiences/error` and shows
the error instead of crashing the app. Only modules in the app's native registry may be imported
(`NATIVE_MODULES` in api/casework.ts); anything else fails validation with the module name.

When `kiosk.enabled` is set (enuc), the scene is the `screen-remote` module instead: the app's
WebView shows the node's `/#/remote` page, a live stream of the kiosk browser with touch, keys and a
**Sound** row (mute, −, slider, +) that sets the node's system volume through `/api/audio`.

## Example apps: the kitchen sink

`CASEWORK_APPS` in `api/casework.ts` lists the example apps that run natively in the app; each is a
scene around one experience module. The first is the **Kitchen sink**, the whole Casework capability
gallery from `remote-control/experiences` (`casework/kitchen-sink.tsx`, pieces in `casework/kitchen/`,
sample media in `casework/samples/` served at `/samples/:name` with byte ranges): Agent, Overview,
Camera + QR, Audio + calls, Video, Graphics (the Lumen Drift GL game), Device, Files + OS, Web + forms.
`casework/voice-popover.tsx` is the voice control the app's own header always asks its server for.

Ways in:

- On the device: **Apps → Kitchen sink**, or the Kitchen sink card on the web Applications page inside
  the Deck tab (**Run on this device**; the page posts `{cyberdeck:"scene", name}` to the app). The
  gallery's **← Cyberdeck** returns home.
- From any browser: **Applications → Kitchen sink** (`#/applications?app=kitchen-sink`,
  `ui/views/CaseworkConsole.tsx`). It joins `/control` as a console and is the port of Casework's proof
  dashboard: pick a device, send the app to it (`POST /api/preset/kitchen-sink {deviceId?}`), switch
  its tabs and drive the native player (`POST /api/command`), show a QR for the camera to scan, and
  display what the device really reports (identity, live motion, uploads, every event). It also
  places and answers WebRTC calls with the device (`signal` frames relayed between the two roles;
  a device's `call.request` rings every open console). The browser needs microphone access, so calls
  work on localhost or the https tailnet origin. With no device connected it shows the pairing QR.

Scene navigation is per device and momentary: a device `scene` event (or a preset) moves that device,
and a reconnect lands on home again. `/api/state` and the console's device list carry each device's
current `scene`.

The gallery's Agent tab is Casework's Seed workspace. It talks to `/api/seed/*`, which this node
forwards to the Casework Seed bridge when one is configured: `"casework": { "url":
"http://127.0.0.1:3053", "tokenFile": "…" }` in `~/.cyberdeck/config.json` (or `SEED_BRIDGE_URL`; the
token file defaults to `~/Library/Application Support/CaseworkSeed/bridge-token`). The bridge
credential stays on the node. Without a bridge the tab says so and every other tab works.

## Voice

The app's AI call button talks to a Seed agent through this node (full design in `docs/VOICE.md`).
The flow is the one the shipped app already implements: `GET /api/voice/config` → when `provider`
is `livekit`, `POST /api/voice/livekit` → join the returned LiveKit room with the mic on and send
"Hi" on the `lk.chat` topic. Both routes, plus `/api/voice/status`, `/api/voice/transcript` and
`/api/voice/session/reset`, are open to the pairing key; `/api/voice/setup` needs the node token.
`voice.configured` on `/api/state` and in the `welcome` frame reports whether calls work (identity
loaded, agents server up with voice, agent set up by `cyberdeck seed setup`); when it is false the
`reason` says what is missing. Device-to-console WebRTC calls are answered by the Kitchen sink console (above).

## Limits

- No scene editor: scenes are the home scene and the example apps, not arbitrary JSON trees.
- The Run screen executes as the daemon's user: it is for status commands, not interactive tools.
- The QR encoder is byte-mode, ECC L; pairing links are ~110 bytes, well within its verified range
  (decoded with jsQR up to 300 bytes; a 1 kB payload did not decode).
