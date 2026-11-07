import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import * as cbor from "@seed-hypermedia/client/cbor";
import * as blobs from "@seed-hypermedia/client/blobs";

// Real published Seed UI + production Cyberdeck bundle. Synthetic signatures,
// metadata and transcripts only; no real agent is messaged or started.
const account = blobs.principalToString(blobs.nobleKeyPairFromSeed(new Uint8Array(32).fill(42)).principal);
const browserBudget = process.env.CYBERDECK_TEST_ORIGIN ? 90000 : 30000;
const actions: string[] = [], errors: string[] = [], unexpected: string[] = [];
const pending = new Set<() => void>();
let hold = false;
let renamed = "";
let memoryRemoved = false;
let memoryReadStatus = 200, holdMemoryRead = false;
let sessionReadStatus = 200, runReadStatus = 200, listReadStatus = 200, holdListRead = false;
const reads: { node: string; action: any }[] = [];
const transcriptEvents = (id: string) => id === "transcript" ? ["message-one", "message two/?&"].map((eventId, index) => ({
 id: eventId, sessionId: id, seq: index + 1, createdAt: index + 1,
 event: { type: "message", role: index ? "assistant" : "user", content: `Fixture transcript message ${index + 1}` },
})) : [];
const readActions = new Set(["ListAgents","GetAgent","GetSession","GetRun","GetAgentTrigger","ListSessions","ListRuns","ListAgentTriggers","ListAgentMemoryDir","ReadAgentMemoryFile","ListAgentTools","ListAgentCollaborators","ListAgentInvites","ListModelProviders","ListProviderModels","ListMcpServers","ListSigningIdentities","GetRunJournal"]);
const ok = (value: unknown) => new Response(cbor.encode(value) as unknown as BodyInit,{headers:{"content-type":"application/cbor"}});
const fail = (status: number, message: string) => new Response(cbor.encode({_:"Error",message}) as unknown as BodyInit,{status,headers:{"content-type":"application/cbor"}});
const agent = (id: string, node: string) => ({id,account,definition:{name:renamed || `${node} ${id === "beta" ? "Beta assistant" : "Alpha assistant"}`,systemPrompt:"Fixture",model:"fixture",modelProvider:"fixture",mcpServers:[]},stateDir:"",status:"idle",createdAt:1,updatedAt:2});
const session = (id: string, node: string) => ({id,account,agentId:"alpha",title:id === "untitled" ? "" : `${node} ${id === "two" ? "Second conversation" : id === "older" ? "Older conversation" : "First conversation"}`,status:"idle",createdAt:1,updatedAt:2});
const run = (id: string, node: string) => ({id,account,rootRunId:id,depth:0,kind:"workflow",origin:"user",title:`${node} Review navigation`,status:"succeeded",createdAt:1,updatedAt:2,finishedAt:2});
const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req,server) {
  const url=new URL(req.url),path=url.pathname;
  if (path.endsWith("/agents/ws") && server.upgrade(req)) return;
  if (path.match(/^\/seed-fixture\/(?:local|peer-a|peer-b|external)\/api\/message$/)) {
    const node=path.split("/")[2];
    const envelope:any=cbor.decode(new Uint8Array(await req.arrayBuffer()));
    const action=envelope.action;actions.push(`${node}:${action._}`);reads.push({node,action});
    if(!readActions.has(action._)){unexpected.push(action._);return fail(405,"Fixture forbids mutations");}
    const id=action.agentId||action.sessionId||action.runId||action.triggerId||"";
    if (action._ === "ReadAgentMemoryFile" && action.path === "notes/today.md") {
      const status = memoryReadStatus;
      if (holdMemoryRead) await new Promise<void>(r => pending.add(r));
      if (status !== 200) return fail(status, "Memory content read failed");
    }
    if(hold && (id === "slow" || (node === "peer-a" && action._ === "GetAgent"))) await new Promise<void>(r=>pending.add(r));
    if (action._ === "GetSession" && id === "transcript" && !action.limit && sessionReadStatus !== 200) return fail(sessionReadStatus, "Transcript read failed");
    if (action._ === "ListSessions" && action.agentId === "paged" && action.cursor) {
      const status = listReadStatus;
      if (holdListRead) await new Promise<void>(r => pending.add(r));
      if (status !== 200) return fail(status, "Session list read failed");
    }
    if (action._ === "GetRun" && id === "review" && runReadStatus !== 200) return fail(runReadStatus, "Run read failed");
    if(id === "missing")return fail(404,"Entity not found");
    if(id === "denied")return fail(403,"Access denied");
    if(id === "offline")return fail(503,"Fixture unavailable");
    if (action._ === "ListAgentMemoryDir") {
      if (hold && action.path === "slow") await new Promise<void>(r=>pending.add(r));
      if (action.path === "denied") return fail(403,"Memory access denied");
      if (action.path === "offline") return fail(503,"Memory unavailable");
      if (action.path === "missing-dir") return fail(404,"Memory directory not found");
    }
    switch(action._){
      case "GetAgent":return ok({_:"GetAgentResponse",agent:agent(id,node),sessionCount:0});
      case "GetSession":return ok({_:"GetSessionResponse",session:session(id,node),events:transcriptEvents(id),systemPromptMarkdown:"Fixture system prompt — read only"});
      case "GetRun":return ok({_:"GetRunResponse",run:run(id,node)});
      case "GetAgentTrigger":return ok({_:"GetAgentTriggerResponse",trigger:{id,agentId:"alpha",account,name:"Morning review",enabled:true,source:{type:"schedule",schedule:{kind:"weekly",daysOfWeek:[1],timeOfDay:"09:00",timezone:"UTC"}},prompt:"Fixture",createdAt:1,updatedAt:2},sessions:[],firings:[]});
      case "ListAgents":return ok({_:"ListAgentsResponse",agents:[agent("alpha",node),agent("beta",node)]});
      case "ListSessions":return action.agentId === "paged"
        ? ok({_:"ListSessionsResponse",sessions:[session(action.cursor === "page-3" ? "older" : action.cursor === "page-2" ? "two" : "one",node)],nextCursor:action.cursor === "page-3" ? undefined : action.cursor === "page-2" ? "page-3" : "page-2"})
        : ok({_:"ListSessionsResponse",sessions:[session("one",node),session("two",node)]});
      case "ListRuns":return ok({_:"ListRunsResponse",runs:[]});
      case "ListAgentTriggers":return ok({_:"ListAgentTriggersResponse",triggers:[]});
      case "ListAgentMemoryDir":return ok({_:"ListAgentMemoryDirResponse",agentId:action.agentId,path:action.path||"",entries:memoryRemoved ? [] : [{path:"notes/today.md",type:"file",size:12,updatedAt:1},{path:"notes/later.md",type:"file",size:12,updatedAt:1},{path:"notes/folder",type:"dir",size:0,updatedAt:1}],totalBytes:24});
      case "ReadAgentMemoryFile":return ok({_:"ReadAgentMemoryFileResponse",agentId:action.agentId,file:{path:action.path,size:12,updatedAt:1,encoding:"utf8",content:"Fixture note"}});
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
  if (process.env.CYBERDECK_TEST_ORIGIN) {
    const installed = new URL(process.env.CYBERDECK_TEST_ORIGIN);
    if (!["127.0.0.1", "localhost"].includes(installed.hostname)) throw new Error("Installed assets must use a loopback tunnel");
    return fetch(new URL(path, installed));
  }
  const file=Bun.file(join(process.env.CYBERDECK_TEST_UI||join(import.meta.dir,"../dist/ui"),path==="/"?"index.html":path));
  return await file.exists()?new Response(file):new Response("Not found",{status:404});
},websocket:{open(){},message(){},close(){}}});
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch();});
afterAll(async()=>{for(const release of pending)release();await browser.close();server.stop(true);expect(unexpected).toEqual([]);expect(errors).toEqual([]);});
async function fresh(fn:(page:Page)=>Promise<void>){
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));
 page.setDefaultNavigationTimeout(process.env.CYBERDECK_TEST_ORIGIN ? 30000 : 12000);
 await page.route("**/*",route=>new URL(route.request().url()).origin===server.url.origin?route.continue():route.abort());
 try{await fn(page);}catch(e){console.error(JSON.stringify({title:await page.title(),body:(await page.locator("body").innerText()).slice(0,1800),errors,actions:actions.slice(-15)}));throw e;}
 finally{hold=false;renamed="";memoryRemoved=false;memoryReadStatus=200;holdMemoryRead=false;sessionReadStatus=200;runReadStatus=200;listReadStatus=200;holdListRead=false;for(const release of pending)release();pending.clear();await page.close();}
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
}),browserBudget);

