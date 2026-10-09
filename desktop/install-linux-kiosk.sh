#!/bin/sh
# Run as the GNOME desktop user after installing Cyberdeck and its private apps.
set -eu
cd "$(dirname "$0")/.."
: "${CYBERDECK_KIOSK_URL:?Set the node's trusted Cyberdeck URL}"
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/autostart" "$HOME/.local/share/applications"
# Keep the old browser and its profile available for rollback, but start only Cyberdeck.
if [ -f "$HOME/.config/autostart/casework-afterglow.desktop" ]; then
  mv "$HOME/.config/autostart/casework-afterglow.desktop" "$HOME/.config/autostart/casework-afterglow.desktop.disabled"
fi
cat > "$HOME/.config/systemd/user/cyberdeck-kiosk.service" <<UNIT
[Unit]
Description=Cyberdeck fullscreen desktop and Casework remote screen
Wants=cyberdeck.service afterglow-tunnel.service
After=graphical-session.target cyberdeck.service
PartOf=graphical-session.target
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h/.cyberdeck/src
Environment=CYBERDECK_KIOSK_URL=$CYBERDECK_KIOSK_URL
ExecStart=%h/.bun/bin/bun run %h/.cyberdeck/src/desktop/kiosk.ts
Restart=on-failure
RestartSec=5
UNIT
cat > "$HOME/.config/autostart/cyberdeck.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Cyberdeck
Comment=Open your fleet and applications
Exec=systemctl --user start cyberdeck-kiosk.service
Icon=computer
Terminal=false
X-GNOME-Autostart-enabled=true
DESKTOP
install -m 644 "$HOME/.config/autostart/cyberdeck.desktop" "$HOME/.local/share/applications/cyberdeck.desktop"
if [ -d "$HOME/Desktop" ]; then install -m 755 "$HOME/.config/autostart/cyberdeck.desktop" "$HOME/Desktop/Cyberdeck.desktop"; fi
systemctl --user daemon-reload
systemctl --user stop afterglow-kiosk.service
systemctl --user start cyberdeck-kiosk.service
