// Run against a rich-player build: CYBERDECK_TEST_UI=/path/to/dist/ui bun test scripts/recordings-browser.test.ts
// Every endpoint and audio sample is synthetic. No Spotify account, installed daemon or user media is used.
import { beforeAll, afterAll, test, expect } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join, resolve } from "node:path";
const ui = resolve(process.env.CYBERDECK_TEST_UI || join(import.meta.dir, "../dist/ui"));
const track = {id:"track1",uri:"spotify:track:track1",name:"Test song",artists:[{id:"artist1",name:"Test artist"}],duration_ms:180000,album:{id:"album1",name:"Test album",images:[]}};
let browser: Browser, server: ReturnType<typeof Bun.serve>, base: string;
beforeAll(async () => {
  server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==="/api/fleet/nodes")return Response.json({self:{nodeId:"fixture",name:"Test"},nodes:[]});
    if(path==="/api/applications")return Response.json({applications:[]});
    if(path==="/api/music/recordings")return Response.json({recordings:[]});
    if(path==="/api/music/archive")return Response.json(request.method==="GET"?{records:[],next:null}:{saved:true});
    if(path.startsWith("/api/"))return Response.json({error:"Not part of fixture"},{status:503});
    if(path==="/spotify-sdk.js")return new Response("window.Spotify={Player:class{}};window.onSpotifyWebPlaybackSDKReady?.();",{headers:{"Content-Type":"text/javascript"}});
    const file=Bun.file(join(ui,path==="/"?"index.html":path));
    return await file.exists()?new Response(file):new Response("Not found",{status:404});
  }});
  base=server.url.origin;browser=await chromium.launch();
});
afterAll(async()=>{await browser?.close();server?.stop(true);});
async function setup(width=1280) {
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.route("**/*",route=>new URL(route.request().url()).origin===base?route.continue():route.fulfill({status:503,body:"External network disabled by fixture"}));
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  return {page,errors};
}
async function mockSpotify(page: Page) {
  await page.route("https://api.spotify.com/v1/**",route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==="/v1/me/player")return route.fulfill({status:204});
    const json=path==="/v1/me"?{id:"listener1",display_name:"Test listener"}:path.endsWith("/devices")?{devices:[]}:{items:[],next:null};
    return route.fulfill({json});
  });
}
async function login(page: Page, {hash}: {hash:string}) {
  await page.addInitScript(()=>sessionStorage.setItem("cyberdeck-spotify-tokens",JSON.stringify({access_token:"fixture-only",refresh_token:"fixture-only",expires:Date.now()+3600000,clientId:"fixture"})));
  await page.goto(base+"/"+hash);
}

async function seedRecording(page: Page, id = "saved / A & B? ü") {
  await page.evaluate(async ({track,id}) => {
    const db = await new Promise<IDBDatabase>((resolve,reject) => {
      const request=indexedDB.open("cyberdeck-spotify",2);
      request.onupgradeneeded=()=>{for(const [name,keyPath] of [["records","key"],["recordings","id"],["audio",undefined]] as const) if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,keyPath?{keyPath}:undefined);};
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    // Generated silence, never a real recording or a media download.
    const samples=8000*20, bytes=new ArrayBuffer(44+samples*2), data=new DataView(bytes);
    const text=(at:number,value:string)=>[...value].forEach((c,i)=>data.setUint8(at+i,c.charCodeAt(0)));
    text(0,"RIFF");data.setUint32(4,36+samples*2,true);text(8,"WAVEfmt ");data.setUint32(16,16,true);data.setUint16(20,1,true);data.setUint16(22,1,true);data.setUint32(24,8000,true);data.setUint32(28,16000,true);data.setUint16(32,2,true);data.setUint16(34,16,true);text(36,"data");data.setUint32(40,samples*2,true);
    const audio=new Blob([bytes],{type:"audio/wav"});
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(["recordings","audio"],"readwrite");
      tx.objectStore("recordings").put({id,account:"listener1",at:1,track,startMs:60000,endMs:80000,durationMs:20000,bytes:audio.size,mime:"audio/wav",finalized:true,local:true,synced:false});
      tx.objectStore("audio").put(audio,id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
    });db.close();dispatchEvent(new Event("cyberdeck-audio-saved"));
  },{track,id});
  return id;
}