test("Nested memory and trigger titles use the agent's name without opening actions",()=>fresh(async page=>{
 await page.goto(href("agent/alpha?tab=memory&file=notes%2Ftoday.md"));await title(page,"notes/today.md · local Alpha assistant · Seed · Cyberdeck");
 await page.goto(href("agent/alpha?tab=triggers&trigger=morning"));await title(page,"Morning review · local Alpha assistant · Seed · Cyberdeck");
 await page.reload();await title(page,"Morning review · local Alpha assistant · Seed · Cyberdeck");
}),browserBudget);

test("Seed missing, denied and unavailable entities have honest titles and clean up on exit",()=>fresh(async page=>{
 for(const [path,value] of [["agent/missing","Agent not found"],["session/missing","Session not found"],["run/missing","Run not found"],["session/denied","Access denied"],["agent/offline","Agent unavailable"]]){
  await page.goto(href(path));await title(page,`${value} · Seed · Cyberdeck`);
 }
 await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
}),browserBudget);

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
}),browserBudget);


test("Entity names refresh on return without changing the URL or adding history",()=>fresh(async page=>{
 await page.goto(href("agent/alpha"));await title(page,"Sessions · local Alpha assistant · Seed · Cyberdeck");
 const url=page.url(),length=await page.evaluate(()=>history.length);
 renamed="Renamed assistant";
 await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
 await title(page,"Sessions · Renamed assistant · Seed · Cyberdeck");
 expect(page.url()).toBe(url);expect(await page.evaluate(()=>history.length)).toBe(length);
}),browserBudget);

