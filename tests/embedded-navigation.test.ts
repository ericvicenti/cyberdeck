import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const ui = process.env.CYBERDECK_TEST_UI || join(import.meta.dir, "../dist/ui");
let parentOrigin = "";
const errors: string[] = [];
const child = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/embedded-navigation.js") return new Response(Bun.file(join(ui, "embedded-navigation.js")));
  if (url.pathname === "/plain") return new Response("<!doctype html><h1>Uncooperative app</h1>", { headers: { "content-type": "text/html" } });
  return new Response(`<!doctype html><title>Library</title><h1>Loading</h1><output id="route"></output>
    <button id="next">Next</button><button id="replace">Replace</button><button id="same">Same</button>
    <script type="module">
    import { createEmbeddedNavigation } from '/embedded-navigation.js';
    window.identity = 'document-' + Math.random(); window.ticks = 0; setInterval(() => window.ticks++, 20);
    window.messages = []; addEventListener('message', e => { if(e.source === parent) window.messages.push(e.data); });
    const render = async (route, {signal}) => {
      if (route.includes('slow')) await new Promise(r => setTimeout(r, 400));
      if(signal.aborted) return;
      route = route === '/legacy' ? '/library?tab=saved' : route;
      document.querySelector('#route').textContent = route;
      document.title = route.includes('missing') ? 'Item not found' : route.includes('detail') ? 'Detail' : 'Library';
      document.querySelector('h1').textContent = document.title;
      return route;
    };
    window.bridge = createEmbeddedNavigation({parentOrigins: [${JSON.stringify(parentOrigin)}], onNavigate: render});
    document.querySelector('#next').onclick = () => bridge.navigate('/detail?id=two%20%26%20three#part');
    document.querySelector('#replace').onclick = () => bridge.navigate('/library?tab=saved', {replace:true});
    document.querySelector('#same').onclick = () => bridge.navigate(bridge.route());
    </script>`, { headers: { "content-type": "text/html" } });
} });
const parent = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/applications") return Response.json({ applications: [
    { id: "fixture", name: "Fixture", url: `${child.url}library`, description: "Fixture" },
    { id: "plain", name: "Plain", url: `${child.url}plain`, description: "Plain" },
  ] });
  if (path === "/api/fleet/nodes") return Response.json({ self: { nodeId: "local", name: "Local" }, nodes: [] });
  if (path.startsWith("/api/")) return Response.json({ error: "Fixture only" }, { status: 404 });
  const file = Bun.file(join(ui, path === "/" ? "index.html" : path));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
parentOrigin = parent.url.origin;
let browser: Browser, page: Page;
const url = (route?: string, app = "fixture") => `${parent.url}#/applications?${new URLSearchParams({app, ...(route === undefined ? {} : {route})})}`;
const frame = () => page.frames().find(f => f.url().startsWith(child.url.href))!;
const view = () => page.frameLocator('iframe[title="Fixture"]');
const route = () => page.evaluate(() => new URLSearchParams(location.hash.split("?")[1]).get("route"));
async function settled(value: string, title = "Library") {
  await page.waitForFunction(value => new URLSearchParams(location.hash.split("?")[1]).get("route") === value && document.title.endsWith(" · Fixture · Cyberdeck"), value);
  await view().locator("#route").filter({hasText:value}).waitFor();
  expect(await page.title()).toBe(`${title} · Fixture · Cyberdeck`);
}
beforeAll(async () => { browser = await chromium.launch(); });
beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.on("pageerror", e => errors.push(e.message)); });
afterAll(async () => { await browser?.close(); parent.stop(true); child.stop(true); });

test("generic child direct links, canonical defaults, reload and new tabs", async () => {
  await page.goto(url()); await settled('/library');
  await page.goto(url('/detail?q=A%20%26%20B%3F#section')); await settled('/detail?q=A%20%26%20B%3F#section', 'Detail');
  await page.reload(); await settled('/detail?q=A%20%26%20B%3F#section', 'Detail');
  const other = await browser.newPage();
  try { await other.goto(page.url()); await other.waitForFunction(() => document.title === 'Detail · Fixture · Cyberdeck'); expect(await other.frameLocator('iframe[title="Fixture"]').locator('#route').textContent()).toBe('/detail?q=A%20%26%20B%3F#section'); } finally { await other.close(); }
});

