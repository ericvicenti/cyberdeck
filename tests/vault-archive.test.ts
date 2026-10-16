import { expect, test } from "bun:test";
import { ArchiveGames, fetchArchive, matchArchiveFile } from "../src/daemon/api/vault-archive";
import { Hono } from "hono";
import { registerVaultDownloadRoutes } from "../src/daemon/api/vault-download";
const signal = () => new AbortController().signal;
test("matching requires the title, console and requested region and excludes modified releases", () => {
  const names = ['Mario 2 (USA).nes', 'Mario (Japan).nes', 'Mario (USA) (Beta).nes', 'Mario (USA) (Rev 1).nes', 'Mario (USA).nes'];
  expect(matchArchiveFile(names, 'NES', 'Mario', ['USA'])).toBe('Mario (USA).nes');
  expect(matchArchiveFile(names, 'NES', 'Mario', ['Europe'])).toBeUndefined();
  expect(matchArchiveFile(['Mario.gb'], 'GBC', 'Mario', [])).toBeUndefined();
  expect(matchArchiveFile(['Mario.zip'], 'NES', 'Mario', ['USA'])).toBeUndefined();
  expect(matchArchiveFile(['Mario (World).zip'], 'NES', 'Mario', ['USA'])).toBe('Mario (World).zip');
});
test("redirects stay on the HTTPS Archive download hosts", async () => {
  for (const target of ['http://archive.org/a','https://evil.test/a','https://archive.org:8443/a','https://user@archive.org/a']) {
    let calls=0;
    await expect(fetchArchive('https://archive.org/a',signal(), (async () => {calls++;return new Response(null,{status:302,headers:{location:target}});}) as typeof fetch)).rejects.toThrow('unexpected address');
    expect(calls).toBe(1);
  }
});
test("metadata skips private and oversized files and caches only the index", async () => {
  let indexes=0,downloads=0;
  const archive=new ArchiveGames((async input => {
    if(String(input).includes('/metadata/')) {indexes++;return Response.json({files:[{name:'Mario (USA).gba',private:true},{name:'Mario (World).gba',size:200000000},{name:'Mario (Europe).gba',size:4}]});}
    downloads++;return new Response('game');
  }) as typeof fetch);
  await expect(archive.file('GBA','Mario',['USA'],signal())).rejects.toThrow("aren't available");
  for(let i=0;i<2;i++)expect((await archive.file('GBA','Mario',['Europe'],signal())).name).toBe('Mario (Europe).gba');
  expect(indexes).toBe(1);expect(downloads).toBe(2);
});
test("Play falls back from verification to an exact public ZIP member without fetching the whole pack", async () => {
  const urls:string[]=[];
  const member='https://archive.org/download/nintendo-entertainment-system_20250402/Nintendo%20Entertainment%20System.zip/Roms/Mario%20(World).zip';
  const bytes=Uint8Array.from([80,75,3,4,...new Array(64).fill(0)]);
  const app=new Hono();registerVaultDownloadRoutes(app,(async input => {
    const url=String(input);urls.push(url);
    if(url.includes('vimm.net'))return new Response('<div class="cf-turnstile"></div>',{status:404});
    if(url.endsWith('.zip/'))return new Response(`<a href="https://evil.test/Mario%20(World).zip">wrong</a><a href="${member}">game</a>`);
    expect(url).toBe(member);return new Response(bytes,{headers:{'content-type':'application/zip'}});
  }) as typeof fetch);
  const response=await app.request('/api/vimm/download/834?system=NES&title=Mario&region=USA',{method:'POST'});
  expect(response.status).toBe(200);expect(response.headers.get('x-vault-source')).toBe('Internet Archive');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(urls).toHaveLength(3);
});
