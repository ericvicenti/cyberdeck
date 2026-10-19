#!/bin/sh
# Run as the logged-in Linux desktop user, after installing Steam, python3 and wmctrl.
set -eu
[ "$(uname -s)" = Linux ] || { echo 'Steam integration is Linux-only'; exit 1; }
command -v python3 >/dev/null
command -v wmctrl >/dev/null
steam_exec=$(command -v steam || true)
[ -n "$steam_exec" ] || steam_exec=/usr/games/steam
[ -x "$steam_exec" ] || { echo 'Install the native Steam client first'; exit 1; }
mkdir -p "$HOME/.config/systemd/user/cyberdeck-kiosk.service.d"
cat > "$HOME/.config/systemd/user/cyberdeck-steam.service" <<UNIT
[Unit]
Description=Steam background client for Cyberdeck Vault
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=$steam_exec -silent -cef-enable-debugging -devtools-ip 127.0.0.1 -devtools-port 8080
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=graphical-session.target
UNIT
cat > "$HOME/.config/systemd/user/cyberdeck-kiosk.service.d/steam.conf" <<'UNIT'
[Unit]
Wants=cyberdeck-steam.service
After=cyberdeck-steam.service
UNIT
systemctl --user daemon-reload
systemctl --user enable cyberdeck-steam.service
printf '%s\n' 'Steam will start privately in the background with Cyberdeck. Start cyberdeck-steam.service after closing an existing Steam session.'