test("one history owner: pushes, replace, no-op, Back/Forward preserve child document", async () => {
  await page.goto(url('/library')); await settled('/library');
  const id = await frame().evaluate(() => (window as any).identity);
  const length = await page.evaluate(() => history.length);
  await view().locator('#next').click(); await settled('/detail?id=two%20%26%20three#part', 'Detail');
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await view().locator('#same').click(); await page.waitForTimeout(100); expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.goBack(); await settled('/library');
  await page.goForward(); await settled('/detail?id=two%20%26%20three#part', 'Detail');
  await view().locator('#replace').click(); await settled('/library?tab=saved');
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  expect(await frame().evaluate(() => (window as any).identity)).toBe(id);
  await page.goBack(); await settled('/library');
});

test("parent restoration wins rapid asynchronous transitions and canonical acknowledgements", async () => {
  await page.goto(url('/legacy')); await settled('/library?tab=saved');
  const length = await page.evaluate(() => history.length);
  await page.evaluate(() => { location.hash = '#/applications?app=fixture&route=%2Fslow'; });
  await page.waitForTimeout(30);
  await page.evaluate(() => { location.hash = '#/applications?app=fixture&route=%2Fdetail%3Fid%3Dfast'; });
  await settled('/detail?id=fast', 'Detail'); await page.waitForTimeout(500);
  expect(await route()).toBe('/detail?id=fast'); expect(await page.title()).toBe('Detail · Fixture · Cyberdeck');
  expect(await page.evaluate(() => history.length)).toBe(length + 2);
});

test("hidden apps retain timers but cannot change parent URL/title; return restores route", async () => {
  await page.goto(url('/library')); await settled('/library');
  const f = frame(), identity = await f.evaluate(() => (window as any).identity), ticks = await f.evaluate(() => (window as any).ticks);
  await page.evaluate(() => { location.hash = '#/controls'; }); await page.getByRole('heading', {name:'Controller & keyboard'}).waitFor();
  await f.evaluate(() => (window as any).bridge.navigate('/detail?id=hidden'));
  expect(new URL(page.url()).hash).toBe('#/controls'); expect(await page.title()).toBe('Controls · Cyberdeck');
  await page.goBack(); await settled('/library');
  expect(await f.evaluate(() => (window as any).identity)).toBe(identity);
  expect(await f.evaluate(() => (window as any).ticks)).toBeGreaterThan(ticks);
});

test("wrong origin/source/request, malformed routes and stale titles are ignored", async () => {
  await page.goto(url('/library')); await settled('/library');
  const message = await frame().evaluate(() => (window as any).messages.at(-1));
  await page.evaluate(({message, origin}) => {
    const source = document.querySelector('iframe')!.contentWindow;
    for (const [eventOrigin,eventSource,request,route] of [[location.origin,source,message.request,'/detail'],[origin,window,message.request,'/detail'],[origin,source,message.request-1,'/detail'],[origin,source,message.request,'//evil.invalid/'],[origin,source,message.request,'/\\evil.invalid/']]) {
      window.dispatchEvent(new MessageEvent('message', {origin:eventOrigin as string,source:eventSource as Window,data:{...message,type:'embedded:navigation',request,route,title:'Forged'}}));
    }
  }, {message, origin:child.url.origin});
  await frame().evaluate(() => { document.title='Stale'; (window as any).bridge.title('/old'); });
  expect(await route()).toBe('/library'); expect(await page.title()).toBe('Library · Fixture · Cyberdeck');
});

test("child validates parent origin/source and restores errors without action replay", async () => {
  await page.goto(url('/missing')); await settled('/missing','Item not found');
  await frame().evaluate(() => {
    const data = {type:'cyberdeck:connect',version:1,channel:'forged',request:1,route:'/detail'};
    dispatchEvent(new MessageEvent('message',{origin:'https://evil.invalid',source:parent,data}));
    dispatchEvent(new MessageEvent('message',{origin:document.referrer ? new URL(document.referrer).origin : '',source:window,data}));
  });
  await page.waitForTimeout(100); expect(await route()).toBe('/missing'); expect(await page.title()).toBe('Item not found · Fixture · Cyberdeck');
});

