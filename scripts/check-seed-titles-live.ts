/** Verify actual installed Seed routes with signed metadata reads only.
 * Uses the same private origin/token-host environment as check-network-navigation-live.ts.
 * No messages, agent creation, run/trigger actions, microphone or production playback.
 */
import { chromium } from "playwright";
import * as cbor from "@seed-hypermedia/client/cbor";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const origin=process.env.CYBERDECK_TEST_ORIGIN||"http://127.0.0.1:4777", host=process.env.CYBERDECK_TEST_TOKEN_HOST;
const token=host?(()=>{const p=Bun.spawnSync(["ssh","-o","BatchMode=yes","-o","ConnectTimeout=10",host,"cat ~/.cyberdeck/token"]);if(p.exitCode)throw new Error("Cannot read host token");return p.stdout.toString().trim();})():readFileSync(join(homedir(),".cyberdeck/token"),"utf8").trim();
if(!token)throw new Error("Empty credential");
const reads=new Set(["ListAgents","GetAgent","GetSession","GetRun","ListSessions","ListRuns","ListAgentTriggers","ListModelProviders","ListProviderModels","ListSigningIdentities","ListAgentInvites","ListMcpServers"]);
const browser=await chromium.launch(), context=await browser.newContext({viewport:{width:1360,height:1000}});
const errors:string[]=[],blocked:string[]=[],passed:string[]=[],observed=new Set<string>();
await context.addInitScript(value=>localStorage.setItem("cyberdeck-token",value),token);
await context.route("**/*",async route=>{
 const req=route.request(),url=new URL(req.url());
 if(url.origin!==new URL(origin).origin)return route.abort();
 if(req.method()!=="GET" && url.pathname.startsWith("/api/")){
  let action:string|undefined;
  try{
   if(url.pathname.match(/^\/api\/seed-agents\/(?:nodes\/[^/]+\/)?sign$/)){
    const data=JSON.parse(req.postData()||"{}").data;
    action=(cbor.decode(new Uint8Array(Buffer.from(data,"base64"))) as any).action?._;
   }else if(url.pathname.startsWith("/api/seed-agents/") && url.pathname.endsWith("/message")){
    action=(cbor.decode(new Uint8Array(req.postDataBuffer()!)) as any).action?._;
   }
  }catch{}
  if(!action||!reads.has(action)){blocked.push(action||url.pathname);return route.abort();}
  observed.add(action);
 }
 return route.continue();
});
const page=await context.newPage();page.setDefaultTimeout(25000);page.on("pageerror",e=>errors.push(e.message));
let agents:{id:string;definition:{name?:string}}[]|undefined;
page.on("response",async response=>{
 if(!response.url().includes("/api/seed-agents/")||!response.headers()["content-type"]?.includes("application/cbor"))return;
 try{const data:any=cbor.decode(new Uint8Array(await response.body()));if(data._==="ListAgentsResponse")agents=data.agents;}catch{}
});
let stage="Seed connection";
try{
 const response=await context.request.get(`${origin}/api/seed-agents/session`,{headers:{authorization:`Bearer ${token}`}});
 if(!response.ok())throw new Error(`Seed connection returned HTTP ${response.status()}`);
 const state=await response.json();
 if(!state.available||!state.reachable){console.log(JSON.stringify({origin,available:state.available,reachable:state.reachable,skipped:"Live Seed identity/server unavailable; exact-bundle fixture covers names"}));}
 else{
  await page.goto(`${origin}/#/seed`);
  const until=Date.now()+25000;
  while(!agents&&Date.now()<until)await page.waitForTimeout(50);
  const agent=agents?.find(a=>a.id&&a.definition?.name);
  if(!agent)throw new Error("No named agent available for live title check");
  stage="Agent title";
  const path=`agent/${encodeURIComponent(agent.id)}`;
  const url=`${origin}/#/seed?${new URLSearchParams({r:path})}`;
  const clean=(s:string)=>s.replace(/[\u0000-\u001f]/g," ").slice(0,350);
  const expected=`${clean(`Sessions · ${agent.definition.name!.trim()} · Seed`)} · Cyberdeck`;
  await page.goto(url);await page.waitForFunction(expected=>document.title===expected,expected);
  passed.push("actual authenticated agent name");
  stage="Tab history";
  await page.evaluate(path=>location.hash="#/seed?"+new URLSearchParams({r:path+"?tab=settings"}),path);
  await page.waitForFunction(()=>document.title.startsWith("Settings · "));
  await page.goBack();await page.waitForFunction(expected=>document.title===expected,expected);
  await page.goForward();await page.waitForFunction(()=>document.title.startsWith("Settings · "));
  passed.push("nested tab and Back/Forward");
  stage="Reload/new tab";
  await page.reload();await page.waitForFunction(()=>document.title.startsWith("Settings · "));
  const tab=await context.newPage();tab.on("pageerror",e=>errors.push(e.message));tab.setDefaultTimeout(25000);
  await tab.goto(url);await tab.waitForFunction(expected=>document.title===expected,expected);await tab.close();
  passed.push("reload and new tab");
  await page.getByTestId("nav-data").click();await page.waitForFunction(()=>document.title==="Data · Cyberdeck");
  passed.push("title cleanup");
  if(errors.length||blocked.length)throw new Error("Page error or attempted non-read action");
  console.log(JSON.stringify({origin,passed,readActions:[...observed],pageErrors:0,mutations:0}));
 }
}catch(error){console.error(JSON.stringify({stage,passed,title:await page.title(),errors,blocked}));throw error;}
finally{await browser.close();}
