import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import * as cbor from "@seed-hypermedia/client/cbor";
import * as blobs from "@seed-hypermedia/client/blobs";

// Real published Seed UI + production Cyberdeck bundle. Synthetic signatures,
// metadata and transcripts only; no real agent is messaged or started.
const account = blobs.principalToString(blobs.nobleKeyPairFromSeed(new Uint8Array(32).fill(42)).principal);
const actions: string[] = [], errors: string[] = [], unexpected: string[] = [];
const pending = new Set<() => void>();
let hold = false;
let renamed = "";
const readActions = new Set(["ListAgents","GetAgent","GetSession","GetRun","GetAgentTrigger","ListSessions","ListRuns","ListAgentTriggers","ListAgentMemoryDir","ReadAgentMemoryFile","ListAgentTools","ListAgentCollaborators","ListAgentInvites","ListModelProviders","ListProviderModels","ListMcpServers","ListSigningIdentities","GetRunJournal"]);
const ok = (value: unknown) => new Response(cbor.encode(value) as unknown as BodyInit,{headers:{"content-type":"application/cbor"}});
const fail = (status: number, message: string) => new Response(cbor.encode({_:"Error",message}) as unknown as BodyInit,{status,headers:{"content-type":"application/cbor"}});
const agent = (id: string, node: string) => ({id,account,definition:{name:renamed || `${node} ${id === "beta" ? "Beta assistant" : "Alpha assistant"}`,systemPrompt:"Fixture",model:"fixture",modelProvider:"fixture",mcpServers:[]},stateDir:"",status:"idle",createdAt:1,updatedAt:2});
const session = (id: string, node: string) => ({id,account,agentId:"alpha",title:id === "untitled" ? "" : `${node} ${id === "two" ? "Second conversation" : "First conversation"}`,status:"idle",createdAt:1,updatedAt:2});
const run = (id: string, node: string) => ({id,account,rootRunId:id,depth:0,kind:"workflow",origin:"user",title:`${node} Review navigation`,status:"succeeded",createdAt:1,updatedAt:2,finishedAt:2});
const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req,server) {
  const url=new URL(req.url),path=url.pathname;
  if (path.endsWith("/agents/ws") && server.upgrade(req)) return;
  if (path.match(/^\/seed-fixture\/(?:local|peer-a|peer-b)\/api\/message$/)) {
    const node=path.split("/")[2];
    const envelope:any=cbor.decode(new Uint8Array(await req.arrayBuffer()));
    const action=envelope.action;actions.push(`${node}:${action._}`);
    if(!readActions.has(action._)){unexpected.push(action._);return fail(405,"Fixture forbids mutations");}
    const id=action.agentId||action.sessionId||action.runId||action.triggerId||"";
    if(hold && (id === "slow" || (node === "peer-a" && action._ === "GetAgent"))) await new Promise<void>(r=>pending.add(r));
    if(id === "missing")return fail(404,"Entity not found");
    if(id === "denied")return fail(403,"Access denied");
    if(id === "offline")return fail(503,"Fixture unavailable");
    switch(action._){
      case "GetAgent":return ok({_:"GetAgentResponse",agent:agent(id,node),sessionCount:0});
      case "GetSession":return ok({_:"GetSessionResponse",session:session(id,node),events:[],systemPromptMarkdown:""});
      case "GetRun":return ok({_:"GetRunResponse",run:run(id,node)});
      case "GetAgentTrigger":return ok({_:"GetAgentTriggerResponse",trigger:{id,agentId:"alpha",account,name:"Morning review",enabled:true,source:{type:"schedule",schedule:{kind:"weekly",daysOfWeek:[1],timeOfDay:"09:00",timezone:"UTC"}},prompt:"Fixture",createdAt:1,updatedAt:2},sessions:[],firings:[]});
      case "ListAgents":return ok({_:"ListAgentsResponse",agents:[agent("alpha",node),agent("beta",node)]});
      case "ListSessions":return ok({_:"ListSessionsResponse",sessions:[session("one",node),session("two",node)]});
      case "ListRuns":return ok({_:"ListRunsResponse",runs:[]});
      case "ListAgentTriggers":return ok({_:"ListAgentTriggersResponse",triggers:[]});
      case "ListAgentMemoryDir":return ok({_:"ListAgentMemoryDirResponse",agentId:action.agentId,path:action.path||"",entries:[],entryCount:0});
      case "ReadAgentMemoryFile":return ok({_:"ReadAgentMemoryFileResponse",agentId:action.agentId,path:action.path,content:"Fixture note"});
      case "ListAgentTools":return ok({_:"ListAgentToolsResponse",tools:[]});
      case "ListAgentCollaborators":return ok({_:"ListAgentCollaboratorsResponse",collaborators:[]});
      case "ListAgentInvites":return ok({_:"ListAgentInvitesResponse",invites:[]});
      case "ListProviderModels":return ok({_:"ListProviderModelsResponse",models:[]});
      case "ListModelProviders":return ok({_:"ListModelProvidersResponse",providers:[]});
      case "ListMcpServers":return ok({_:"ListMcpServersResponse",servers:[]});
      case "ListSigningIdentities":return ok({_:"ListSigningIdentitiesResponse",identities:[]});
      case "GetRunJournal":return ok({_:"GetRunJournalResponse",runId:action.runId,entries:[]});
    }
  }
  if(path.startsWith("/api/")) {
    if(path.endsWith("/sign") && path.startsWith("/api/seed-agents")) return Response.json({sig:Buffer.alloc(64).toString("base64")});
    if(req.method!=="GET"){unexpected.push(path);return Response.json({error:"No writes"},{status:405});}
    if(path==="/api/auth/whoami")return Response.json({method:"none"});
    if(path==="/api/fleet/nodes")return Response.json({self:{nodeId:"local",name:"Local",urls:[]},nodes:[{id:"peer-a",name:"Peer A",online:true},{id:"peer-b",name:"Peer B",online:true}]});
    if(path.endsWith("/session") && path.startsWith("/api/seed-agents")){
      const node=path.includes("/nodes/")?path.split("/")[4]:"local";
      return Response.json({available:true,reachable:true,accountUid:account,identity:"fixture",agentsUrl:"http://fixture.invalid",serverPath:`/seed-fixture/${node}`,hmPath:"/hm-fixture"});
    }
    if(path==="/api/status")return Response.json({nodeName:"Local",roots:[],repos:0});
    if(path==="/api/cmux/tree")return Response.json({available:false,tree:[]});
    if(path.endsWith("/sessions"))return Response.json({sessions:[]});
    if(path.endsWith("/repos"))return Response.json([]);
    return Response.json({error:"Fixture unavailable"},{status:404});
  }
  if(path.startsWith("/hm-fixture") || path.startsWith("/seed-fixture"))return Response.json({error:"Fixture endpoint unavailable"},{status:404});
  const file=Bun.file(join(process.env.CYBERDECK_TEST_UI||join(import.meta.dir,"../dist/ui"),path==="/"?"index.html":path));
  return await file.exists()?new Response(file):new Response("Not found",{status:404});
},websocket:{open(){},message(){},close(){}}});
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch();});
afterAll(async()=>{for(const release of pending)release();await browser.close();server.stop(true);expect(unexpected).toEqual([]);expect(errors).toEqual([]);});
async function fresh(fn:(page:Page)=>Promise<void>){
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));
 await page.route("**/*",route=>new URL(route.request().url()).origin===server.url.origin?route.continue():route.abort());
 try{await fn(page);}catch(e){console.error(JSON.stringify({title:await page.title(),body:(await page.locator("body").innerText()).slice(0,1800),errors,actions:actions.slice(-15)}));throw e;}
 finally{hold=false;renamed="";for(const release of pending)release();pending.clear();await page.close();}
}
const href=(path:string,node="")=>`${server.url}#/seed?${new URLSearchParams({r:path,...(node?{node}:{})})}`;
const title=(page:Page,value:string)=>page.waitForFunction(value=>document.title===value,value);