test("Leaving a delayed trigger route cannot sign its follow-up title lookup",()=>fresh(async page=>{
 hold=true;
 await page.goto(href("agent/slow?tab=triggers&trigger=morning"));
 while(!pending.size)await page.waitForTimeout(10);
 await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
 const before=actions.filter(a=>a.endsWith(":GetAgentTrigger")).length;
 for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(actions.filter(a=>a.endsWith(":GetAgentTrigger")).length).toBe(before);
 expect(await page.title()).toBe("Data · Cyberdeck");
}),browserBudget);


test("Sessions Seed links use the embedded entity title and restore without creating a terminal",()=>fresh(async page=>{
 await page.goto(`${server.url}#/term?session=seed-one`);await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.reload();await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.evaluate(()=>location.hash="#/term?session=seed-two&node=peer-b");await title(page,"peer-b Second conversation · Seed session · Peer B · Cyberdeck");
 await page.goBack();await title(page,"local First conversation · Seed session · Cyberdeck");
 await page.evaluate(()=>location.hash="#/term?session=seed-missing");await title(page,"Session not found · Seed · Cyberdeck");
 await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
}),browserBudget);


test("Seed nested memory metadata failures retain URLs and identify the missing file",()=>fresh(async page=>{
 for(const [file,value] of [["notes/missing.md","Memory file not found · local Alpha assistant"],["missing-dir/file.md","Memory file not found"],["denied/file.md","Access denied"],["offline/file.md","Memory file unavailable"],["notes/folder","Memory file not found · local Alpha assistant"]]){
  const url=href(`agent/alpha?tab=memory&file=${encodeURIComponent(file)}`);
  await page.goto(url);await title(page,`${value} · Seed · Cyberdeck`);
  expect(new URL(page.url()).hash).toBe(new URL(url).hash);
  await page.reload();await title(page,`${value} · Seed · Cyberdeck`);
 }
 await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
}),browserBudget);

