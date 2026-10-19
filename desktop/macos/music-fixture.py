"""Isolated catalog and Connect fixture. Use only Casework --verify --music-fixture."""
import json,threading,uuid,sys,pathlib,urllib.request
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
track={'id':'track1','uri':'spotify:track:track1','type':'track','name':'Evening light','duration_ms':240000,'artists':[{'name':'The fixtures'}],'album':{'name':'Night drive','images':[]}}
playlist={'id':'list1','uri':'spotify:playlist:list1','type':'playlist','name':'Evening playlist','images':[]}
album={'id':'album1','uri':'spotify:album:album1','type':'album','name':'Night drive','images':[]}
device={'id':'clipper-test','name':'Clipper fixture','is_restricted':False,'volume_percent':50}
playback={'item':track,'is_playing':False,'progress_ms':32000,'device':device,'shuffle_state':False,'repeat_state':'off'}
events=[]; commands=[]
afterglow='http://127.0.0.1:4779'
if '--live-media' in sys.argv:
 req=urllib.request.Request('http://127.0.0.1:4777/api/applications',headers={'Authorization':'Bearer '+(pathlib.Path.home()/'.cyberdeck/token').read_text().strip()})
 apps=json.load(urllib.request.urlopen(req))['applications']
 afterglow=next(a['url'] for a in apps if a['id']=='afterglow')
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,data,status=200):
  self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode())
 def do_GET(self):
  path=urlparse(self.path).path
  data={'/api/fleet/nodes':{'nodes':[]},'/api/casework/devices':{'devices':[{'id':'fixture','info':{'spotifyBridge':1}}],'events':events[-50:]},'/api/applications':{'applications':[{'id':'afterglow','url':afterglow}]},'/api/spotify':{'items':[]},'/api/library':{'items':[]},'/api/catalog':{'metas':[]},'/commands':{'commands':commands}}
  self.reply(data.get(path,{}))
 def do_POST(self):
  data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or '{}')
  if self.path!='/api/command':self.reply({});return
  args=data['action']['args'];commands.append(args);url=urlparse(args['path']);path=url.path;q=parse_qs(url.query);method=args.get('method','GET');result={}
  if method=='GET':
   result={'/me/player':playback.copy(),'/me/player/devices':{'devices':[device]},'/me/playlists':{'items':[playlist]},'/me/albums':{'items':[{'album':album}]},'/me/tracks':{'items':[{'track':track}]},'/playlists/list1/items':{'items':[{'item':track}]},'/albums/album1/tracks':{'items':[track]},'/search':{'tracks':{'items':[track]},'albums':{'items':[album]},'playlists':{'items':[playlist]}}}.get(path,{})
  else:
   if path.endswith('/play'):playback['is_playing']=True
   if path.endswith('/pause'):playback['is_playing']=False
   if path.endswith('/shuffle'):playback['shuffle_state']=q.get('state')==['true']
   if path.endswith('/repeat'):playback['repeat_state']=q['state'][0]
   if path.endswith('/seek'):playback['progress_ms']=int(q['position_ms'][0])
   if path.endswith('/volume'):device['volume_percent']=int(q['volume_percent'][0])
  id=str(uuid.uuid4());events.append({'id':id,'deviceId':'fixture','ok':True,'result':{'data':result}});self.reply({'id':id,'sent':1})
print('Isolated Spotify fixture on 127.0.0.1:4779',flush=True)
ThreadingHTTPServer(('127.0.0.1',4779),Handler).serve_forever()
