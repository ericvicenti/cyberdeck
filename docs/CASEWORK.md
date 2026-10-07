# Casework Desk as a Cyberdeck client

Casework Desk is Eric's server-driven Expo app for iPad and iPhone (source: `~/Code/remote-control`,
TestFlight 1.0.0 (2)). It trusts one "workflow server" that supplies screens (TSX experiences),
receives device events and uploads, and can invoke native actions. Every Cyberdeck node is such a
server, so the app is a native client of the fleet: the protocol is implemented in
`src/daemon/api/casework.ts`, the screen in `casework/cyberdeck.tsx`.

## Pairing the app

1. Open the Cyberdeck Home page on the node you want the app to talk to (for the phone this is the
   HTTPS tailnet URL, e.g. `https://yacht.tail0bb35a.ts.net`, served by `cyberdeck serve`).
2. Scroll to **Casework Desk**: a QR code plus the address and pairing key.
3. In the app open **Server settings** → **Scan pairing QR** (or type the address and key) →
   **Test connection** → **Use this server**.

The pairing key lives at `~/.cyberdeck/casework-key` (mode 0600) and is NOT the node token: a key
holder only reaches `/api/state`, `/api/modules/*`, `/api/command`, uploads, read-only control routes
(overview, sessions) and the collab `tick`/`run` actions (`caseworkAllows`). The node token works as a
pairing key too, for scripts. **Rotate key** on the card replaces it and disconnects paired devices.
Pairing grants the server authority to execute JavaScript inside the app, which is why the key must
only travel over the tailnet (HTTPS) and never through chat or notes.

## Screens

The scene is a single `RemoteModule` named `cyberdeck` (bundled from `casework/cyberdeck.tsx` with
`Bun.build`: CommonJS, native modules external, production JSX runtime). Tabs:

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

## Limits

- No voice/calls: `voice.configured` is false and call requests are answered with an error. The app
  still works with the voice adapter unset.
- No console role features (scene editor, call signaling); `/api/state` reports the fixed scene.
- The Run screen executes as the daemon's user: it is for status commands, not interactive tools.
- The QR encoder is byte-mode, ECC L; pairing links are ~110 bytes, well within its verified range
  (decoded with jsQR up to 300 bytes; a 1 kB payload did not decode).