test("Seed memory deletion refreshes its title; history and fresh tabs restore a valid file",()=>fresh(async page=>{
 const path="agent/alpha?tab=memory&file=notes%2Ftoday.md";
 await page.goto(href(path));await title(page,"notes/today.md · local Alpha assistant · Seed · Cyberdeck");
 const url=page.url(),length=await page.evaluate(()=>history.length);
 memoryRemoved=true;await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
 await title(page,"Memory file not found · local Alpha assistant · Seed · Cyberdeck");
 expect(page.url()).toBe(url);expect(await page.evaluate(()=>history.length)).toBe(length);
 memoryRemoved=false;
 await page.evaluate(()=>location.hash="#/seed?r=agent%2Fbeta%3Ftab%3Dsettings");await title(page,"Settings · local Beta assistant · Seed · Cyberdeck");
 await page.goBack();await title(page,"notes/today.md · local Alpha assistant · Seed · Cyberdeck");
 await fresh(async tab=>{await tab.goto(url);await title(tab,"notes/today.md · local Alpha assistant · Seed · Cyberdeck");});
}),browserBudget);

test("A late memory-directory failure cannot rename another route or selected node",()=>fresh(async page=>{
 hold=true;
 await page.goto(href("agent/alpha?tab=memory&file=slow%2Ffile.md"));
 while(!pending.size)await page.waitForTimeout(10);
 await page.evaluate(()=>location.hash="#/seed?node=peer-b&r=agent%2Fbeta%3Ftab%3Dsettings");await title(page,"Settings · peer-b Beta assistant · Seed · Peer B · Cyberdeck");
 for(const release of pending)release();pending.clear();await page.waitForTimeout(100);
 expect(await page.title()).toBe("Settings · peer-b Beta assistant · Seed · Peer B · Cyberdeck");
}),browserBudget);

test("Seed memory-content outcomes override successful directory metadata without extra reads", () => fresh(async page => {
  memoryReadStatus = 403;
  const path = "agent/alpha?tab=memory&file=notes%2Ftoday.md";
  const selected = href(path);
  const start = actions.length;
  await page.goto(selected);
  await title(page, "Memory file access denied · Seed · Cyberdeck");
  expect(await page.locator("body").innerText()).toContain("Memory content read failed");
  expect(actions.slice(start).filter(action => action.endsWith(":ReadAgentMemoryFile")).length).toBe(1);
  expect(page.url()).toBe(selected);
  await fresh(async tab => {
    await tab.goto(selected);
    await title(tab, "Memory file access denied · Seed · Cyberdeck");
  });
  memoryReadStatus = 403;
  await page.reload();
  await title(page, "Memory file access denied · Seed · Cyberdeck");
  memoryReadStatus = 404;
  await page.reload();
  await title(page, "Memory file not found · Seed · Cyberdeck");
  memoryReadStatus = 503;
  await page.reload();
  await title(page, "Memory file unavailable · Seed · Cyberdeck");
  memoryReadStatus = 200;
  await page.reload();
  await title(page, "notes/today.md · local Alpha assistant · Seed · Cyberdeck");
  await page.getByTestId("nav-data").click();
  await title(page, "Data · Cyberdeck");
  await page.goBack();
  await title(page, "notes/today.md · local Alpha assistant · Seed · Cyberdeck");
}), browserBudget);