test("saved recording links restore read-only details and titles through reload, new tab and history", async () => {
  const {page,errors}=await setup(1280);const actions:string[]=[];
  try {
    await page.addInitScript(()=>localStorage.setItem("cyberdeck-spotify-account","listener1"));
    await page.route("**/api/music/recordings**",route=>{actions.push(route.request().method()+" "+new URL(route.request().url()).pathname);return route.fulfill({json:{recordings:[]}});});
    await page.goto(base+"/#/spotify?shelf=history");const id=await seedRecording(page);
    await page.getByRole("button",{name:/Details for saved Test song/}).click();
    await page.getByRole("region",{name:"Recording details"}).getByRole("heading",{name:"Test song"}).waitFor();
    await page.waitForFunction(()=>document.title==="Test song · Saved audio · Spotify · Cyberdeck");
    const url=page.url();expect(new URLSearchParams(new URL(url).hash.split("?")[1]).get("recording")).toBe(id);
    expect(await page.getByTestId("saved-recording-audio").evaluate((audio:HTMLAudioElement)=>audio.paused&&!audio.getAttribute("src"))).toBe(true);
    await page.getByRole("button",{name:"Close recording details"}).click();
    await page.goBack();await page.getByRole("region",{name:"Recording details"}).waitFor();
    await page.reload();await page.getByRole("region",{name:"Recording details"}).getByRole("heading",{name:"Test song"}).waitFor();
    const other=await page.context().newPage();await other.goto(url);await other.getByRole("region",{name:"Recording details"}).getByRole("heading",{name:"Test song"}).waitFor();await other.close();
    await page.setViewportSize({width:390,height:844});
    await page.getByRole("region",{name:"Recording details"}).scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:join(ui,"../../recording-details.png")});
    await page.setViewportSize({width:1280,height:900});
    await page.getByTestId("nav-applications").click();await page.getByRole("heading",{name:"Applications",exact:true}).waitFor();expect(await page.title()).toBe("Applications · Cyberdeck");
    await page.goBack();await page.waitForFunction(()=>document.title==="Test song · Saved audio · Spotify · Cyberdeck");
    expect(actions.every(action=>action==="GET /api/music/recordings")).toBe(true);
    expect(errors).toEqual([]);
  } finally {await page.context().close();}
},30000);

test("saved recording audio continues across shelf, detail and primary-view navigation while offline", async () => {
  const {page,errors}=await setup();
  try {
    await page.addInitScript(()=>localStorage.setItem("cyberdeck-spotify-account","listener1"));
    await page.route("**/api/music/recordings**",route=>route.fulfill({json:{recordings:[]}}));
    await mockSpotify(page); await login(page,{hash:"#/spotify?shelf=history"});
    await page.getByRole("heading",{name:"Listening journal",exact:true}).waitFor(); await seedRecording(page);
    await page.getByRole("button",{name:/Play saved Test song/}).click();
    await page.waitForFunction(()=>{const a=document.querySelector<HTMLAudioElement>('[data-testid="saved-recording-audio"]');return a&&!a.paused&&a.currentTime>.1;});
    const audio=page.getByTestId("saved-recording-audio");await audio.evaluate(node=>node.setAttribute("data-continuity","same-audio"));
    await page.context().setOffline(true);
    await page.getByRole("button",{name:/Details for saved Test song/}).click();
    await page.evaluate(()=>{history.pushState(null,"","#/spotify?shelf=albums");dispatchEvent(new HashChangeEvent("hashchange"));});
    await page.getByRole("heading",{name:"Saved albums",exact:true}).waitFor();
    expect(await page.getByRole("region",{name:"Saved audio"}).count()).toBe(0);
    await page.getByTestId("nav-applications").click();
    const before=await audio.evaluate((a:HTMLAudioElement)=>a.currentTime);
    await page.waitForTimeout(150);
    expect(await audio.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(before);
    expect(await audio.evaluate((a:HTMLAudioElement)=>a.paused)).toBe(false);
    await page.goBack();await page.goBack();await page.getByRole("region",{name:"Recording details"}).waitFor();
    expect(await audio.getAttribute("data-continuity")).toBe("same-audio");
    await page.getByRole("button",{name:"Pause saved audio"}).click();expect(await audio.evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);
    expect(errors).toEqual([]);
  } finally {await page.context().close();}
},30000);

test("missing, unavailable and signed-out recording links are honest and never fetch audio", async () => {
  const {page,errors}=await setup();let available=true;const requests:string[]=[];
  try {
    await page.addInitScript(()=>localStorage.setItem("cyberdeck-spotify-account","listener1"));
    await page.route("**/api/music/recordings**",route=>{requests.push(route.request().method()+" "+new URL(route.request().url()).pathname);return route.fulfill({status:available?200:503,json:available?{recordings:[]}:{error:"Unavailable"}});});
    await page.goto(base+"/#/spotify?recording=missing&shelf=history");await page.getByRole("heading",{name:"Recording not found"}).waitFor();
    expect(await page.title()).toBe("Recording not found · Saved audio · Spotify · Cyberdeck");
    available=false;await page.reload();await page.getByRole("heading",{name:"Recording unavailable"}).waitFor();
    expect(await page.title()).toBe("Recording unavailable · Saved audio · Spotify · Cyberdeck");
    await page.evaluate(()=>localStorage.removeItem("cyberdeck-spotify-account"));
    const fresh=await browser.newPage();await fresh.goto(base+"/#/spotify?recording=missing&shelf=history");await fresh.getByRole("heading",{name:"Recording unavailable"}).waitFor();await fresh.close();
    expect(requests.every(request=>request==="GET /api/music/recordings")).toBe(true);expect(errors).toEqual([]);
  } finally {await page.context().close();}
},30000);
