/** Read-only checks of the installed Commander child and Cyberdeck parent. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const transport = new URL(process.env.CYBERDECK_TEST_ORIGIN || "http://127.0.0.1:4777").origin;
const origin = new URL(process.env.CYBERDECK_PARENT_ORIGIN || transport).origin;
const host = process.env.CYBERDECK_TEST_TOKEN_HOST;
const token = host ? (() => {
  const result = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "cat ~/.cyberdeck/token"]);
  if (result.exitCode) throw new Error("Cannot read selected host token");
  return result.stdout.toString().trim();
})() : readFileSync(join(homedir(), ".cyberdeck/token"), "utf8").trim();
if (!token) throw new Error("Missing token");
const response = await fetch(transport + "/api/applications", {headers:{Authorization:"Bearer " + token}});
if (!response.ok) throw new Error("Applications unavailable");
const listing = await response.json() as {applications:{id:string;name:string;url:string}[]};
const app = listing.applications.find(app => app.id === "commander");
if (!app) throw new Error("Commander is not configured on this host");
const childOrigin = new URL(app.url).origin;
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript(({origin,token}) => { if (location.origin === origin) localStorage.setItem("cyberdeck-token",token); }, {origin,token});
const errors:string[]=[],mutations:string[]=[],passed:string[]=[];
await context.routeWebSocket("**/*", socket => { if (new URL(socket.url()).host === new URL(childOrigin).host) mutations.push("unexpected child socket"); socket.close(); });
await context.route("**/*",async route => {
  const req=route.request(),u=new URL(req.url());
  if (![origin,childOrigin].includes(u.origin)) return route.abort();
  if (req.method() !== "GET") {mutations.push(`${req.method()} ${u.origin}${u.pathname}`);return route.abort();}
  if(u.origin===childOrigin) {
    // Trainer navigation must not create an account, attach to a match or execute
    // any action. Read exactly the live observatory endpoints used by this check.
    if(u.pathname.startsWith('/socket.io') || (u.pathname.startsWith('/api/') && !/^\/api\/trainer\/(overview|live|logs\/(coach|online))$/.test(u.pathname))) {
      mutations.push(`unexpected child request ${u.pathname}`); return route.abort();
    }
    return route.continue();
  }
  // Use a loopback SSH tunnel while retaining the real, explicitly trusted parent
  // origin in the browser. The token is never installed in the child origin.
  const result=await route.fetch({url:transport+u.pathname+u.search,headers:{...req.headers(),Authorization:'Bearer '+token}});
  return route.fulfill({response:result});
});
const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
const route = '/?tab=Logs&trainer=1&worker=coach';
const url=origin+'/#/applications?'+new URLSearchParams({app:'commander',route});
let stage='direct restoration';
try {
  await page.goto(url);await page.waitForFunction(()=>document.title==='Local coach · Logs · Training · Commander · Cyberdeck');
  const frame=page.frames().find(f=>f.url().startsWith(childOrigin))!;
  if(!frame)throw new Error('Commander frame unavailable');
  if(await frame.locator('select[aria-label="Log worker"]').inputValue()!=='coach')throw new Error('Wrong worker');
  if(await frame.evaluate(()=>localStorage.getItem('cyberdeck-token'))!==null)throw new Error('Parent token leaked to child');
  const identity=await frame.evaluate(()=>{(window as any).__navigationProof=Math.random();return (window as any).__navigationProof;});
  const length=await page.evaluate(()=>history.length);
  await frame.getByRole('button',{name:'How it works',exact:true}).click();
  await page.waitForFunction(()=>document.title==='How it works · Training · Commander · Cyberdeck');
  if(await page.evaluate(()=>history.length)!==length+1)throw new Error('Duplicate history');
  await page.goBack();await page.waitForFunction(()=>document.title==='Local coach · Logs · Training · Commander · Cyberdeck');
  await page.goForward();await page.waitForFunction(()=>document.title==='How it works · Training · Commander · Cyberdeck');
  if(await frame.evaluate(()=>(window as any).__navigationProof)!==identity)throw new Error('Frame replaced');
  passed.push('installed Commander direct/title/one-entry/Back/Forward');
  stage='parent view retention';await page.getByTestId('nav-controls').click();await page.waitForFunction(()=>document.title==='Controls · Cyberdeck');
  await page.goBack();await page.waitForFunction(()=>document.title==='How it works · Training · Commander · Cyberdeck');
  if(await frame.evaluate(()=>(window as any).__navigationProof)!==identity)throw new Error('Hidden frame replaced');
  passed.push('parent view/title cleanup/document retention');
  stage='reload/new tab';const shared=page.url();await page.reload();await page.waitForFunction(()=>document.title==='How it works · Training · Commander · Cyberdeck');
  const tab=await context.newPage();try{await tab.goto(shared);await tab.waitForFunction(()=>document.title==='How it works · Training · Commander · Cyberdeck');}finally{await tab.close();}
  const reloadedFrame=page.frames().find(f=>f.url().startsWith(childOrigin))!;
  await reloadedFrame.evaluate(()=>(window as any).__navigationReloadProbe=true);
  const beforeReload=await page.evaluate(()=>history.length);
  await page.getByRole('button',{name:'Reload',exact:true}).click();
  await reloadedFrame.waitForFunction(()=>!(window as any).__navigationReloadProbe);
  await page.waitForFunction(()=>document.title==='How it works · Training · Commander · Cyberdeck');
  if(await page.evaluate(()=>history.length)!==beforeReload)throw new Error('Reload added history');
  passed.push('reload/new-tab/explicit Reload');
  if(errors.length||mutations.length)throw new Error(JSON.stringify({errors,mutations}));
  console.log(JSON.stringify({origin,childOrigin,passed,pageErrors:0,apiMutations:0,gameConnections:0}));
}catch(error){console.error(JSON.stringify({stage,passed,title:await page.title(),errors,mutations}));throw error;}finally{await browser.close();}