test("Late Seed memory failures cannot rename a different file, node or primary view", () => fresh(async page => {
  memoryReadStatus = 403; holdMemoryRead = true;
  await page.goto(href("agent/alpha?tab=memory&file=notes%2Ftoday.md", "peer-a"));
  await page.waitForFunction(() => document.body.innerText.includes("today.md"));
  await page.evaluate(() => { location.hash = "#/seed?" + new URLSearchParams({ r: "agent/alpha?tab=memory&file=notes%2Flater.md", node: "peer-b" }); });
  await title(page, "notes/later.md · peer-b Alpha assistant · Seed · Peer B · Cyberdeck");
  const before = page.url(), length = await page.evaluate(() => history.length);
  for (const release of pending) release(); pending.clear();
  holdMemoryRead = false;
  await page.waitForTimeout(150);
  expect(page.url()).toBe(before);
  expect(await page.evaluate(() => history.length)).toBe(length);
  expect(await page.title()).toBe("notes/later.md · peer-b Alpha assistant · Seed · Peer B · Cyberdeck");
  await page.getByTestId("nav-data").click(); await title(page, "Data · Cyberdeck");
}), browserBudget);


test("Seed transcript titles follow the displayed read, retry and refresh without a title-only request", () => fresh(async page => {
 const path = "session/transcript";
 for (const [status, expected] of [[403, "Access denied"], [404, "Session not found"], [503, "Session unavailable"]] as const) {
  sessionReadStatus = status;
  const start = reads.length;
  await page.goto("about:blank"); await page.goto(href(path)); await title(page, `${expected} · Seed · Cyberdeck`);
  expect(await page.locator("body").innerText()).toContain("Transcript read failed");
  const transcriptReads = reads.slice(start).filter(({action}) => action._ === "GetSession");
  expect(transcriptReads.length).toBe(1); expect(transcriptReads[0].action.limit).toBeUndefined();
  const url = page.url(), length = await page.evaluate(() => history.length);
  sessionReadStatus = 200;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await title(page, "local First conversation · Seed session · Cyberdeck");
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
 }
 const start = reads.length;
 await page.reload(); await title(page, "local First conversation · Seed session · Cyberdeck");
 expect(reads.slice(start).filter(({action}) => action._ === "GetSession").length).toBe(1);
}), browserBudget);

test("Seed URL-supplied server names use displayed reads and keep their exact signing node", () => fresh(async page => {
 const remote = `${server.url}seed-fixture/external`;
 for (const [path, expected, actionName] of [["agent/alpha?tab=settings", "Settings · external Alpha assistant · Seed", "GetAgent"], ["session/transcript", "external First conversation · Seed session", "GetSession"], ["run/review", "external Review navigation · Seed run", "GetRun"]]) {
  const start = reads.length;
  const link = href(`${path}${path.includes("?") ? "&" : "?"}server=${encodeURIComponent(remote)}`, "peer-b");
  await page.goto(link); await title(page, `${expected} · Peer B · Cyberdeck`);
  expect(reads.slice(start).filter(({node,action}) => node === "external" && action._ === actionName).length).toBe(1);
  expect(reads.slice(start).some(({node,action}) => node === "peer-b" && action._ === actionName)).toBe(false);
  await page.reload(); await title(page, `${expected} · Peer B · Cyberdeck`);
  await fresh(async tab => { await tab.goto(link); await title(tab, `${expected} · Peer B · Cyberdeck`); });
 }
 await page.getByTestId("nav-data").click(); await title(page, "Data · Cyberdeck");
}), browserBudget);

