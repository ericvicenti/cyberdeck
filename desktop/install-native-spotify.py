"""Add native Spotify routes to an installed daemon without replacing fleet overlays.

Run with the deployment checkout as cwd after copying spotify-native.ts. Does not
restart the daemon: the caller must preserve live PTY sessions before activation.
"""
from pathlib import Path
import datetime
import shutil

root = Path.cwd()
p = root / 'src/daemon/server.ts'
s = p.read_text()
import_line = 'import { registerNativeSpotifyRoutes } from "./api/spotify-native";'
registration = '  registerNativeSpotifyRoutes(app, isFullAuth, cfg.port);'
assert (root / 'src/daemon/api/spotify-native.ts').is_file()
if import_line not in s:
    s = import_line + '\n' + s
if registration not in s:
    lines = s.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines) if line.startswith('  const isFullAuth =')]
    assert len(matches) == 1 and lines[matches[0]].rstrip().endswith(';'), 'Unexpected auth layout; reconcile manually'
    lines.insert(matches[0] + 1, registration + '\n')
    s = ''.join(lines)
if s != p.read_text():
    backup = root.parent / 'backups' / ('native-spotify-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, backup / 'server.ts')
    p.write_text(s)
print('Native Spotify routes installed; existing daemon overlays preserved')
