#!/usr/bin/env python3
"""Add the native Spotify bridge without replacing the host's richer listening room."""
import pathlib,subprocess,hashlib,re,shutil,datetime
root=pathlib.Path(__file__).resolve().parent.parent
backup=pathlib.Path.home()/'.cyberdeck/backups'/('spotify-bridge-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
bun=shutil.which('bun') or str(pathlib.Path.home()/'.bun/bin/bun')
output=root/'dist/ui/spotify-bridge.js'
output.parent.mkdir(parents=True,exist_ok=True)
if output.exists():
 backup.mkdir(parents=True,exist_ok=True);shutil.copy2(output,backup/output.name)
# Reconcile only the older client's missing defaults; keep richer host implementations.
lib=root/'ui/lib/spotify.ts'
old=lib.read_text();new=old.replace('localStorage.getItem(PREFIX + "client-id") || ""','localStorage.getItem(PREFIX + "client-id") || "6dc6300fa4364a81acb8a5f5e920f809"')
new=new.replace('playlist-read-private playlist-read-collaborative"','playlist-read-private playlist-read-collaborative user-library-read user-follow-read"')
new=new.replace('return res.status === 204 ? null as T : res.json();','if (res.status === 204) return null as T;\n  const text = await res.text();\n  if (!text || text === "OK") return null as T;\n  return JSON.parse(text) as T;')
if new!=old:
 backup.mkdir(parents=True,exist_ok=True);shutil.copy2(lib,backup/'spotify.ts');lib.write_text(new)
temp=output.with_suffix('.tmp.js')
subprocess.run([bun,'build','ui/lib/spotify-bridge.ts','--target','browser','--outfile',str(temp)],cwd=root,check=True)
temp.replace(output)
version=hashlib.sha256(output.read_bytes()).hexdigest()[:12]
for path,src in [(root/'ui/index.html','/lib/spotify-bridge.ts'),(root/'dist/ui/index.html','/spotify-bridge.js?v='+version)]:
 if not path.exists():continue
 html=path.read_text();html=re.sub(r'\s*<script[^>]+src=["\'][^"\']*spotify-bridge[^"\']*["\'][^>]*></script>','',html)
 html=html.replace('</head>','<script type="module" src="'+src+'"></script>\n</head>')
 backup.mkdir(parents=True,exist_ok=True);shutil.copy2(path,backup/(path.parent.parent.name+'-index.html'))
 tmp=path.with_suffix('.html.tmp');tmp.write_text(html);tmp.replace(path)
print('Installed Spotify bridge '+version+'; existing sign-ins and UI retained')