test("invalid and unsupported nested links have honest error titles", async () => {
  await page.goto(url('https://evil.invalid')); await page.getByRole('alert').filter({hasText:'Invalid embedded'}).waitFor();
  await page.waitForFunction(() => document.title === 'Invalid application route · Cyberdeck');
  await page.goto(url('/missing','plain')); await page.getByRole('alert').filter({hasText:'could not be restored'}).waitFor();
  expect(await page.title()).toBe('View unavailable · Plain · Cyberdeck');
}, 15000);

test("explicit Reload replaces the child document without adding history", async () => {
  await page.goto(url('/library?tab=saved')); await settled('/library?tab=saved');
  const id = await frame().evaluate(() => (window as any).identity), length = await page.evaluate(() => history.length);
  await page.getByRole('button',{name:'Reload',exact:true}).click();
  await page.waitForFunction(() => !!document.querySelector('iframe'));
  await frame().waitForFunction(id => (window as any).identity && (window as any).identity !== id, id);
  await settled('/library?tab=saved'); expect(await page.evaluate(() => history.length)).toBe(length);
  expect(errors).toEqual([]);
});


test("authentication lock disposes the child and rejects subsequent messages", async () => {
  await page.goto(url('/library')); await settled('/library');
  const message = await frame().evaluate(() => (window as any).messages.at(-1));
  await page.getByTestId('nav-data').click();
  await page.route('**/api/applications', route => route.fulfill({status:401,contentType:'application/json',body:'{"error":"Unauthorized"}'}));
  await page.goBack();
  await page.waitForFunction(() => document.title === 'Locked · Cyberdeck');
  expect(await page.locator('iframe').count()).toBe(0);
  await page.evaluate(message => window.postMessage({...message,type:'embedded:navigation',route:'/detail',title:'Forged'},location.origin),message);
  expect(await route()).toBe('/library'); expect(await page.title()).toBe('Locked · Cyberdeck');
});


test("failed application lookup preserves the requested route with an unavailable title", async () => {
  await page.route('**/api/applications', route => route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture offline"}'}));
  await page.goto(url('/detail'));
  await page.getByRole('heading',{name:'Applications unavailable'}).waitFor();
  expect(await page.title()).toBe('Applications unavailable · Cyberdeck');
  expect(await route()).toBe('/detail'); expect(await page.locator('iframe').count()).toBe(0);
  await page.reload(); await page.getByRole('heading',{name:'Applications unavailable'}).waitFor();
  expect(await page.title()).toBe('Applications unavailable · Cyberdeck');
  await page.unroute('**/api/applications'); await page.reload(); await settled('/detail','Detail');
  expect(errors).toEqual([]);
});


test("private HTTP does not require randomUUID and standalone adapter owns its own history", async () => {
  await page.addInitScript(() => Object.defineProperty(crypto,'randomUUID',{value:undefined}));
  await page.goto(url('/library')); await settled('/library');
  await page.goto(child.url.href + 'library');
  await page.waitForFunction(() => !!(window as any).bridge);
  await page.evaluate(() => (window as any).bridge.navigate('/library', {replace:true}));
  const length = await page.evaluate(() => history.length);
  await page.locator('#next').click(); await page.waitForFunction(() => document.title === 'Detail');
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.goBack(); await page.waitForFunction(() => document.title === 'Library');
  expect(new URL(page.url()).pathname).toBe('/library');
  expect(errors).toEqual([]);
});


test("child interaction during parent restoration follows the acknowledgement once", async () => {
  await page.goto(url('/slow'));
  await view().locator('#next').waitFor();
  const length=await page.evaluate(()=>history.length);
  await view().locator('#next').click();
  await settled('/detail?id=two%20%26%20three#part','Detail');
  expect(await page.evaluate(()=>history.length)).toBe(length+1);
  await page.goBack();await settled('/slow');
});
