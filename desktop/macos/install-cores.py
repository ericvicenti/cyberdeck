"""Install checksum-pinned native ARM64 cores from the official Libretro buildbot."""
import hashlib, io, json, os, pathlib, subprocess, urllib.request, zipfile
root = pathlib.Path.home() / 'Library/Application Support/Casework/cores'
root.mkdir(parents=True, exist_ok=True)
manifest = json.loads(pathlib.Path(__file__).with_name('cores.json').read_text())
for core in manifest:
    target = root / core['file']
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == core['binarySha256']:
        print('Verified', core['file']); continue
    data = urllib.request.urlopen(core['url'], timeout=60).read(40 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != core['sha256']:
        raise RuntimeError('Upstream core changed: ' + core['file'] + '; review and update the manifest deliberately.')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        binary = archive.read(core['file'])
    if hashlib.sha256(binary).hexdigest() != core['binarySha256']:
        raise RuntimeError('Binary checksum mismatch')
    temp = target.with_suffix('.tmp'); temp.write_bytes(binary)
    info = subprocess.check_output(['file', str(temp)], text=True)
    if 'arm64' not in info: raise RuntimeError('Not an ARM64 core')
    os.replace(temp, target)
    print('Installed', core['file'])
