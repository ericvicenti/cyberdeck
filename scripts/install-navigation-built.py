#!/usr/bin/env python3
"""Install an exact, locally verified UI overlay without rebuilding or restarting.

The package fingerprints every compiler input in the captured host tree. Only
listed source files change; other overlays and old assets are retained. This is
also usable on small hosts that cannot safely run a production Vite build.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def content_file(path):
    # macOS tar may materialize AppleDouble resource forks. They are metadata,
    # not compiler inputs or served assets, and BSD tar may consume them again.
    return path.is_file() and not any(part.startswith("._") for part in path.parts)


def inputs(root):
    paths = [p for name in ('ui', 'src') for p in (root / name).rglob('*') if content_file(p)]
    paths += [root / name for name in ('package.json', 'bun.lock', 'tsconfig.json', 'vite.config.ts') if (root / name).is_file()]
    return {str(p.relative_to(root)): digest(p) for p in sorted(paths)}


def validate_paths(paths):
    for name in paths:
        p = Path(name)
        if p.is_absolute() or '..' in p.parts or not p.parts:
            raise RuntimeError('Invalid package path: ' + name)


def copy_assets(source, destination):
    for path in source.rglob('*'):
        if content_file(path) and path.relative_to(source).as_posix() != 'index.html':
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def activate(source, target):
    temporary = target.with_name('index.html.navigation-next')
    shutil.copy2(source, temporary)
    os.replace(temporary, target)


def restore_source(target, backup, record):
    for rel in record['files']:
        current = digest(target / rel)
        if current != record['afterInputs'].get(rel):
            raise RuntimeError('Newer source edit; refusing rollback: ' + rel)
    for rel in record['files']:
        if rel in record['beforeInputs']:
            shutil.copy2(backup / 'source' / rel, target / rel)
        else:
            (target / rel).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=Path.home() / '.cyberdeck/src')
    parser.add_argument('--package', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    target = args.target.resolve()
    ui = target / 'dist/ui'
    if args.rollback:
        backup = args.rollback.resolve()
        record = json.loads((backup / 'record.json').read_text())
        if inputs(target) != record['afterInputs'] or digest(ui / 'index.html') != record['installedIndex']:
            raise RuntimeError('Newer source or UI deployment; refusing rollback')
        restore_source(target, backup, record)
        copy_assets(backup / 'ui', ui)
        activate(backup / 'ui/index.html', ui / 'index.html')
        print(json.dumps({'rollback':str(backup),'servicesRestarted':False}))
        return
    if not args.package:
        parser.error('--package or --rollback is required')
    package = args.package.resolve()
    record = json.loads((package / 'manifest.json').read_text())
    validate_paths(record['files'])
    expected = record['beforeInputs'].copy()
    for rel in record['files']:
        if not rel.startswith(('ui/', 'src/')):
            raise RuntimeError('Source overlay outside UI/daemon: ' + rel)
        value = digest(package / 'after' / rel)
        if value is None:
            raise RuntimeError('Missing overlay source: ' + rel)
        expected[rel] = value
    if expected != record['afterInputs']:
        raise RuntimeError('Overlay does not match the verified build inputs')
    if digest(package / 'ui/index.html') != record['installedIndex']:
        raise RuntimeError('Build entrypoint hash mismatch')
    # Verify the complete served artifact, including every dynamic chunk.
    assets = {str(p.relative_to(package / 'ui')): digest(p) for p in (package / 'ui').rglob('*') if content_file(p)}
    if assets != record['assets']:
        raise RuntimeError('Build assets changed after verification')
    if inputs(target) != record['beforeInputs']:
        raise RuntimeError('Target source changed since capture; reconcile before deploying')
    old_index = digest(ui / 'index.html')
    if not old_index:
        raise RuntimeError('No serving UI to back up')
    if args.check:
        print(json.dumps({'checked':str(target),'files':record['files']}))
        return
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup = target.parent / 'backups' / ('navigation-' + stamp)
    backup.mkdir(parents=True)
    shutil.copytree(ui, backup / 'ui')
    for rel in record['files']:
        if (target / rel).exists():
            saved = backup / 'source' / rel
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target / rel, saved)
    (backup / 'record.json').write_text(json.dumps(record, indent=2) + '\n')
    if inputs(target) != record['beforeInputs'] or digest(ui / 'index.html') != old_index:
        raise RuntimeError('Concurrent edit during backup; no source changed')
    for rel in record['files']:
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(package / 'after' / rel, path)
    try:
        if inputs(target) != record['afterInputs']:
            raise RuntimeError('Concurrent source change; activation refused')
        copy_assets(package / 'ui', ui)
        if inputs(target) != record['afterInputs'] or digest(ui / 'index.html') != old_index:
            raise RuntimeError('Concurrent change before activation; activation refused')
        activate(package / 'ui/index.html', ui / 'index.html')
    except Exception:
        restore_source(target, backup, record)
        raise
    (backup / 'complete').write_text('Verified prebuilt source/UI overlay; no service restart.\n')
    print(json.dumps({'backup':str(backup),'files':record['files'],'servicesRestarted':False}))


if __name__ == '__main__':
    main()
