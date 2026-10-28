# Probe fleet transport

Cyberdeck can use an enrolled Probe fleet instead of a VPN for peer traffic.
Set `probe: { "enabled": true }` in `~/.cyberdeck/config.json`; the default directory
is `~/.config/probe-network` (`stateDir` overrides it). The independent Probe
agent must be running and successfully synchronizing membership.

The dashboard's Probe panel shows relay membership separately from actual
Cyberdeck reachability. Terminal, Files and Desktop actions address the selected
machine. A relay connection alone does not claim that Cyberdeck or desktop
sharing works. Desktop Sharing/VNC or GNOME RDP still has to be available on the
host; headless servers retain terminal, files, service and agent access.

Paired Cyberdeck nodes acquire a persistent `nodes.probe_device` identity when
an unambiguous enrolled name matches. Fleet provisioning can set it explicitly.
The identity remains pinned across renaming or removal; failures never silently
switch an enrolled peer back to its old URL. Removing Probe membership therefore
cannot be masked by a still-working VPN connection. Existing non-Probe peers
retain their direct transport and are displayed accordingly.

Peer requests share a per-device loopback SSH forward to the remote Cyberdeck
port4777. OpenSSH uses Probe's private config, local device key and pinned host
keys, reaching the remote SSH service through Botical. Cyberdeck's API token
still authenticates each HTTP/WebSocket request inside that tunnel. Nothing new
listens publicly on a fleet computer. Terminal/session streams, binary desktop
frames, remote browsers, Seed agent subscriptions, files, audio/voice control,
network measurements and updater requests all use the same transport. MCP shell
and service commands select Probe SSH identities too.

The Probe portal at https://probe.vicenti.net/deck/ supplies browser access from
outside the fleet, including phones. Sign in through a paired Probe app, then
open Cyberdeck. The portal validates the short-lived browser session and account
before forwarding to Botical's Cyberdeck, injecting its token only server-side.
The gateway's account/token configuration is owner-readable service state at
`/var/lib/probe-network/cyberdeck.json`, never a browser token or public asset.
Mutations/WebSockets require the exact same origin; revocation closes active
streams. Probe's iOS Open Cyberdeck action approves its own browser sign-in.

## Deployment and verification

Canonical implementation is in the Cyberdeck repository. Preserve live PTY
sessions and installed overlays when updating. Enrolled Linux computers use a
Probe systemd user agent; macOS uses its existing LaunchAgent. Linux SSH endpoints
are advertised separately from Probe terminal support, so the iOS/Mac terminal
app does not offer an unavailable Linux Probe daemon.

Botical has only4GB RAM: deploy the prebuilt, source-matched UI from Clipper,
never run Vite builds there. Its automatic source/rebuild updater is disabled
for that reason. Other nodes can retain ordinary updates. Keep configuration,
SQLite online backups and prior UI assets before switching the runtime.

Tests exercise HTTP and text/binary WebSockets through the transport, concurrent
connection reuse, revoked/stale identity rejection, no legacy fallback, and
existing desktop/Seed-agent proxies. The Probe server separately tests browser
account isolation, origin enforcement, large streamed requests, protected tokens
and live WebSocket revocation. Verify deployed peers with actual `/api/status`,
file/session operations and desktop readiness; do not infer physical desktop
control solely from network presence.