test("Seed agent/tab, session and run names restore on direct links, reload, new tabs and history",()=>fresh(async page=>{
 await page.goto(href("agent/alpha"));await title(page,"Sessions · local Alpha assistant · Seed · Cyberdeck");
 await page.evaluate(()=>location.hash="#/seed?r=agent%2Fbeta%3Ftab%3Dsettings");await title(page,"Settings · local Beta assistant · Seed · Cyberdeck");
 await page.goBack();await title(page,"Sessions · local Alpha assistant · Seed · Cyberdeck");
 await page.goForward();await title(page,"Settings · local Beta assistant · Seed · Cyberdeck");
 await page.reload();await title(page,"Settings · local Beta assistant · Seed · Cyberdeck");
 await fresh(async tab=>{await tab.goto(page.url());await title(tab,"Settings · local Beta assistant · Seed · Cyberdeck");});
 await page.goto(href("session/one"));await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.goto(href("session/two"));await title(page,"local Second conversation · Seed session · Cyberdeck");
 await page.goBack();await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.reload();await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.goto(href("session/untitled"));await title(page,"Untitled session · Seed session · Cyberdeck");
 await page.goto(href("run/review"));await title(page,"local Review navigation · Seed run · Cyberdeck");
}),30000);

test("Nested memory and trigger titles use the agent's name without opening actions",()=>fresh(async page=>{
 await page.goto(href("agent/alpha?tab=memory&file=notes%2Ftoday.md"));await title(page,"notes/today.md · local Alpha assistant · Seed · Cyberdeck");
 await page.goto(href("agent/alpha?tab=triggers&trigger=morning"));await title(page,"Morning review · local Alpha assistant · Seed · Cyberdeck");
 await page.reload();await title(page,"Morning review · local Alpha assistant · Seed · Cyberdeck");
}),30000);

