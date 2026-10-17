#!/usr/bin/env python3
"""Three-way navigation overlay with checked backups and atomic UI activation.

Package layout: before/<file>, after/<file>, manifest.json {files:[...]}. Only
listed files are merged. The target's unrelated edits and old hashed UI assets
are retained; no daemon, kiosk, terminal, or game process is restarted.
"""
import argparse
import datetime
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def ui_hashes(target):
    return {str(p.relative_to(target)): digest(p) for p in (target / 'ui').rglob('*') if p.is_file()}


def exact_overlay(current, before, after):
    """Resolve nearby unrelated edits only through unique, exact text anchors.

    Diff3 treats an adjacent added import/missing optional view as a conflict.
    This fallback still refuses any changed text that differs from the baseline;
    it never guesses which of two matching locations to modify.
    """
    old_lines, new_lines = before.splitlines(True), after.splitlines(True)
    value = current
    for tag, i, j, a, b in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes():
        if tag == 'equal':
            continue
        old, new = ''.join(old_lines[i:j]), ''.join(new_lines[a:b])
        if old:
            if value.count(old) != 1:
                match = None
                for width in range(8, 0, -1):
                    left = ''.join(old_lines[max(0,i-width):i])
                    right = ''.join(old_lines[j:j+width])
                    for needle, replacement in [(left+old+right,left+new+right),(old+right,new+right),(left+old,left+new)]:
                        if needle != old and value.count(needle) == 1:
                            match = (needle, replacement); break
                    if match: break
                if not match:
                    raise RuntimeError('Changed baseline text is absent or ambiguous')
                old, new = match
            value = value.replace(old, new, 1)
        else:
            if i == 0 and all(line.startswith('import ') for line in new.splitlines()):
                value = new + value
                continue
            # Prefer both sides, then a unique adjacent anchor. All untouched
            # target text remains byte-for-byte intact.
            candidates = []
            for width in range(8, 0, -1):
                left = ''.join(old_lines[max(0,i-width):i])
                right = ''.join(old_lines[i:i+width])
                if left and right and value.count(left+right) == 1:
                    candidates = [(left+right, left+new+right)]; break
            if not candidates:
                for width in range(8, 0, -1):
                    left = ''.join(old_lines[max(0,i-width):i])
                    right = ''.join(old_lines[i:i+width])
                    if left and value.count(left) == 1:
                        candidates = [(left, left+new)]; break
                    if right and value.count(right) == 1:
                        candidates = [(right, new+right)]; break
            if not candidates:
                raise RuntimeError('Insertion anchor is absent or ambiguous')
            old, new = candidates[0]
            value = value.replace(old, new, 1)
    return value.encode()

def run(args, cwd, log):
    with log.open('a') as output:
        result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f'{args[0:3]} failed ({result.returncode}); see {log}')


def bun_executable(target):
    found = shutil.which('bun')
    if found and os.path.isfile(found) and os.access(found, os.X_OK):
        return found
    local = target.parent.parent / '.bun/bin/bun'
    if local.is_file() and os.access(local, os.X_OK):
        return str(local)
    raise RuntimeError('Bun executable not found in PATH or ~/.bun/bin')


