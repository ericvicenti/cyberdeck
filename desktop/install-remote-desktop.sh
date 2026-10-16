#!/usr/bin/env bash
# Browser access to the existing GNOME desktop. Does not replace the login session.
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then
  echo 'On macOS, enable Screen Sharing in System Settings > General > Sharing.'
  exit 1
fi
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
command -v grdctl >/dev/null || { echo 'GNOME Remote Desktop is required.'; exit 1; }
if [[ ! -x "$HOME/.local/sbin/guacd" ]]; then
  sudo apt-get install -y --no-install-recommends build-essential libtool-bin autoconf automake pkg-config \
    libcairo2-dev libjpeg-turbo8-dev libpng-dev uuid-dev freerdp3-dev libssl-dev libwebp-dev libpango1.0-dev
  build_dir=$(mktemp -d)
  trap 'rm -rf "$build_dir"' EXIT
  cd "$build_dir"
  curl -fsSLO https://archive.apache.org/dist/guacamole/1.6.0/source/guacamole-server-1.6.0.tar.gz
  curl -fsSLO https://archive.apache.org/dist/guacamole/1.6.0/source/guacamole-server-1.6.0.tar.gz.sha256
  sha256sum -c guacamole-server-1.6.0.tar.gz.sha256
  tar xzf guacamole-server-1.6.0.tar.gz
  cd guacamole-server-1.6.0
  patch -p1 < "$script_dir/guacd-freerdp3.patch"
  # New FreeRDP headers mark compatibility APIs deprecated; do not let that
  # break configure's feature detection on Ubuntu 26.04.
  CFLAGS='-O2 -Wno-error -Wno-deprecated-declarations' ./configure --prefix="$HOME/.local" \
    --with-freerdp-plugin-dir="$HOME/.local/lib/freerdp3" --disable-guacenc --disable-guaclog \
    --without-ssh --without-telnet
  make -j2
  make install
fi
python3 - <<'PY'
import datetime, json, os, pathlib, subprocess
home = pathlib.Path.home()
state = home / '.cyberdeck'
config = state / 'config.json'
result = subprocess.run(['grdctl', 'status', '--show-credentials'], capture_output=True, text=True, check=True)
credentials = {}
for line in result.stdout.splitlines():
    for key in ['Username', 'Password']:
        if line.strip().startswith(key + ':'):
            credentials[key.lower()] = line.strip().split(':', 1)[1].strip().strip("'")
if any(not credentials.get(key) or credentials[key] in ['(empty)', '(hidden)'] for key in ['username', 'password']):
    raise SystemExit('Enable GNOME Settings > System > Remote Desktop > Desktop Sharing and set login details first.')
backup = state / ('config.before-desktop-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.json')
backup.write_bytes(config.read_bytes())
os.chmod(backup, 0o600)
secret = state / 'desktop-rdp.json'
fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(credentials, f)
os.chmod(secret, 0o600)
cfg = json.loads(config.read_text())
cfg['desktop'] = {'enabled': True, 'backend': 'rdp', 'credentialsFile': str(secret)}
config.write_text(json.dumps(cfg, indent=2) + '\n')
unit = home / '.config/systemd/user/cyberdeck-desktop.service'
unit.parent.mkdir(parents=True, exist_ok=True)
unit.write_text('''[Unit]
Description=Cyberdeck desktop gateway
After=graphical-session.target

[Service]
ExecStart=%h/.local/sbin/guacd -f -b 127.0.0.1 -p 4822
Environment=LD_LIBRARY_PATH=%h/.local/lib
Restart=on-failure

[Install]
WantedBy=default.target
''')
subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
subprocess.run(['systemctl', '--user', 'enable', '--now', 'cyberdeck-desktop.service'], check=True)
print('Desktop gateway installed. Restart Cyberdeck, then open Desktop and Connect.')
PY
