/** Check the installed bundle with an intercepted child app; no production app/media actions. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const origin = new URL(process.env.CYBERDECK_TEST_ORIGIN || "http://127.0.0.1:4777").origin;
const host = process.env.CYBERDECK_TEST_TOKEN_HOST;
const token = host ? (() => {
  const child = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "cat ~/.cyberdeck/token"]);
  if (child.exitCode) throw new Error("Cannot read selected host token");
  return child.stdout.toString().trim();
})() : readFileSync(join(homedir(), ".cyberdeck/token"), "utf8").trim();
if (!token) throw new Error("Missing token");
const adapter = await fetch(origin + "/embedded-navigation.js", {headers:{Authorization:"Bearer " + token}});
if (!adapter.ok) throw new Error("Installed adapter unavailable");
const adapterSource = await adapter.text();
if (!adapterSource.includes("createEmbeddedNavigation")) throw new Error("Wrong adapter response");
const childOrigin = "http://embedded-navigation.invalid";
const html = `<!doctype html><title>Library</title><h1>Loading</h1><output id="route"></output><button id="detail">Detail</button><script type="module">
import {createEmbeddedNavigation} from '/bridge.js';
window.proof={id:Math.random(),ticks:0};setInterval(()=>proof.ticks++,20);
window.bridge=createEmbeddedNavigation({parentOrigins:[${JSON.stringify(origin)}],onNavigate:async(route,{signal})=>{if(signal.aborted)return;document.querySelector('#route').textContent=route;document.title=route.includes('detail')?'Detail':'Library';document.querySelector('h1').textContent=document.title;}});
document.querySelector('#detail').onclick=()=>bridge.navigate('/detail?q=A%20%26%20B#part');
</script>`;
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript(({token,origin}) => { if (location.origin === origin) localStorage.setItem("cyberdeck-token",token); }, {token,origin});
const errors:string[]=[],mutations:string[]=[],passed:string[]=[];
await context.route("**/*",async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin===childOrigin)return route.fulfill({status:200,contentType:u.pathname==='/bridge.js'?'text/javascript':'text/html',body:u.pathname==='/bridge.js'?adapterSource:html});
  if(u.origin!==origin)return route.abort();
  if(u.pathname.startsWith('/api/') && req.method()!=='GET'){mutations.push(`${req.method()} ${u.pathname}`);return route.abort();}
  if(u.pathname==='/api/applications'){
    const response=await route.fetch(); if(!response.ok())throw new Error('Live applications unavailable');
    const data=await response.json();data.applications.push({id:'__navigation_fixture',name:'Navigation fixture',description:'Isolated verification',url:childOrigin+'/library'});
    return route.fulfill({response,json:data});
  }
  return route.continue();
});
const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
const url=origin+'/#/applications?'+new URLSearchParams({app:'__navigation_fixture',route:'/library?tab=saved'});
let stage='direct restoration';
try{
  await page.goto(url);await page.waitForFunction(()=>document.title==='Library · Navigation fixture · Cyberdeck');
  const frame=page.frames().find(f=>f.url().startsWith(childOrigin))!;
  if(await frame.locator('#route').textContent()!=='/library?tab=saved')throw new Error('Wrong initial child route');
  const identity=await frame.evaluate(()=>(window as any).proof.id),length=await page.evaluate(()=>history.length);
  await frame.locator('#detail').click();await page.waitForFunction(()=>document.title==='Detail · Navigation fixture · Cyberdeck');
  if(await page.evaluate(()=>history.length)!==length+1)throw new Error('Duplicate history');
  await page.goBack();await page.waitForFunction(()=>document.title==='Library · Navigation fixture · Cyberdeck');
  await page.goForward();await page.waitForFunction(()=>document.title==='Detail · Navigation fixture · Cyberdeck');
  if(await frame.evaluate(()=>(window as any).proof.id)!==identity)throw new Error('Frame remounted');passed.push('direct/title/one-entry/Back/Forward');
  stage='hidden retention';await page.getByTestId('nav-data').click();await page.waitForFunction(()=>location.hash==='#/data');
  const ticks=await frame.evaluate(()=>(window as any).proof.ticks);
  await frame.evaluate(()=>(window as any).bridge.navigate('/library?hidden=1'));
  if(!page.url().endsWith('#/data'))throw new Error('Hidden app changed route');
  await page.goBack();await page.waitForFunction(()=>document.title==='Detail · Navigation fixture · Cyberdeck');
  if(await frame.evaluate(()=>(window as any).proof.id)!==identity||await frame.evaluate(()=>(window as any).proof.ticks)<=ticks)throw new Error('Session not retained');passed.push('hidden-session/title isolation');
  stage='reload/new tab';const shared=page.url();await page.reload();await page.waitForFunction(()=>document.title==='Detail · Navigation fixture · Cyberdeck');
  const tab=await context.newPage();try{await tab.goto(shared);await tab.waitForFunction(()=>document.title==='Detail · Navigation fixture · Cyberdeck');}finally{await tab.close();}passed.push('reload/new-tab');
  stage='invalid route';await page.evaluate(()=>location.hash='#/applications?app=__navigation_fixture&route=https%3A%2F%2Fevil.invalid');
  await page.getByRole('alert').filter({hasText:'Invalid embedded application route'}).waitFor();await page.waitForFunction(()=>document.title==='Invalid application route · Cyberdeck');passed.push('invalid-link/error title');
  if(errors.length||mutations.length)throw new Error(JSON.stringify({errors,mutations}));
  console.log(JSON.stringify({origin,passed,pageErrors:0,apiMutations:0,child:'intercepted fixture using installed adapter; configured apps not changed'}));
}catch(error){console.error(JSON.stringify({stage,passed,title:await page.title(),errors,mutations}));throw error;}finally{await browser.close();}