test("Seed system-prompt content restores through links, reload and history without replacing the transcript", () => fresh(async page => {
 await page.goto(href("session/transcript", "peer-a"));
 await title(page, "peer-a First conversation · Seed session · Peer A · Cyberdeck");
 await page.getByPlaceholder("Untitled session").evaluate(el => el.setAttribute("data-navigation-owner", "retained"));
 const start = reads.length, length = await page.evaluate(() => history.length);
 await page.getByRole("button", { name: "Show current system prompt" }).click();
 await title(page, "Current system prompt · peer-a First conversation · Seed session · Peer A · Cyberdeck");
 await page.getByRole("dialog").filter({ hasText: "Current System Prompt" }).waitFor();
 expect(await page.getByRole("dialog").innerText()).toContain("Fixture system prompt — read only");
 const link = page.url();
 expect(new URLSearchParams(new URL(link).hash.split("?")[1]).get("r")).toContain("panel=prompt");
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 expect(reads.slice(start).filter(({action}) => action._ === "GetSession").length).toBe(0);
 await page.goBack(); await title(page, "peer-a First conversation · Seed session · Peer A · Cyberdeck");
 await page.getByRole("dialog").waitFor({state:"hidden"});
 expect(await page.getByPlaceholder("Untitled session").getAttribute("data-navigation-owner")).toBe("retained");
 await page.goForward(); await title(page, "Current system prompt · peer-a First conversation · Seed session · Peer A · Cyberdeck");
 await page.reload(); await page.getByRole("dialog").filter({ hasText: "Current System Prompt" }).waitFor();
 await fresh(async tab => { await tab.goto(link); await title(tab, "Current system prompt · peer-a First conversation · Seed session · Peer A · Cyberdeck"); await tab.getByRole("dialog").waitFor(); });
 await page.keyboard.press("Escape"); await title(page, "peer-a First conversation · Seed session · Peer A · Cyberdeck");
 await page.goBack(); await title(page, "Current system prompt · peer-a First conversation · Seed session · Peer A · Cyberdeck");
}), browserBudget);