def restore_sources(target, backup, record):
    # Never roll a concurrent edit back over another writer.
    for rel, meta in record.items():
        if digest(target / rel) != meta['installed']:
            raise RuntimeError(f'Concurrent edit to {rel}; restore manually from {backup}')
    for rel, meta in record.items():
        path = target / rel
        if meta['before'] is None:
            path.unlink(missing_ok=True)
        else:
            shutil.copy2(backup / 'source' / rel, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path)
    parser.add_argument('--target', type=Path, default=Path.home() / '.cyberdeck/src')
    parser.add_argument('--check', action='store_true', help='prepare merges, but do not write or build')
    parser.add_argument('--rollback', type=Path)
    a = parser.parse_args()
    target = a.target.resolve()
    if a.rollback:
        backup = a.rollback.resolve()
        record = json.loads((backup / 'changes.json').read_text())
        restore_sources(target, backup, record)
        # Old assets were retained at install; restore the old index atomically.
        shutil.copy2(backup / 'dist/ui/index.html', target / 'dist/ui/index.html.rollback')
        os.replace(target / 'dist/ui/index.html.rollback', target / 'dist/ui/index.html')
        print(f'Rolled back source + index from {backup}; no services restarted')
        return
    if not a.package:
        parser.error('--package or --rollback required')
    package = a.package.resolve()
    manifest = json.loads((package / 'manifest.json').read_text())
    files = list(manifest['files'])
    for group in manifest.get('optionalGroups', []):
        if (target / group['when']).exists():
            files.extend(group['files'])
        else:
            print('Feature absent; skipped: ' + ', '.join(group['files']))
    merge_files = list(files)
    replacements = manifest.get('replacements', [])
    for item in replacements:
        rel = item['file']
        if rel not in files:
            files.append(rel)
    merged = {}
    before_hashes = {}
    with tempfile.TemporaryDirectory(prefix='navigation-merge-') as scratch:
        for rel in merge_files:
            if Path(rel).is_absolute() or '..' in Path(rel).parts:
                raise RuntimeError(f'Invalid package path {rel}')
            current, before, after = target / rel, package / 'before' / rel, package / 'after' / rel
            before_hashes[rel] = digest(current)
            if not after.is_file():
                raise RuntimeError(f'Missing overlay {rel}')
            if digest(current) == digest(after):
                continue
            if not before.exists():
                if current.exists():
                    raise RuntimeError(f'New file {rel} already exists with different content; refusing overwrite')
                merged[rel] = after.read_bytes()
            elif current.exists():
                r = subprocess.run(['git', 'merge-file', '-p', str(current), str(before), str(after)], capture_output=True)
                if r.returncode:
                    try:
                        merged[rel] = exact_overlay(current.read_text(), before.read_text(), after.read_text())
                    except RuntimeError as e:
                        raise RuntimeError(f'Merge conflict for {rel}: {e}; target untouched') from e
                    print('Applied exact owned edits around unrelated changes: ' + rel)
                else:
                    merged[rel] = r.stdout
            else:
                raise RuntimeError(f'Missing target file {rel}; target untouched')
        for item in replacements:
            rel, old, new = item['file'], item['old'], item['new']
            if not old or old == new:
                raise RuntimeError(f'Invalid exact replacement for {rel}')
            current = target / rel
            if not current.is_file():
                raise RuntimeError(f'Missing replacement target {rel}; target untouched')
            before_hashes.setdefault(rel, digest(current))
            value = merged.get(rel, current.read_bytes()).decode()
            if value.count(new) == 1 and old not in value:
                continue
            if value.count(old) != 1:
                if item.get('optional') and old not in value:
                    print('Optional owned text absent; skipped: ' + rel)
                    continue
                raise RuntimeError(f'Exact replacement text is absent or ambiguous in {rel}; target untouched')
            merged[rel] = value.replace(old, new, 1).encode()
    if a.check:
        print(json.dumps({'target':str(target),'mergeable':list(merged),'alreadyInstalled':len(files)-len(merged)}))
        return
    if not merged:
        print('Navigation overlay already installed; no writes')
        return
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = target.parent / 'backups' / ('navigation-' + stamp)
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copytree(target / 'dist/ui', backup / 'dist/ui')
    record = {}
    for rel, content in merged.items():
        if digest(target / rel) != before_hashes[rel]:
            raise RuntimeError(f'Concurrent edit before apply: {rel}')
        if (target / rel).exists():
            saved = backup / 'source' / rel
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target / rel, saved)
        record[rel] = {'before':before_hashes[rel],'installed':hashlib.sha256(content).hexdigest()}
    (backup / 'changes.json').write_text(json.dumps(record, indent=2) + '\n')
    for rel, content in merged.items():
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    try:
        expected_ui = ui_hashes(target)
        log = backup / 'validation.log'
        bun = bun_executable(target)
        run([bun, 'run', 'typecheck'], target, log)
        staged = backup / 'built-ui'
        run([bun, 'node_modules/vite/bin/vite.js', 'build', '--outDir', str(staged), '--emptyOutDir'], target, log)
        if expected_ui != ui_hashes(target):
            raise RuntimeError('UI changed concurrently during build; activation refused')
        # Copy assets before atomically replacing the entrypoint. Keep older assets
        # available for already-open pages and lazy imports. Never reload clients.
        dest = target / 'dist/ui'
        for path in staged.rglob('*'):
            if path.is_file() and path.relative_to(staged).as_posix() != 'index.html':
                to = dest / path.relative_to(staged)
                to.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, to)
        shutil.copy2(staged / 'index.html', dest / 'index.html.next')
        os.replace(dest / 'index.html.next', dest / 'index.html')
    except Exception:
        restore_sources(target, backup, record)
        raise
    (backup / 'complete').write_text('Source overlay, typecheck and staged build passed; UI activated without service restart.\n')
    print(json.dumps({'installed':list(merged),'backup':str(backup),'servicesRestarted':False}))


if __name__ == '__main__':
    main()
