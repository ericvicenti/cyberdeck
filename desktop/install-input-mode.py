#!/usr/bin/env python3
"""Install the additive shared-input UI overlay without replacing host UI bundles.

Run from the installed Cyberdeck source checkout. Existing native/kiosk overlays and
compiled application code are retained. Clients pick up this script on their next reload.
"""
import datetime, hashlib, pathlib, re, shutil
root = pathlib.Path(__file__).resolve().parent.parent
source = root/'ui/public/input-mode.js'
data = source.read_bytes()
version = hashlib.sha256(data).hexdigest()[:12]
backup = pathlib.Path.home()/'.cyberdeck/backups'/('input-mode-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
def write(path, content):
    if path.exists() and path.read_bytes() == content: return
    if path.exists():
        saved = backup/path.relative_to(root); saved.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(path,saved)
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.casework-tmp');temp.write_bytes(content);temp.replace(path)
for path in [root/'ui/index.html',root/'dist/ui/index.html']:
    if not path.is_file(): continue
    html=path.read_text()
    html=re.sub(r'\s*<script[^>]+src=["\']/input-mode\.js[^"\']*["\'][^>]*></script>','',html)
    assert '<head>' in html, path
    html=html.replace('<head>', '<head>\n    <script src="/input-mode.js?v='+version+'"></script>',1)
    # Publish JS before HTML so a reload can never see a missing resource.
    if path.parent.name=='ui' and path.parent.parent.name=='dist': write(path.parent/'input-mode.js',data)
    write(path,html.encode())
entry=root/'desktop/input-entry.ts'
if entry.is_file() and '../ui/public/input-mode.js' not in entry.read_text():
    write(entry,('import "../ui/public/input-mode.js";\n'+entry.read_text()).encode())
print('Installed shared input mode '+version+'; existing UI bundles retained')