test("Seed message detail and share URLs preserve selection, history and titles", () => fresh(async page => {
 await page.goto(href("session/transcript", "peer-b"));
 await title(page, "peer-b First conversation · Seed session · Peer B · Cyberdeck");
 const length = await page.evaluate(() => history.length), start = reads.length;
 await page.getByRole("button", { name: "Show markdown sent to the LLM" }).nth(1).click();
 await page.getByRole("dialog").filter({ hasText: "Message details" }).waitFor();
 await title(page, "Message · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 const link = page.url();
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 expect(reads.slice(start).filter(({action}) => action._ === "GetSession").length).toBe(0);
 const shared = await page.getByRole("dialog").locator("code").innerText();
 const params = new URLSearchParams(new URL(shared).hash.slice(7));
 expect(params.get("node")).toBe("peer-b");
 expect(params.get("r")).toBe("session/transcript?agent=alpha&event=message%20two%2F%3F%26");
 expect(new URL(shared).origin).toBe(server.url.origin);
 await page.goBack(); await title(page, "peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await page.getByRole("dialog").waitFor({state:"hidden"});
 await page.goForward(); await page.getByRole("dialog").waitFor();
 await page.reload(); await page.getByRole("dialog").waitFor();
 expect(await page.locator('[data-selected-event="message two/?&"]').count()).toBe(1);
 await fresh(async tab => { await tab.goto(link); await tab.getByRole("dialog").waitFor(); await title(tab, "Message · peer-b First conversation · Seed session · Peer B · Cyberdeck"); });
 await page.goto(shared); await title(page, "Message · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await page.getByRole("dialog").waitFor({state:"hidden"});
 await page.goto(href("session/transcript?event=absent&panel=message"));
 await title(page, "Message not found · Seed · Cyberdeck");
 expect(await page.locator("body").innerText()).toContain("Selected message is not in this transcript.");
 await page.reload(); await title(page, "Message not found · Seed · Cyberdeck");
 await page.getByTestId("nav-data").click(); await title(page, "Data · Cyberdeck");
}), browserBudget);


test("Seed session-list pages restore on direct links, reload, new tabs and Back/Forward", () => fresh(async page => {
 await page.goto(href("agent/paged", "peer-a")); await title(page, "Sessions · peer-a Alpha assistant · Seed · Peer A · Cyberdeck");
 await page.getByText("peer-a First conversation", {exact:true}).waitFor();
 const length = await page.evaluate(() => history.length);
 await page.getByRole("button", {name:"Load more",exact:true}).click();
 await page.getByText("peer-a Second conversation", {exact:true}).waitFor();
 await title(page, "Sessions · 2 pages · peer-a Alpha assistant · Seed · Peer A · Cyberdeck");
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 const link = page.url(), before = reads.length;
 await page.goBack(); await title(page, "Sessions · peer-a Alpha assistant · Seed · Peer A · Cyberdeck");
 await page.getByText("peer-a Second conversation", {exact:true}).waitFor({state:"hidden"});
 await page.goForward(); await page.getByText("peer-a Second conversation", {exact:true}).waitFor();
 expect(reads.slice(before).filter(({action}) => action._ === "ListSessions" && action.agentId === "paged").length).toBe(0);
 await page.reload(); await page.getByText("peer-a Second conversation", {exact:true}).waitFor();
 await title(page, "Sessions · 2 pages · peer-a Alpha assistant · Seed · Peer A · Cyberdeck");
 await fresh(async tab => { await tab.goto(link); await tab.getByText("peer-a Second conversation", {exact:true}).waitFor(); await title(tab, "Sessions · 2 pages · peer-a Alpha assistant · Seed · Peer A · Cyberdeck"); });
 await page.getByRole("button", {name:"Load more",exact:true}).click();
 await page.getByText("peer-a Older conversation", {exact:true}).waitFor();
 await title(page, "Sessions · 3 pages · peer-a Alpha assistant · Seed · Peer A · Cyberdeck");
 await page.getByRole("button", {name:"Load more",exact:true}).waitFor({state:"hidden"});
}), browserBudget);

test("Seed session-list failures retry in place and delayed pages cannot change another view", () => fresh(async page => {
 listReadStatus = 503;
 await page.goto(href("agent/paged?pages=2")); await title(page, "Sessions unavailable · Seed · Cyberdeck");
 expect(await page.locator("body").innerText()).toContain("Session list read failed");
 expect(await page.locator("body").innerText()).toContain("local First conversation");
 const url = page.url(), length = await page.evaluate(() => history.length);
 listReadStatus = 200;
 await page.getByRole("button", {name:"Retry",exact:true}).click();
 await page.getByText("local Second conversation", {exact:true}).waitFor();
 await title(page, "Sessions · 2 pages · local Alpha assistant · Seed · Cyberdeck");
 expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
 holdListRead = true; listReadStatus = 403;
 await page.getByRole("button", {name:"Load more",exact:true}).click();
 while (!pending.size) await page.waitForTimeout(10);
 await page.evaluate(() => location.hash = "#/seed?node=peer-b&r=agent%2Fbeta%3Ftab%3Dsettings");
 await title(page, "Settings · peer-b Beta assistant · Seed · Peer B · Cyberdeck");
 for (const release of pending) release(); pending.clear();
 await page.waitForTimeout(150);
 expect(await page.title()).toBe("Settings · peer-b Beta assistant · Seed · Peer B · Cyberdeck");
 await page.getByTestId("nav-data").click(); await title(page, "Data · Cyberdeck");
}), browserBudget);

test("Seed session-list links canonicalize invalid and exhausted page counts without new history", () => fresh(async page => {
 for (const pages of ["1", "-1", "101", "NaN", "1.5"]) {
  await page.goto(href(`agent/paged?pages=${pages}`));
  await title(page, "Sessions · local Alpha assistant · Seed · Cyberdeck");
  await page.waitForFunction(() => new URLSearchParams(location.hash.slice(7)).get("r") === "agent/paged");
 }
 await page.goto(href("agent/paged?pages=99"));
 await page.getByText("local Older conversation", {exact:true}).waitFor();
 await title(page, "Sessions · 3 pages · local Alpha assistant · Seed · Cyberdeck");
 await page.waitForFunction(() => new URLSearchParams(location.hash.slice(7)).get("r") === "agent/paged?pages=3");
 const length = await page.evaluate(() => history.length);
 await page.reload(); await title(page, "Sessions · 3 pages · local Alpha assistant · Seed · Cyberdeck");
 expect(await page.evaluate(() => history.length)).toBe(length);
 await page.goto(href("session/transcript?panel=message")); await title(page, "local First conversation · Seed session · Cyberdeck");
 await page.waitForFunction(() => new URLSearchParams(location.hash.slice(7)).get("r") === "session/transcript");
 await page.getByRole("dialog").waitFor({state:"hidden"});
}), browserBudget);

test("Seed external memory and trigger titles follow displayed metadata without title-only reads", () => fresh(async page => {
 const remote = `${server.url}seed-fixture/external`;
 for (const [path, expected] of [["agent/alpha?tab=memory&file=notes%2Ftoday.md", "notes/today.md · external Alpha assistant"], ["agent/alpha?tab=triggers&trigger=morning", "Morning review · external Alpha assistant"], ["agent/alpha?tab=memory&file=notes%2Fmissing.md", "Memory file not found · external Alpha assistant"]]) {
  const start = reads.length;
  const link = href(`${path}&server=${encodeURIComponent(remote)}`);
  await page.goto(link); await title(page, `${expected} · Seed · Cyberdeck`);
  expect(reads.slice(start).filter(({node, action}) => node === "external" && action._ === "GetAgent").length).toBeLessThanOrEqual(1);
  await page.reload(); await title(page, `${expected} · Seed · Cyberdeck`);
 }
}), browserBudget);


test("Seed transcript panels in Sessions have canonical URLs and retain their content owner", () => fresh(async page => {
 const link = `${server.url}#/term?node=peer-b&session=seed-transcript&panel=prompt&filter=peer-b`;
 await page.goto(link); await title(page, "Current system prompt · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await page.getByRole("dialog").waitFor();
 await page.reload(); await page.getByRole("dialog").waitFor();
 await page.getByPlaceholder("Untitled session").evaluate(el => el.setAttribute("data-session-owner", "retained"));
 const length = await page.evaluate(() => history.length), start = reads.length;
 await page.keyboard.press("Escape"); await title(page, "peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await page.getByRole("dialog").waitFor({state:"hidden"});
 expect(new URL(page.url()).hash).toContain("/term?");
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 await page.goBack(); await page.getByRole("dialog").waitFor();
 await page.goForward(); await page.getByRole("dialog").waitFor({state:"hidden"});
 expect(await page.getByPlaceholder("Untitled session").getAttribute("data-session-owner")).toBe("retained");
 expect(reads.slice(start).filter(({action}) => action._ === "GetSession").length).toBe(0);
 await page.getByRole("button", {name:"Show markdown sent to the LLM"}).first().click();
 await page.getByRole("dialog").filter({hasText:"Message details"}).waitFor();
 expect(new URLSearchParams(new URL(page.url()).hash.slice(7)).get("event")).toBe("message-one");
 const shared = new URL(await page.getByRole("dialog").locator("code").innerText());
 expect(shared.hash).toContain("/term?");
 const sharedParams = new URLSearchParams(shared.hash.slice(7));
 expect(sharedParams.get("node")).toBe("peer-b"); expect(sharedParams.get("filter")).toBe("peer-b");
 expect(sharedParams.get("event")).toBe("message-one"); expect(sharedParams.get("session")).toBe("seed-transcript");
 expect(sharedParams.has("panel")).toBe(false);
 await page.reload(); await page.getByRole("dialog").filter({hasText:"Message details"}).waitFor();
 await title(page, "Message · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await fresh(async tab => { await tab.goto(page.url()); await tab.getByRole("dialog").waitFor(); await title(tab, "Message · peer-b First conversation · Seed session · Peer B · Cyberdeck"); });
}), browserBudget);
