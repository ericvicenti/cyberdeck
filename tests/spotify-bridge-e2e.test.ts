import { test, expect } from 'bun:test';
import { chromium } from 'playwright';

test('signed-in tab serves native catalog/control requests without exposing credentials', async () => {
  const built = await Bun.build({ entrypoints: ['ui/lib/spotify-bridge.ts'], target: 'browser' });
  const script = await built.outputs[0]!.text();
  let peer: any;
  const replies = new Map<string, any>();
  let hello: any;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(req, server) {
      if (new URL(req.url).pathname === '/control') { if (server.upgrade(req)) return; return new Response('', {status:400}); }
      if (new URL(req.url).pathname === '/bridge.js') return new Response(script, {headers:{'Content-Type':'text/javascript'}});
      return new Response('<html><head><script type="module" src="/bridge.js"></script></head><body>Bridge fixture</body></html>',{headers:{'Content-Type':'text/html'}});
    },
    websocket: { message(ws, data) { const msg = JSON.parse(String(data)); if(msg.type==='hello'){hello=msg;peer=ws;} if(msg.type==='result') replies.set(msg.id,msg); } }
  });
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('cyberdeck-token','node-fixture');
      sessionStorage.setItem('cyberdeck-spotify-tokens',JSON.stringify({access_token:'spotify-fixture',refresh_token:'refresh-fixture',expires:Date.now()+600000,clientId:'fixture'}));
    });
    let calls: string[] = [];
    await context.route('https://api.spotify.com/**',async route => {
      expect(route.request().headers().authorization).toBe('Bearer spotify-fixture');
      calls.push(route.request().url());
      await route.fulfill({status:200,contentType:'application/json',body: route.request().method()==='GET' ? JSON.stringify({items:[{name:'Test album'}]}) : 'OK'});
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.port}`);
    for(let n=0;n<60&&!peer;n++) await new Promise(r=>setTimeout(r,50));
    expect(hello.token).toBe('node-fixture');expect(hello.info.spotifyBridge).toBe(1);
    const command = async (id:string,args:unknown) => {
      peer.send(JSON.stringify({type:'command',id,action:{name:'spotify.request',args}}));
      for(let n=0;n<60&&!replies.has(id);n++) await new Promise(r=>setTimeout(r,50));
      return replies.get(id);
    };
    expect((await command('catalog',{path:'/me/playlists'})).result.data.items[0].name).toBe('Test album');
    expect((await command('play',{path:'/me/player/play?device_id=test',method:'PUT',body:{uris:['spotify:track:test']}})).ok).toBe(true);
    expect((await command('blocked',{path:'//attacker.example/token'})).ok).toBe(false);
    expect((await command('mutation',{path:'/me/tracks',method:'PUT',body:{ids:['x']}})).ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify([...replies.values()])).not.toContain('spotify-fixture');
    expect(JSON.stringify([...replies.values()])).not.toContain('refresh-fixture');
  } finally { await browser.close();server.stop(true); }
},20000);

test('native Connect reuses the existing public client and PKCE callback', async () => {
  const built = await Bun.build({entrypoints:['ui/lib/spotify-bridge.ts'],target:'browser'});
  const script = await built.outputs[0]!.text();
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){return new URL(req.url).pathname==='/bridge.js' ? new Response(script,{headers:{'Content-Type':'text/javascript'}}) : new Response('<script type="module" src="/bridge.js"></script>',{headers:{'Content-Type':'text/html'}});}});
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    let authorization: URL | undefined;
    await page.route('https://accounts.spotify.com/authorize?**',async route=>{authorization=new URL(route.request().url());await route.fulfill({body:'Spotify authorization fixture'});});
    await page.goto(`http://127.0.0.1:${server.port}/?afterglowSpotify=connect#/spotify`);
    for(let n=0;n<60&&!authorization;n++)await new Promise(r=>setTimeout(r,50));
    expect(authorization!.searchParams.get('client_id')).toBe('6dc6300fa4364a81acb8a5f5e920f809');
    expect(authorization!.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${server.port}/`);
    expect(authorization!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization!.searchParams.get('scope')).toContain('user-library-read');
  }finally{await browser.close();server.stop(true);}
},20000);