test("Seed missing, denied and unavailable entities have honest titles and clean up on exit",()=>fresh(async page=>{
 for(const [path,value] of [["agent/missing","Agent not found"],["session/missing","Session not found"],["run/missing","Run not found"],["session/denied","Access denied"],["agent/offline","Agent unavailable"]]){
  await page.goto(href(path));await title(page,`${value} · Seed · Cyberdeck`);
 }
 await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
}),30000);

test("Late entity names cannot overwrite newer routes, nodes or the locked title",()=>fresh(async page=>{
 hold=true;
 await page.goto(href("session/slow"));while(!pending.size)await page.waitForTimeout(10);
 await page.evaluate(()=>location.hash="#/seed?r=session%2Ftwo");await title(page,"local Second conversation · Seed session · Cyberdeck");
 for(const release of pending)release();pending.clear();await page.waitForTimeout(100);expect(await page.title()).toBe("local Second conversation · Seed session · Cyberdeck");
 await page.goto(href("agent/alpha","peer-a"));while(!pending.size)await page.waitForTimeout(10);
 await page.getByTestId("seed-node").selectOption("peer-b");
 await page.evaluate(()=>location.hash="#/seed?node=peer-b&r=agent%2Fbeta");await title(page,"Sessions · peer-b Beta assistant · Seed · Peer B · Cyberdeck");
 for(const release of pending)release();pending.clear();await page.waitForTimeout(100);expect(await page.title()).toBe("Sessions · peer-b Beta assistant · Seed · Peer B · Cyberdeck");
 await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
 await page.getByTestId("nav-files").click();await page.getByPlaceholder("access token").waitFor();await title(page,"Locked · Cyberdeck");
 expect(actions.some(a=>a.startsWith("peer-b:GetAgent"))).toBe(true);
}),30000);


test("Entity names refresh on return without changing the URL or adding history",()=>fresh(async page=>{
 await page.goto(href("agent/alpha"));await title(page,"Sessions · local Alpha assistant · Seed · Cyberdeck");
 const url=page.url(),length=await page.evaluate(()=>history.length);
 renamed="Renamed assistant";
 await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
 await title(page,"Sessions · Renamed assistant · Seed · Cyberdeck");
 expect(page.url()).toBe(url);expect(await page.evaluate(()=>history.length)).toBe(length);
}),30000);

test("Leaving a delayed trigger route cannot sign its follow-up title lookup",()=>fresh(async page=>{
 hold=true;
 await page.goto(href("agent/slow?tab=triggers&trigger=morning"));
 while(!pending.size)await page.waitForTimeout(10);
 await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
 const before=actions.filter(a=>a.endsWith(":GetAgentTrigger")).length;
 for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(actions.filter(a=>a.endsWith(":GetAgentTrigger")).length).toBe(before);
 expect(await page.title()).toBe("Data · Cyberdeck");
}),30000);


test("Sessions Seed links use the embedded entity title and restore without creating a terminal",()=>fresh(async page=>{
 await page.goto(`${server.url}#/term?session=seed-one`);await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.reload();await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.evaluate(()=>location.hash="#/term?session=seed-two&node=peer-b");await title(page,"peer-b Second conversation · Seed session · Peer B · Cyberdeck");
 await page.goBack();await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.evaluate(()=>location.hash="#/term?session=seed-missing");await title(page,"Session not found · Seed · Cyberdeck");
 await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
}),30000);
