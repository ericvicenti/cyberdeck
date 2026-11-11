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
let payloadStatus = 200, holdPayload = false, malformedPayload = "";
let emptySeedLists = false, childEmpty = false;
let childLists = false, childReadStatus = 200, holdChildRead = false, malformedChild = false;
let globalPaged = false, globalListStatus = 200, globalFailCursor = "", holdGlobalList = false, malformedList = "";
let serverDialogStatus = 200, holdServerDialog = false, malformedServerDialog = "", populatedServerDialog = false;
const reads: { node: string; action: any }[] = [];
const toolId = "call two/?&";
const thinkingIds = ["first /?&", "second group"];
const thinkingEvents = [
 { type: "message", role: "user", content: "Inspect the recorded groups" },
 { type: "tool_call", id: thinkingIds[0], name: "read", input: { path: "first fixture" } },
 { type: "tool_result", toolCallId: thinkingIds[0], name: "read", output: { content: "first result" } },
 { type: "message", role: "assistant", content: "Between the recorded groups" },
 { type: "tool_call", id: thinkingIds[1], name: "read", input: { path: "second fixture" } },
 { type: "tool_result", toolCallId: thinkingIds[1], name: "read", output: { content: "second result" } },
 { type: "message", role: "assistant", content: "After the recorded groups" },
];
const toolEvents = [
 { type: "message", role: "user", content: "Inspect these recorded tools" },
 { type: "tool_call", id: toolId, name: "read", input: { path: "Truncated fixture input" } },
 { type: "tool_result", toolCallId: toolId, name: "read", output: { content: "Truncated fixture output" } },
 { type: "tool_call", id: "status-call", name: "status", input: { title: "Fixture status", description: "Recorded status" } },
 { type: "tool_result", toolCallId: "status-call", name: "status", output: { ok: true } },
 { type: "tool_call", id: "continued-call", name: "continue_session", input: { title: "Recorded successor", reason: "context_limit", transfer: { plan: "carry" } } },
 { type: "tool_result", toolCallId: "continued-call", name: "continue_session", output: { sessionId: "two", title: "Recorded successor" } },
 { type: "message", role: "assistant", content: "These are recorded tool results" },
];
const transcriptEvents = (id: string) => id === "contexts" ? ["context-one", "context two/?&", "no-context"].map((eventId, index) => ({
 id: eventId, sessionId: id, seq: index + 1, createdAt: index + 1,
 event: { type: "message", role: "user", content: `Context fixture message ${index + 1}`, ...(index < 2 ? { contextLines: [`Recorded window ${index + 1}`, `Recorded project ${index + 1}`] } : {}) },
})) : id === "thinking" ? thinkingEvents.map((event, index) => ({ id: `thinking-event-${index + 1}`, sessionId: id, seq: index + 1, createdAt: index + 1, event })) : id === "tools" ? toolEvents.map((event, index) => ({
 id: `tool-event-${index + 1}`, sessionId: id, seq: index + 1, createdAt: index + 1, event,
 ...([1, 2].includes(index) ? { truncated: true } : {}),
})) : id === "transcript" ? ["message-one", "message two/?&"].map((eventId, index) => ({
 id: eventId, sessionId: id, seq: index + 1, createdAt: index + 1,
 event: { type: "message", role: index ? "assistant" : "user", content: `Fixture transcript message ${index + 1}` },
})) : [];
const readActions = new Set(["ListAgents","GetAgent","GetSession","GetSessionEvent","GetRun","GetAgentTrigger","ListSessions","ListRuns","ListAgentTriggers","ListAgentMemoryDir","ReadAgentMemoryFile","ListAgentTools","ListAgentCollaborators","ListAgentInvites","ListModelProviders","ListProviderModels","ListMcpServers","ListSigningIdentities","GetRunJournal"]);
const ok = (value: unknown) => new Response(cbor.encode(value) as unknown as BodyInit,{headers:{"content-type":"application/cbor"}});
const fail = (status: number, message: string) => new Response(cbor.encode({_:"Error",message}) as unknown as BodyInit,{status,headers:{"content-type":"application/cbor"}});
const agent = (id: string, node: string) => ({id,account,definition:{name:renamed || `${node} ${id === "beta" ? "Beta assistant" : "Alpha assistant"}`,systemPrompt:"Fixture",model:"fixture",modelProvider:"fixture",mcpServers:[]},stateDir:"",status:"idle",createdAt:1,updatedAt:2});
const session = (id: string, node: string) => ({id,account,agentId:"alpha",title:id === "untitled" ? "" : `${node} ${id === "two" ? "Second conversation" : id === "older" ? "Older conversation" : "First conversation"}`,status:"idle",createdAt:1,updatedAt:2,...(childLists && ["one", "two"].includes(id) ? { childSessionCount: id === "one" ? 2 : 1 } : {})});
const run = (id: string, node: string) => ({id,account,rootRunId:id,depth:0,kind:"workflow",origin:"user",title:`${node} Review navigation`,status:"succeeded",createdAt:1,updatedAt:2,finishedAt:2,...(id === "activity" ? {sourceText:"// Recorded workflow fixture\nreturn 42;"} : {})});
const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req,server) {
  const url=new URL(req.url),path=url.pathname;
  if (path.endsWith("/agents/ws") && server.upgrade(req)) return;
  if (path.match(/^\/seed-fixture\/(?:local|peer-a|peer-b|external)\/api\/message$/)) {
    const node=path.split("/")[2];
    const envelope:any=cbor.decode(new Uint8Array(await req.arrayBuffer()));
    const action=envelope.action;actions.push(`${node}:${action._}`);reads.push({node,action});
    if(!readActions.has(action._)){unexpected.push(action._);return fail(405,"Fixture forbids mutations");}
    const id=action.agentId||action.sessionId||action.runId||action.triggerId||"";
    if (["ListModelProviders", "ListSigningIdentities"].includes(action._) && !action.agentId) {
      const status = serverDialogStatus, malformed = malformedServerDialog;
      if (holdServerDialog) await new Promise<void>(r => pending.add(r));
      if (status !== 200) return fail(status, "Server dialog read failed");
      const field = action._ === "ListModelProviders" ? "providers" : "identities";
      return ok({ _: malformed === "response" ? "GetSessionResponse" : `${action._}Response`,
        [field]: malformed === "list" ? {} : malformed === "entry" ? [null] : populatedServerDialog
          ? action._ === "ListModelProviders" ? [{ id: "fixture-provider", name: `Provider on ${node}`, type: "openai" }]
            : [{ id: "fixture-identity", name: "identity-fixture", label: `Account on ${node}`, accountId: account }]
          : [] });
    }
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
    if (action._ === "ListSessions" && !action.parentSessionId && emptySeedLists) return ok({ _: "ListSessionsResponse", sessions: [], agents: [] });
    if (action._ === "ListSessions" && action.parentSessionId) {
      const status = childReadStatus, malformed = malformedChild;
      if (holdChildRead) await new Promise<void>(r => pending.add(r));
      if (status !== 200) return fail(status, "Sub-session list read failed");
      return ok({ _: "ListSessionsResponse", sessions: childEmpty ? [] : [{ ...session(`child-${action.parentSessionId}`, node), parentSessionId: malformed ? "different-parent" : action.parentSessionId, title: `${node} Child of ${action.parentSessionId}` }] });
    }
    if (action._ === "ListSessions" && !action.agentId && !action.parentSessionId) {
      const status = globalListStatus, malformed = malformedList;
      const applies = !globalFailCursor || action.cursor === globalFailCursor;
      if (holdGlobalList && applies) await new Promise<void>(r => pending.add(r));
      if (applies && status !== 200) return fail(status, "Global session list read failed");
      if (applies && malformed) return ok(malformed === "response" ? { _: "GetSessionResponse" }
        : { _: "ListSessionsResponse", sessions: malformed === "sessions" ? {} : [session("one", node)],
            agents: malformed === "agents" ? null : [agent("alpha", node)],
            nextCursor: malformed === "cursor" ? 42 : action.cursor || "page-2" });
      if (globalPaged) return ok({ _: "ListSessionsResponse", agents: [agent("alpha", node)],
        sessions: [session(action.cursor === "page-3" ? "older" : action.cursor === "page-2" ? "two" : "one", node)],
        nextCursor: action.cursor === "page-3" || node === "external" && action.cursor === "page-2" ? undefined : action.cursor === "page-2" ? "page-3" : "page-2" });
    }
    if (action._ === "GetRun" && id === "review" && runReadStatus !== 200) return fail(runReadStatus, "Run read failed");
    if (action._ === "GetSessionEvent") {
      const status = payloadStatus, malformed = malformedPayload;
      if (holdPayload) await new Promise<void>(r => pending.add(r));
      if (status !== 200) return fail(status, "Full payload read failed");
      const isInput = action.seq === 2;
      const event = { ...transcriptEvents(action.sessionId).find(row => row.seq === action.seq),
        event: isInput ? { type: "tool_call", id: toolId, name: "read", input: { path: `Full fixture input on ${node}` } }
          : { type: "tool_result", toolCallId: toolId, name: "read", output: { content: `Full fixture output on ${node}` } },
      };
      if (malformed === "session") Object.assign(event, { sessionId: "different-session" });
      if (malformed === "seq") Object.assign(event, { seq: 99 });
      if (malformed === "tool") Object.assign(event.event, { id: "different-call", toolCallId: "different-call" });
      if (malformed === "type") Object.assign(event.event, { type: "message" });
      return ok({ _: "GetSessionEventResponse", event });
    }
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
      case "ListAgents":return ok({_:"ListAgentsResponse",agents:emptySeedLists ? [] : [agent("alpha",node),agent("beta",node)]});
      case "ListSessions":return action.agentId === "paged"
        ? ok({_:"ListSessionsResponse",sessions:[session(action.cursor === "page-3" ? "older" : action.cursor === "page-2" ? "two" : "one",node)],nextCursor:action.cursor === "page-3" ? undefined : action.cursor === "page-2" ? "page-3" : "page-2"})
        : ok({_:"ListSessionsResponse",sessions:[session("one",node),session("two",node)],agents:[agent("alpha",node)]});
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
},websocket:{open(){},message(ws, message){
 const envelope:any = typeof message === "string" ? JSON.parse(message) : cbor.decode(new Uint8Array(message));
 if(envelope.action?.key === "runs/activity") for (let seq=1;seq<=2;seq++) ws.send(JSON.stringify({_:"append",key:"runs/activity",runId:"activity",seq,createdAt:seq,entry:{kind:"log",level:"info",message:`Recorded activity ${seq}`,detail:`Full recorded detail ${seq}`}}));
},close(){}}});
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch();});
afterAll(async()=>{for(const release of pending)release();await browser.close();server.stop(true);expect(unexpected).toEqual([]);expect(errors).toEqual([]);});
async function fresh(fn:(page:Page)=>Promise<void>){
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));
 page.setDefaultNavigationTimeout(process.env.CYBERDECK_TEST_ORIGIN ? 30000 : 12000);
 await page.route("**/*",route=>new URL(route.request().url()).origin===server.url.origin?route.continue():route.abort());
 try{await fn(page);}catch(e){console.error(JSON.stringify({title:await page.title(),body:(await page.locator("body").innerText()).slice(0,1800),errors,actions:actions.slice(-15)}));throw e;}
 finally{serverDialogStatus=200;holdServerDialog=false;malformedServerDialog="";populatedServerDialog=false;emptySeedLists=false;childEmpty=false;childLists=false;childReadStatus=200;holdChildRead=false;malformedChild=false;globalPaged=false;globalListStatus=200;globalFailCursor="";holdGlobalList=false;malformedList="";hold=false;renamed="";memoryRemoved=false;memoryReadStatus=200;holdMemoryRead=false;sessionReadStatus=200;runReadStatus=200;listReadStatus=200;holdListRead=false;payloadStatus=200;holdPayload=false;malformedPayload="";for(const release of pending)release();pending.clear();await page.close();}
}
const href=(path:string,node="")=>`${server.url}#/seed?${new URLSearchParams({r:path,...(node?{node}:{})})}`;
const title=(page:Page,value:string)=>page.waitForFunction(value=>document.title===value,value);

const serverPath = (dialog = "", serverNode = "local", extra = "") => `server?url=${encodeURIComponent(`${server.url}seed-fixture/${serverNode}`)}${dialog ? `&dialog=${dialog}` : ""}${extra}`;
const dialogTitle = (dialog: string, serverNode = "local", node = "") => `${dialog === "accounts" ? "Server accounts" : "Model providers"} · ${server.url}seed-fixture/${serverNode} · Seed server${node ? ` · ${node === "peer-a" ? "Peer A" : "Peer B"}` : ""} · Cyberdeck`;

test("Seed global menu shortcuts use canonical server dialog links and return to the global list", () => fresh(async page => {
 for (const dialog of ["accounts", "providers"]) {
  await page.goto(href("", "peer-a"));
  await page.getByRole("button", { name: "Agent Server", exact: true }).click();
  await page.getByRole("menuitem", { name: /Unreachable|127\.0\.0\.1|Local/ }).first().hover();
  await page.getByRole("menuitem", { name: dialog === "accounts" ? "Accounts" : "Providers", exact: true }).click();
  await title(page, dialogTitle(dialog, "peer-a", "peer-a"));
  expect(new URLSearchParams(new URL(page.url()).hash.slice(7)).get("r")).toBe(serverPath(dialog, "peer-a"));
  await page.goBack(); await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Agent Server", exact: true }).waitFor();
 }
}), browserBudget);

test("Seed server read dialogs restore on direct links, reload and fresh tabs with the selected signing node", () => fresh(async page => {
 for (const dialog of ["providers", "accounts"]) {
  populatedServerDialog = true;
  await page.goto(href(serverPath(dialog, "peer-a"), "peer-a"));
  await title(page, dialogTitle(dialog, "peer-a", "peer-a"));
  await page.getByRole("dialog").waitFor();
  if (dialog === "providers") await page.getByText("Provider on peer-a", { exact: true }).waitFor();
  else expect(await page.getByRole("dialog").getByRole("textbox").inputValue()).toBe("Account on peer-a");
  await page.reload(); await title(page, dialogTitle(dialog, "peer-a", "peer-a"));
  const link = page.url();
  await fresh(async tab => { await tab.goto(link); await title(tab, dialogTitle(dialog, "peer-a", "peer-a")); await tab.getByRole("dialog").waitFor(); });
 }
}), browserBudget);

test("Seed server dialog open/close uses one history entry and retains the list and composer", () => fresh(async page => {
 await page.goto(href(serverPath("", "local", "&pages=2")));
 await page.getByRole("button", { name: "Providers", exact: true }).waitFor();
 await page.evaluate(() => { (document.querySelector("textarea") as any).__navigationFixtureOwner = "same composer"; });
 const before = await page.evaluate(() => history.length);
 await page.getByRole("button", { name: "Providers", exact: true }).click();
 await title(page, dialogTitle("providers"));
 expect(await page.evaluate(() => history.length)).toBe(before + 1);
 await page.goBack(); await page.getByRole("dialog").waitFor({ state: "hidden" });
 expect(await page.evaluate(() => (document.querySelector("textarea") as any).__navigationFixtureOwner)).toBe("same composer");
 await page.goForward(); await title(page, dialogTitle("providers"));
 await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" });
 expect(new URLSearchParams(new URL(page.url()).hash.split("?").slice(1).join("?")).get("r")).not.toContain("dialog=");
 await page.goBack(); await title(page, dialogTitle("providers"));
 await page.evaluate(hash => location.hash = hash, new URL(href(serverPath("accounts"))).hash);
 await title(page, dialogTitle("accounts"));
 await page.goBack(); await title(page, dialogTitle("providers"));
 expect(await page.evaluate(() => (document.querySelector("textarea") as any).__navigationFixtureOwner)).toBe("same composer");
}), browserBudget);

test("Seed invalid dialog selections normalize with replace and never restore write forms", () => fresh(async page => {
 for (const dialog of ["import", "new-account", "add-provider", "delete", "PROVIDERS"]) {
  await page.goto(href(serverPath(dialog)));
  await page.getByRole("button", { name: "Providers", exact: true }).waitFor();
  await page.waitForFunction(() => !new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1)).get("r")?.includes("dialog="));
  expect(await page.getByRole("dialog").count()).toBe(0);
 }
 await page.getByRole("button", { name: "Providers", exact: true }).click(); await title(page, dialogTitle("providers"));
 const link = page.url(), length = await page.evaluate(() => history.length);
 await page.getByRole("button", { name: "Add provider", exact: true }).click();
 await page.getByRole("heading", { name: "Add model provider", exact: true }).waitFor();
 expect(page.url()).toBe(link); expect(await page.evaluate(() => history.length)).toBe(length);
 await page.reload(); await title(page, dialogTitle("providers"));
 expect(await page.getByRole("heading", { name: "Add model provider", exact: true }).count()).toBe(0);
}), browserBudget);

for (const dialog of ["accounts", "providers"]) test(`Seed ${dialog} missing, denied, unavailable and malformed reads retry without history changes`, () => fresh(async page => {
 for (const [status, malformed, expected] of [[403, "", "Access denied"], [404, "", `${dialog === "accounts" ? "Server accounts" : "Model providers"} not found`], [503, "", `${dialog === "accounts" ? "Server accounts" : "Model providers"} unavailable`], [200, "response", `${dialog === "accounts" ? "Server accounts" : "Model providers"} unavailable`], [200, "list", `${dialog === "accounts" ? "Server accounts" : "Model providers"} unavailable`], [200, "entry", `${dialog === "accounts" ? "Server accounts" : "Model providers"} unavailable`]] as const) {
  serverDialogStatus = status; malformedServerDialog = malformed;
  await page.goto("about:blank");
  await page.goto(href(serverPath(dialog)));
  await title(page, `${expected} · Seed · Cyberdeck`);
  expect(await page.getByRole("dialog").getByText(dialog === "accounts" ? "No agent accounts exist on this server yet." : "No providers configured yet.", { exact: true }).count()).toBe(0);
  const url = page.url(), length = await page.evaluate(() => history.length);
  serverDialogStatus = 200; malformedServerDialog = "";
  await page.getByRole("dialog").getByRole("button", { name: /retry|try again/i }).click();
  await title(page, dialogTitle(dialog));
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
 }
}), browserBudget);

test("Seed delayed dialog reads cannot rename a different dialog, node, primary view or authentication screen", () => fresh(async page => {
 for (const destination of ["dialog", "node", "data", "locked"]) {
  holdServerDialog = true; serverDialogStatus = 503;
  await page.goto("about:blank");
  await page.goto(href(serverPath("providers")));
  await title(page, "Loading model providers · Seed · Cyberdeck");
  while (!pending.size) await page.waitForTimeout(10);
  holdServerDialog = false; serverDialogStatus = 200;
  const target = destination === "dialog" ? new URL(href(serverPath("accounts"))).hash
    : destination === "node" ? new URL(href(serverPath("accounts", "peer-b"), "peer-b")).hash
    : destination === "data" ? "#/data" : "#/files";
  if (destination === "locked") await page.route("**/api/fs/list**", route => route.fulfill({ status: 401, json: { error: "Locked" } }));
  await page.evaluate(hash => location.hash = hash, target);
  const expected = destination === "dialog" ? dialogTitle("accounts") : destination === "node" ? dialogTitle("accounts", "peer-b", "peer-b") : destination === "data" ? "Data · Cyberdeck" : "Locked · Cyberdeck";
  await title(page, expected);
  for (const release of pending) release(); pending.clear();
  await page.waitForTimeout(100); expect(await page.title()).toBe(expected);
  if (destination === "locked") await page.unroute("**/api/fs/list**");
 }
}), browserBudget);

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

const toolPath = (extra = "") => `session/tools?panel=tool&event=tool-event-2&tool=${encodeURIComponent(toolId)}${extra}`;
const toolTitle = (node = "local", prefix = "Tool input/output", suffix = "") => `${prefix} · read · ${node} First conversation · Seed session${suffix} · Cyberdeck`;

test("Seed tool inspectors restore collapsed tools on direct links, reload, new tabs and history", () => fresh(async page => {
 await page.goto(href("session/tools", "peer-b"));
 await title(page, "peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await page.getByPlaceholder("Untitled session").evaluate(el => el.setAttribute("data-tool-owner", "retained"));
 const start = reads.length, length = await page.evaluate(() => history.length);
 await page.locator('button[title="Show all tool calls"]').click();
 await page.getByRole("button", { name: "View raw tool input/output" }).first().click();
 await title(page, toolTitle("peer-b", "Tool input/output", " · Peer B"));
 await page.getByRole("dialog").filter({ hasText: "Raw tool call payload" }).waitFor();
 const link = page.url();
 const nested = new URLSearchParams(new URL(link).hash.slice(7)).get("r")!;
 expect(new URLSearchParams(nested.split("?")[1]).get("tool")).toBe(toolId);
 expect(await page.evaluate(() => history.length)).toBe(length + 2);
 expect(reads.slice(start).filter(({ action }) => ["GetSession", "GetSessionEvent"].includes(action._)).length).toBe(0);
 await page.goBack(); await title(page, "1 expanded tool group · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await page.getByRole("dialog").waitFor({ state: "hidden" });
 expect(await page.getByPlaceholder("Untitled session").getAttribute("data-tool-owner")).toBe("retained");
 await page.goForward(); await page.getByRole("dialog").waitFor();
 await page.reload(); await title(page, toolTitle("peer-b", "Tool input/output", " · Peer B"));
 expect(await page.getByRole("dialog").innerText()).toContain("Truncated fixture input");
 await fresh(async tab => { await tab.goto(link); await title(tab, toolTitle("peer-b", "Tool input/output", " · Peer B")); await tab.getByRole("dialog").waitFor(); });
 await page.keyboard.press("Escape");
 await title(page, "Message · 1 expanded tool group · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await page.goBack(); await page.getByRole("dialog").waitFor();
}), browserBudget);

test("Seed full tool input and output are URL-owned read selections with one history entry each", () => fresh(async page => {
 await page.goto(href(toolPath(), "peer-a")); await title(page, toolTitle("peer-a", "Tool input/output", " · Peer A"));
 const length = await page.evaluate(() => history.length), start = reads.length;
 await page.getByTestId("seed-full-input").getByRole("button").click();
 await title(page, toolTitle("peer-a", "Full input", " · Peer A"));
 await page.getByRole("dialog").getByText('"path": "Full fixture input on peer-a"', { exact: false }).waitFor();
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 await page.getByTestId("seed-full-output").getByRole("button").click();
 await title(page, toolTitle("peer-a", "Full input/output", " · Peer A"));
 await page.getByRole("dialog").getByText('"content": "Full fixture output on peer-a"', { exact: false }).waitFor();
 const link = page.url();
 expect(await page.evaluate(() => history.length)).toBe(length + 2);
 expect(reads.slice(start).filter(({ action }) => action._ === "GetSession").length).toBe(0);
 expect(reads.slice(start).filter(({ action }) => action._ === "GetSessionEvent").map(({ action }) => action.seq)).toEqual([2, 3]);
 const beforeBack = reads.length;
 await page.goBack(); await title(page, toolTitle("peer-a", "Full input", " · Peer A"));
 expect(await page.getByRole("dialog").innerText()).toContain("Truncated fixture output");
 await page.goBack(); await title(page, toolTitle("peer-a", "Tool input/output", " · Peer A"));
 expect(await page.getByRole("dialog").innerText()).toContain("Truncated fixture input");
 await page.goForward(); await page.goForward();
 await title(page, toolTitle("peer-a", "Full input/output", " · Peer A"));
 expect(reads.slice(beforeBack).filter(({ action }) => action._ === "GetSessionEvent").length).toBe(0);
 await page.reload(); await title(page, toolTitle("peer-a", "Full input/output", " · Peer A"));
 await page.getByRole("dialog").getByText('"content": "Full fixture output on peer-a"', { exact: false }).waitFor();
 await fresh(async tab => { await tab.goto(link); await title(tab, toolTitle("peer-a", "Full input/output", " · Peer A")); await tab.getByRole("dialog").getByText('"path": "Full fixture input on peer-a"', { exact: false }).waitFor(); });
 await page.getByTestId("seed-full-input").getByRole("button").click();
 await title(page, toolTitle("peer-a", "Full output", " · Peer A"));
 expect(await page.getByRole("dialog").innerText()).toContain("Truncated fixture input");
}), browserBudget);

test("Seed tool payload failures preserve links, match titles and retry in place", () => fresh(async page => {
 for (const [status, expected] of [[403, "Access denied"], [404, "Tool payload not found"], [503, "Tool payload unavailable"]] as const) {
  payloadStatus = status;
  await page.goto("about:blank"); await page.goto(href(toolPath("&full=input")));
  await title(page, `${expected} · Seed · Cyberdeck`);
  await page.getByRole("dialog").getByRole("alert").filter({ hasText: "Full payload read failed" }).waitFor();
  const url = page.url(), length = await page.evaluate(() => history.length);
  payloadStatus = 200;
  await page.getByTestId("seed-full-input").getByRole("button", { name: "Retry", exact: true }).click();
  await title(page, toolTitle("local", "Full input"));
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
  expect(await page.getByRole("dialog").innerText()).toContain("Full fixture input on local");
 }
 await page.evaluate(() => location.hash = "#/data"); await title(page, "Data · Cyberdeck");
}), browserBudget);

test("Seed full payloads reject mismatched sessions, event sequences, tool IDs and event types", () => fresh(async page => {
 for (const malformed of ["session", "seq", "tool", "type"]) {
  malformedPayload = malformed;
  await page.goto("about:blank"); await page.goto(href(toolPath("&full=output")));
  await title(page, "Tool payload unavailable · Seed · Cyberdeck");
  expect(await page.getByRole("dialog").innerText()).toContain("Invalid full payload response");
  expect(await page.getByRole("dialog").innerText()).not.toContain("Full fixture output");
  malformedPayload = "";
  await page.getByTestId("seed-full-output").getByRole("button", { name: "Retry", exact: true }).click();
  await title(page, toolTitle("local", "Full output"));
  expect(await page.getByRole("dialog").innerText()).toContain("Full fixture output on local");
 }
}), browserBudget);

test("Seed late full payload results cannot reopen or rename a later tool, session, node or view", () => fresh(async page => {
 holdPayload = true; payloadStatus = 403;
 await page.goto(href(toolPath("&full=input"), "peer-a"));
 while (!pending.size) await page.waitForTimeout(10);
 await page.evaluate(() => location.hash = "#/seed?" + new URLSearchParams({ node: "peer-b", r: "session/tools?panel=tool&tool=status-call" }));
 await title(page, "Tool input/output · status · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 const url = page.url(), length = await page.evaluate(() => history.length);
 for (const release of pending) release(); pending.clear(); holdPayload = false;
 await page.waitForTimeout(120);
 expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
 expect(await page.title()).toBe("Tool input/output · status · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 expect(await page.getByRole("dialog").innerText()).not.toContain("Full payload read failed");
 holdPayload = true; payloadStatus = 200;
 await page.goto(href(toolPath("&full=output")));
 while (!pending.size) await page.waitForTimeout(10);
 await page.evaluate(() => location.hash = "#/seed?r=session%2Ftwo");
 await title(page, "local Second conversation · Seed session · Cyberdeck");
 for (const release of pending) release(); pending.clear(); holdPayload = false;
 await page.waitForTimeout(100);
 expect(await page.title()).toBe("local Second conversation · Seed session · Cyberdeck");
 await page.getByRole("dialog").waitFor({ state: "hidden" });
 await page.getByTestId("nav-data").click(); await title(page, "Data · Cyberdeck");
}), browserBudget);

test("Seed missing and malformed tool links retain honest selections and canonical defaults", () => fresh(async page => {
 const start = reads.length;
 await page.goto(href("session/tools?panel=tool&tool=missing&full=both"));
 await title(page, "Tool call not found · Seed · Cyberdeck");
 await page.getByRole("dialog").filter({ hasText: "The selected tool call is not in this transcript" }).waitFor();
 const link = page.url();
 await page.reload(); await title(page, "Tool call not found · Seed · Cyberdeck");
 expect(page.url()).toBe(link);
 expect(reads.slice(start).filter(({ action }) => action._ === "GetSessionEvent").length).toBe(0);
 for (const [path, canonical] of [["session/tools?panel=tool&full=input", "session/tools"], [toolPath("&full=99"), toolPath()], ["session/tools?tool=unused&full=input", "session/tools"], ["session/tools?panel=tool&tool=status-call&event=unknown&full=both", "session/tools?panel=tool&event=tool-event-2&tool=status-call"]]) {
  await page.goto(href(path));
  await page.waitForFunction(canonical => new URLSearchParams(location.hash.slice(7)).get("r") === canonical, canonical);
  const length = await page.evaluate(() => history.length);
  await page.reload();
  await page.waitForFunction(canonical => new URLSearchParams(location.hash.slice(7)).get("r") === canonical, canonical);
  expect(await page.evaluate(() => history.length)).toBe(length);
 }
}), browserBudget);

test("Seed recorded status and continuation inspectors use navigable raw content without following a successor", () => fresh(async page => {
 await page.goto(href("session/tools")); await title(page, "local First conversation · Seed session · Cyberdeck");
 await page.getByRole("button", { name: "Model, timing, and raw payload for this update" }).click();
 await title(page, "Tool input/output · status · local First conversation · Seed session · Cyberdeck");
 expect(await page.getByRole("dialog").innerText()).toContain("Recorded status");
 const link = page.url();
 await page.reload(); await title(page, "Tool input/output · status · local First conversation · Seed session · Cyberdeck");
 await page.goto(href("session/tools?panel=tool&tool=continued-call"));
 await title(page, "Tool input/output · continue_session · local First conversation · Seed session · Cyberdeck");
 expect(await page.getByRole("dialog").innerText()).toContain("Recorded successor");
 await page.goBack(); await title(page, "Tool input/output · status · local First conversation · Seed session · Cyberdeck");
 expect(page.url()).toBe(link);
}), browserBudget);

test("Sessions retains machine filters and its transcript owner for tool payload history and fresh links", () => fresh(async page => {
 const link = `${server.url}#/term?` + new URLSearchParams({ session: "seed-tools", node: "peer-b", filter: "peer-b", panel: "tool", tool: toolId, full: "both" });
 await page.goto(link); await title(page, toolTitle("peer-b", "Full input/output", " · Peer B"));
 await page.getByRole("dialog").getByText('"path": "Full fixture input on peer-b"', { exact: false }).waitFor();
 await page.getByPlaceholder("Untitled session").evaluate(el => el.setAttribute("data-tool-owner", "sessions"));
 await page.getByTestId("seed-full-output").getByRole("button").click();
 await title(page, toolTitle("peer-b", "Full input", " · Peer B"));
 expect(new URLSearchParams(new URL(page.url()).hash.slice(7)).get("filter")).toBe("peer-b");
 await page.goBack(); await title(page, toolTitle("peer-b", "Full input/output", " · Peer B"));
 expect(await page.getByPlaceholder("Untitled session").getAttribute("data-tool-owner")).toBe("sessions");
 await page.reload(); await title(page, toolTitle("peer-b", "Full input/output", " · Peer B"));
 await fresh(async tab => { await tab.goto(link); await title(tab, toolTitle("peer-b", "Full input/output", " · Peer B")); await tab.getByRole("dialog").waitFor(); });
 await page.keyboard.press("Escape"); await title(page, "Message · peer-b First conversation · Seed session · Peer B · Cyberdeck");
 await page.goBack(); await page.getByRole("dialog").waitFor();
 await page.goto(`${server.url}#/term?session=seed-tools&panel=tool&full=unknown&tool=`);
 await title(page, "local First conversation · Seed session · Cyberdeck");
 await page.waitForFunction(() => !["panel", "tool", "full"].some(key => new URLSearchParams(location.hash.slice(7)).has(key)));
}), browserBudget);

test("Seed external-server tool details retain the signer and late reads cannot cross a lock boundary", () => fresh(async page => {
 const remote = `${server.url}seed-fixture/external`;
 await page.goto(href(toolPath(`&full=both&server=${encodeURIComponent(remote)}`), "peer-b"));
 await title(page, toolTitle("external", "Full input/output", " · Peer B"));
 await page.getByRole("dialog").getByText('"path": "Full fixture input on external"', { exact: false }).waitFor();
 const selected = reads.filter(({ action }) => action._ === "GetSessionEvent").slice(-2);
 expect(selected.map(read => read.node)).toEqual(["external", "external"]);
 holdPayload = true; payloadStatus = 403;
 await page.goto(href(toolPath("&full=input"), "peer-a"));
 while (!pending.size) await page.waitForTimeout(10);
 await page.route("**/api/fs/list**", route => route.fulfill({ status: 401, json: { error: "Locked" } }));
 await page.evaluate(() => location.hash = "#/files");
 await page.getByPlaceholder("access token").waitFor(); await title(page, "Locked · Cyberdeck");
 for (const release of pending) release(); pending.clear(); holdPayload = false;
 await page.waitForTimeout(100);
 expect(await page.title()).toBe("Locked · Cyberdeck");
 await page.getByRole("dialog").waitFor({ state: "hidden" });
}), browserBudget);

const listReads = (start = 0) => reads.slice(start).filter(({ action }) => action._ === "ListSessions" && !action.agentId && !action.parentSessionId);
const listRoute = (pages = 1, remote = "") => (remote ? `server?url=${encodeURIComponent(remote)}` : "") + (pages > 1 ? `${remote ? "&" : "?"}pages=${pages}` : "");
const listTitle = (pages = 1, remote = "", suffix = "") => (remote ? `Sessions${pages > 1 ? ` · ${pages} pages` : ""} · ${remote} · Seed server` : pages > 1 ? `Sessions · ${pages} pages · Seed` : "Seed") + suffix + " · Cyberdeck";

test("Seed global session pages restore direct, reload and new-tab links and undo explicit Load more", () => fresh(async page => {
 globalPaged = true;
 await page.goto(href("")); await title(page, listTitle());
 const length = await page.evaluate(() => history.length);
 await page.getByRole("button", { name: "Load more sessions", exact: true }).click();
 await title(page, listTitle(2)); await page.getByText("local Second conversation", { exact: true }).waitFor();
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 await page.getByRole("button", { name: "Load more sessions", exact: true }).click();
 await title(page, listTitle(3)); await page.getByText("local Older conversation", { exact: true }).waitFor();
 const link = page.url();
 await page.goBack(); await title(page, listTitle(2));
 expect(await page.getByText("local Older conversation", { exact: true }).count()).toBe(0);
 await page.goForward(); await title(page, listTitle(3));
 expect(page.url()).toBe(link);
 await page.reload(); await title(page, listTitle(3));
 await fresh(async tab => { globalPaged = true; await tab.goto(link); await title(tab, listTitle(3)); await tab.getByText("local Older conversation", { exact: true }).waitFor(); });
}), browserBudget);

test("Seed server pages retain explicit server and signer node across history and fresh links", () => fresh(async page => {
 globalPaged = true;
 const remote = `${server.url}seed-fixture/external`;
 const link = href(listRoute(2, remote), "peer-b");
 const start = reads.length;
 await page.goto(link); await title(page, listTitle(2, remote, " · Peer B"));
 await page.getByText("external Second conversation", { exact: true }).waitFor();
 expect(listReads(start).map(({ node, action }) => [node, action.cursor || "first"])).toEqual([["external", "first"], ["external", "page-2"]]);
 await page.reload(); await title(page, listTitle(2, remote, " · Peer B"));
 await fresh(async tab => { globalPaged = true; await tab.goto(page.url()); await title(tab, listTitle(2, remote, " · Peer B")); });
 await page.getByTestId("seed-node").selectOption("peer-a"); await title(page, "Seed · Peer A · Cyberdeck");
 await page.goBack(); globalPaged = true; await title(page, listTitle(2, remote, " · Peer B"));
}), browserBudget);

test("Seed global list rounds restore unequal per-server cursors without duplicates or extra entries", () => fresh(async page => {
 globalPaged = true;
 await page.addInitScript(urls => localStorage.setItem("seed.agents.setting.agent-server-urls", JSON.stringify(urls)), [`${server.url}seed-fixture/local`, `${server.url}seed-fixture/external`]);
 const start = reads.length;
 await page.goto(href(listRoute(3))); await title(page, listTitle(3));
 for (const name of ["local First conversation", "local Second conversation", "local Older conversation", "external First conversation", "external Second conversation"]) {
  expect(await page.getByText(name, { exact: true }).count()).toBe(1);
 }
 expect(await page.getByText("external Older conversation", { exact: true }).count()).toBe(0);
 expect(listReads(start).map(({ node, action }) => `${node}:${action.cursor || "first"}`).sort()).toEqual(["local:first", "local:page-2", "local:page-3", "external:first", "external:page-2"].sort());
 const length = await page.evaluate(() => history.length);
 await page.reload(); await title(page, listTitle(3));
 expect(await page.evaluate(() => history.length)).toBe(length);
}), browserBudget);

test("Seed invalid/default and exhausted global/server page counts canonicalize with replace", () => fresh(async page => {
 globalPaged = true;
 const remote = `${server.url}seed-fixture/external`;
 for (const value of ["1", "0", "-1", "101", "NaN", "2.5", "02", "2%26junk"]) {
  await page.goto(href(`?pages=${value}`)); await title(page, listTitle());
  await page.waitForFunction(() => !new URLSearchParams(location.hash.slice(7)).has("r"));
  await page.goto(href(`server?url=${encodeURIComponent(remote)}&pages=${value}`)); await title(page, listTitle(1, remote));
  await page.waitForFunction(remote => new URLSearchParams(location.hash.slice(7)).get("r") === `server?url=${encodeURIComponent(remote)}`, remote);
 }
 const length = await page.evaluate(() => history.length);
 await page.evaluate(() => { location.hash = "#/seed?r=" + encodeURIComponent("?pages=100"); });
 await title(page, listTitle(3));
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 await page.waitForFunction(() => new URLSearchParams(location.hash.slice(7)).get("r") === "?pages=3");
 await page.goto(href(listRoute(100, remote))); await title(page, listTitle(2, remote));
 expect(new URLSearchParams(new URL(page.url()).hash.slice(7)).get("r")).toBe(listRoute(2, remote));
}), browserBudget);

test("Seed later global-list failures retain earlier rows, honest titles and retry without URL/history changes", () => fresh(async page => {
 globalPaged = true; globalFailCursor = "page-2";
 for (const [status, expected] of [[401, "Access denied"], [403, "Access denied"], [404, "Sessions not found"], [503, "Sessions unavailable"]] as const) {
  globalListStatus = status;
  await page.goto(href(listRoute(2))); await page.reload(); await title(page, `${expected} · Seed · Cyberdeck`);
  await page.getByText("local First conversation", { exact: true }).waitFor();
  const url = page.url(), length = await page.evaluate(() => history.length);
  globalListStatus = 200;
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await title(page, listTitle(2));
  await page.getByText("local Second conversation", { exact: true }).waitFor();
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
 }
}), browserBudget);

test("Seed malformed lists and repeated cursors stop safely and retry the displayed read", () => fresh(async page => {
 globalPaged = true; globalFailCursor = "page-2";
 for (const malformed of ["response", "sessions", "agents", "cursor", "repeat"]) {
  malformedList = malformed;
  await page.goto(href(listRoute(3))); await page.reload(); await title(page, "Sessions unavailable · Seed · Cyberdeck");
  await page.getByText("local First conversation", { exact: true }).waitFor();
  const url = page.url(), length = await page.evaluate(() => history.length);
  malformedList = "";
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await title(page, listTitle(3));
  await page.getByText("local Older conversation", { exact: true }).waitFor();
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
 }
}), browserBudget);

test("Seed delayed global pages cannot repopulate Back or rename another node, server or locked screen", () => fresh(async page => {
 globalPaged = true; globalFailCursor = "page-2"; holdGlobalList = true;
 await page.goto(href("")); await title(page, listTitle());
 await page.getByRole("button", { name: "Load more sessions", exact: true }).click();
 while (!pending.size) await page.waitForTimeout(10);
 await title(page, "Loading sessions · Seed · Cyberdeck");
 await page.goBack(); await title(page, listTitle());
 for (const release of pending) release(); pending.clear(); holdGlobalList = false;
 await page.waitForTimeout(100);
 expect(await page.getByText("local Second conversation", { exact: true }).count()).toBe(0);
 expect(await page.title()).toBe(listTitle());
 holdGlobalList = true; globalListStatus = 403;
 await page.goto(href(listRoute(2), "peer-a")); while (!pending.size) await page.waitForTimeout(10);
 await page.evaluate(() => location.hash = "#/seed?node=peer-b&r=session%2Ftwo");
 await title(page, "peer-b Second conversation · Seed session · Peer B · Cyberdeck");
 for (const release of pending) release(); pending.clear(); holdGlobalList = false;
 await page.waitForTimeout(100); expect(await page.title()).toBe("peer-b Second conversation · Seed session · Peer B · Cyberdeck");
 holdGlobalList = true;
 await page.goto(href(listRoute(2))); while (!pending.size) await page.waitForTimeout(10);
 await page.route("**/api/fs/list**", route => route.fulfill({ status: 401, json: { error: "Locked" } }));
 await page.getByTestId("nav-files").click(); await page.getByPlaceholder("access token").waitFor(); await title(page, "Locked · Cyberdeck");
 for (const release of pending) release(); pending.clear(); holdGlobalList = false;
 await page.waitForTimeout(100); expect(await page.title()).toBe("Locked · Cyberdeck");
}), browserBudget);

const childToken = (id: string, node = "local") => JSON.stringify([node === "external" ? `${server.url}seed-fixture/external` : "@host", id]);
const withChildren = (path: string, ids: string[], node = "local") => path + ids.map((id, index) => `${path.includes("?") || index ? "&" : "?"}child=${encodeURIComponent(childToken(id, node))}`).join("");
const childReads = (start = 0) => reads.slice(start).filter(({ action }) => action._ === "ListSessions" && !!action.parentSessionId);

test("Seed sub-session disclosures restore multiple parents and preserve the list/composer owner through history", () => fresh(async page => {
 childLists = true;
 await page.goto(href("")); await title(page, listTitle());
 await page.getByTestId("seed-agents").evaluate(el => el.setAttribute("data-list-owner", "kept"));
 const length = await page.evaluate(() => history.length);
 await page.getByRole("button", { name: "2 sub-sessions", exact: true }).click();
 await page.getByText("local Child of one", { exact: true }).waitFor();
 await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck");
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 await page.getByRole("button", { name: "1 sub-session", exact: true }).click();
 await page.getByText("local Child of two", { exact: true }).waitFor();
 await title(page, "Sessions · 2 sub-session lists · Seed · Cyberdeck");
 const url = page.url();
 await page.goBack(); await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck");
 expect(await page.getByText("local Child of two", { exact: true }).count()).toBe(0);
 await page.goForward(); await title(page, "Sessions · 2 sub-session lists · Seed · Cyberdeck");
 expect(await page.getByTestId("seed-agents").getAttribute("data-list-owner")).toBe("kept");
 expect(page.url()).toBe(url);
 await page.reload(); await title(page, "Sessions · 2 sub-session lists · Seed · Cyberdeck");
 await page.getByText("local Child of one", { exact: true }).waitFor(); await page.getByText("local Child of two", { exact: true }).waitFor();
 await fresh(async tab => { childLists = true; await tab.goto(url); await title(tab, "Sessions · 2 sub-session lists · Seed · Cyberdeck"); await tab.getByText("local Child of two", { exact: true }).waitFor(); });
}), browserBudget);

test("Seed agent and server sub-session links retain their owner, node and pages on direct open/reload", () => fresh(async page => {
 childLists = true; globalPaged = true;
 await page.goto(href(withChildren("agent/alpha", ["one"], "peer-b"), "peer-b"));
 await page.getByText("peer-b Child of one", { exact: true }).waitFor();
 await title(page, "Sessions · Sub-sessions · peer-b Alpha assistant · Seed · Peer B · Cyberdeck");
 await page.reload(); await title(page, "Sessions · Sub-sessions · peer-b Alpha assistant · Seed · Peer B · Cyberdeck");
 const remote = `${server.url}seed-fixture/external`;
 await page.goto(href(withChildren(listRoute(2, remote), ["two"], "external"), "peer-a"));
 await page.getByText("external Child of two", { exact: true }).waitFor();
 await title(page, `Sessions · 2 pages · Sub-sessions · ${remote} · Seed server · Peer A · Cyberdeck`);
 const link = page.url();
 await page.reload(); await title(page, `Sessions · 2 pages · Sub-sessions · ${remote} · Seed server · Peer A · Cyberdeck`);
 expect(page.url()).toBe(link);
}), browserBudget);

test("Seed sub-session selection never reads an absent parent or a URL-injected server", () => fresh(async page => {
 childLists = true;
 const start = reads.length;
 for (const path of [withChildren("", ["absent"]), withChildren("agent/alpha", ["absent"]), withChildren("", ["one"], "external")]) {
  await page.goto(href(path));
  await title(page, "Sub-session parent not found · Seed · Cyberdeck");
  await page.getByText("A selected parent session is not in this list. The link has been kept.", { exact: true }).waitFor();
  const link = page.url(); await page.reload(); await title(page, "Sub-session parent not found · Seed · Cyberdeck"); expect(page.url()).toBe(link);
 }
 expect(childReads(start)).toEqual([]);
}), browserBudget);

test("Seed malformed/duplicate child selections canonicalize once, and unrelated tabs remove list-only state", () => fresh(async page => {
 childLists = true;
 const token = childToken("one");
 await page.goto(href(`?child=invalid&child=${encodeURIComponent(token)}&child=${encodeURIComponent(token)}&child=${encodeURIComponent('["", "bad"]')}`));
 await page.getByText("local Child of one", { exact: true }).waitFor();
 await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck");
 const expected = withChildren("", ["one"]);
 await page.waitForFunction(expected => new URLSearchParams(location.hash.slice(7)).get("r") === expected, expected);
 const length = await page.evaluate(() => history.length);
 await page.reload(); await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck"); expect(await page.evaluate(() => history.length)).toBe(length);
 await page.goto(href(withChildren("agent/alpha?tab=settings&pages=3", ["one"])));
 await title(page, "Settings · local Alpha assistant · Seed · Cyberdeck");
 await page.waitForFunction(() => new URLSearchParams(location.hash.slice(7)).get("r") === "agent/alpha?tab=settings");
 await page.goto(href("unknown?pages=2")); await title(page, "Page not found · Seed · Cyberdeck");
}), browserBudget);

test("Seed failed and malformed sub-session reads retry without changing URL, history or the parent list", () => fresh(async page => {
 childLists = true;
 const path = withChildren("", ["one"]);
 for (const [status, malformed, expected] of [[401, false, "Access denied"], [403, false, "Access denied"], [404, false, "Sub-sessions not found"], [503, false, "Sub-sessions unavailable"], [200, true, "Sub-sessions unavailable"]] as const) {
  childReadStatus = status; malformedChild = malformed;
  const start = reads.length;
  await page.goto(href(path)); await page.reload(); await title(page, `${expected} · Seed · Cyberdeck`);
  await page.getByText("local First conversation", { exact: true }).waitFor();
  expect(childReads(start).length).toBeLessThanOrEqual(2);
  const url = page.url(), length = await page.evaluate(() => history.length);
  childReadStatus = 200; malformedChild = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck");
  await page.getByText("local Child of one", { exact: true }).waitFor();
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
 }
}), browserBudget);

test("Seed delayed sub-session reads cannot reopen a closed disclosure or rename a later page, node or locked view", () => fresh(async page => {
 childLists = true; holdChildRead = true;
 await page.goto(href("")); await title(page, listTitle());
 await page.getByRole("button", { name: "2 sub-sessions", exact: true }).click();
 while (!pending.size) await page.waitForTimeout(10);
 await title(page, "Loading sub-sessions · Seed · Cyberdeck");
 await page.goBack(); await title(page, listTitle());
 for (const release of pending) release(); pending.clear(); holdChildRead = false;
 await page.waitForTimeout(100); expect(await page.getByText("local Child of one", { exact: true }).count()).toBe(0); expect(await page.title()).toBe(listTitle());
 holdChildRead = true; childReadStatus = 403;
 await page.goto(href(withChildren("agent/alpha", ["one"], "peer-a"), "peer-a")); while (!pending.size) await page.waitForTimeout(10);
 await page.evaluate(() => location.hash = "#/seed?node=peer-b&r=session%2Ftwo"); await title(page, "peer-b Second conversation · Seed session · Peer B · Cyberdeck");
 for (const release of pending) release(); pending.clear(); holdChildRead = false;
 await page.waitForTimeout(100); expect(await page.title()).toBe("peer-b Second conversation · Seed session · Peer B · Cyberdeck");
 holdChildRead = true;
 await page.goto(href(withChildren("", ["one"]))); while (!pending.size) await page.waitForTimeout(10);
 await page.route("**/api/fs/list**", route => route.fulfill({ status: 401, json: { error: "Locked" } }));
 await page.getByTestId("nav-files").click(); await page.getByPlaceholder("access token").waitFor(); await title(page, "Locked · Cyberdeck");
 for (const release of pending) release(); pending.clear(); holdChildRead = false;
 await page.waitForTimeout(100); expect(await page.title()).toBe("Locked · Cyberdeck");
}), browserBudget);

test("Seed one failed expanded parent stays visible in the title while another succeeds", () => fresh(async page => {
 childLists = true; childReadStatus = 403;
 await page.goto(href(withChildren("", ["one"]))); await title(page, "Access denied · Seed · Cyberdeck");
 childReadStatus = 200;
 await page.getByRole("button", { name: "1 sub-session", exact: true }).click();
 await page.getByText("local Child of two", { exact: true }).waitFor();
 expect(await page.title()).toBe("Access denied · Seed · Cyberdeck");
 await page.getByRole("button", { name: "2 sub-sessions", exact: true }).click();
 await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck");
 expect(await page.getByText("Couldn’t load sub-sessions", { exact: true }).count()).toBe(0);
}), browserBudget);

test("Seed a missing expanded parent on page one becomes a loading selection on its correct page", () => fresh(async page => {
 childLists = true; globalPaged = true;
 await page.goto(href(withChildren("", ["two"]))); await title(page, "Sub-session parent not found · Seed · Cyberdeck");
 holdGlobalList = true; globalFailCursor = "page-2";
 const next = withChildren(listRoute(2), ["two"]);
 await page.evaluate(next => location.hash = "#/seed?" + new URLSearchParams({ r: next }), next);
 while (!pending.size) await page.waitForTimeout(10);
 await title(page, "Loading sessions · Seed · Cyberdeck");
 for (const release of pending) release(); pending.clear(); holdGlobalList = false;
 await page.getByText("local Child of two", { exact: true }).waitFor();
 await title(page, "Sessions · 2 pages · Sub-sessions · Seed · Cyberdeck");
 expect(new URLSearchParams(new URL(page.url()).hash.slice(7)).get("r")).toBe(next);
}), browserBudget);

test("Seed first-page list failures are visible, retry in place and never unlock or lock the host", () => fresh(async page => {
 globalListStatus = 401;
 await page.goto(href("")); await title(page, "Access denied · Seed · Cyberdeck");
 await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
 expect(await page.getByPlaceholder("access token").count()).toBe(0);
 const url = page.url(), length = await page.evaluate(() => history.length);
 globalListStatus = 200;
 await page.getByRole("button", { name: "Retry", exact: true }).click(); await title(page, listTitle());
 await page.getByText("local First conversation", { exact: true }).waitFor();
 expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
}), browserBudget);

test("Seed links restore an expanded empty parent after its child count disappears", () => fresh(async page => {
 childEmpty = true;
 await page.goto(href(withChildren("", ["one"])));
 await page.getByText("No sub-sessions", { exact: true }).waitFor();
 await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck");
 const link = page.url();
 await page.reload(); await page.getByText("No sub-sessions", { exact: true }).waitFor();
 await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck");
 expect(page.url()).toBe(link);
 await page.getByRole("button", { name: "0 sub-sessions", exact: true }).click(); await title(page, listTitle());
 expect(await page.getByText("No sub-sessions", { exact: true }).count()).toBe(0);
 await page.goBack(); await page.getByText("No sub-sessions", { exact: true }).waitFor();
 await title(page, "Sessions · Sub-sessions · Seed · Cyberdeck");
}), browserBudget);

test("Seed an expanded-parent link stays honest on the empty first-agent view", () => fresh(async page => {
 emptySeedLists = true;
 await page.goto(href(withChildren(listRoute(8), ["one"])));
 await title(page, "Sub-session parent not found · Seed · Cyberdeck");
 await page.getByText("Create your first agent", { exact: true }).first().waitFor();
 await page.getByText("A selected parent session is not in this list. The link has been kept.", { exact: true }).waitFor();
 await page.waitForFunction(expected => new URLSearchParams(location.hash.slice(7)).get("r") === expected, withChildren("", ["one"]));
 const url = page.url(), length = await page.evaluate(() => history.length);
 await page.reload(); await title(page, "Sub-session parent not found · Seed · Cyberdeck");
 expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
}), browserBudget);

const thinkingHref = (view: "seed" | "term", ids: string[], node = "") => {
 const selected = new URLSearchParams(); for (const id of ids) selected.append("thinking", id);
 return view === "seed" ? href(`session/thinking${selected.size ? `?${selected}` : ""}`, node)
  : `${server.url}#/term?${new URLSearchParams({ session: "seed-thinking", filter: "retained", ...(node ? { node } : {}) })}${selected.size ? `&${selected}` : ""}`;
};
const thinkingTitle = (count: number, node = "local") => `${count ? `${count} expanded tool group${count === 1 ? "" : "s"} · ` : ""}${node} First conversation · Seed session${node === "peer-b" ? " · Peer B" : ""} · Cyberdeck`;
for (const view of ["seed", "term"] as const) {
 test(`${view} transcript expansion limit never drops another selection or adds unusable history`, () => fresh(async page => {
  const missing = Array.from({ length: 99 }, (_, index) => `missing-${String(index).padStart(2, "0")}`);
  await page.goto(thinkingHref(view, [thinkingIds[0], ...missing])); await title(page, "Tool group not found · Seed · Cyberdeck");
  const groups = page.locator('[data-thinking-group]');
  expect(await groups.nth(1).getByRole("button", { name: /Thought|Finished|Thinking/ }).isDisabled()).toBe(true);
  await groups.nth(0).getByRole("button", { name: /Thought|Finished|Thinking/ }).click();
  await groups.nth(1).getByRole("button", { name: /Thought|Finished|Thinking/ }).click();
  const selected = await page.evaluate(view => {
   const params = new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1));
   return view === "seed" ? new URLSearchParams(params.get("r")!.split("?")[1]).getAll("thinking") : params.getAll("thinking");
  }, view);
  expect(selected).toEqual([...missing, thinkingIds[1]].sort());
 }), browserBudget);

 test(`${view} transcript tool groups restore direct links, reload, fresh tabs and history without remounting`, () => fresh(async page => {
  await page.goto(thinkingHref(view, thinkingIds, "peer-b")); await title(page, thinkingTitle(2, "peer-b"));
  expect(await page.locator('[data-thinking-group] button[aria-expanded="true"]').count()).toBe(2);
  await page.getByPlaceholder("Untitled session").evaluate(el => el.setAttribute("data-thinking-owner", "same owner"));
  const readStart = reads.length, length = await page.evaluate(() => history.length);
  await page.locator('[data-thinking-group] button[aria-expanded="true"]').first().click(); await title(page, thinkingTitle(1, "peer-b"));
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.goBack(); await title(page, thinkingTitle(2, "peer-b"));
  expect(await page.locator('[data-thinking-group] button[aria-expanded="true"]').count()).toBe(2);
  await page.goForward(); await title(page, thinkingTitle(1, "peer-b"));
  expect(await page.getByPlaceholder("Untitled session").getAttribute("data-thinking-owner")).toBe("same owner");
  expect(reads.slice(readStart).filter(({ action }) => ["GetSession", "GetSessionEvent"].includes(action._)).length).toBe(0);
  if (view === "term") { const p = new URLSearchParams(new URL(page.url()).hash.slice(7)); expect(p.get("node")).toBe("peer-b"); expect(p.get("filter")).toBe("retained"); }
  await page.reload(); await title(page, thinkingTitle(1, "peer-b"));
  expect(await page.locator('[data-thinking-group] button[aria-expanded="true"]').count()).toBe(1);
  await fresh(async tab => { await tab.goto(page.url()); await title(tab, thinkingTitle(1, "peer-b")); expect(await tab.locator('[data-thinking-group] button[aria-expanded="true"]').count()).toBe(1); });
 }), browserBudget);

 test(`${view} transcript tool-group selections canonicalize and keep missing groups honest`, () => fresh(async page => {
  await page.goto(thinkingHref(view, [thinkingIds[1], thinkingIds[0], thinkingIds[1], "", "\u0001", "x".repeat(513)]));
  await title(page, thinkingTitle(2));
  const selected = () => page.evaluate((view) => {
   const params = new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1));
   return view === "seed" ? new URLSearchParams((params.get("r") || "").split("?")[1]).getAll("thinking") : params.getAll("thinking");
  }, view);
  expect(await selected()).toEqual(thinkingIds);
  const start = reads.length;
  await page.evaluate(hash => location.hash = hash, new URL(thinkingHref(view, [thinkingIds[0], "missing group"])).hash);
  await title(page, "Tool group not found · Seed · Cyberdeck"); await page.getByRole("alert").filter({ hasText: "Selected tool group is not in this transcript." }).waitFor();
  expect((await selected()).includes("missing group")).toBe(true);
  expect(reads.slice(start).filter(({ action }) => ["GetSession", "GetSessionEvent"].includes(action._)).length).toBe(0);
  await page.goBack(); await title(page, thinkingTitle(2));
  await page.getByTestId("nav-data").click(); await title(page, "Data · Cyberdeck");
 }), browserBudget);

 test(`${view} transcript tool groups survive inspector navigation and preserve share links`, () => fresh(async page => {
  await page.goto(thinkingHref(view, thinkingIds)); await title(page, thinkingTitle(2));
  await page.getByRole("button", { name: "View raw tool input/output", exact: true }).first().click();
  await page.getByRole("dialog").filter({ hasText: "Raw tool call payload" }).waitFor();
  await title(page, "Tool input/output · read · local First conversation · Seed session · Cyberdeck");
  await page.reload(); await page.getByRole("dialog").waitFor();
  expect(await page.locator('[data-thinking-group] button[aria-expanded="true"]').count()).toBe(2);
  await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" });
  await title(page, "Message · 2 expanded tool groups · local First conversation · Seed session · Cyberdeck");
  await page.getByRole("button", { name: "Show markdown sent to the LLM", exact: true }).first().click(); await page.getByRole("dialog").waitFor();
  const shared = await page.getByRole("dialog").locator("code").innerText();
  const params = new URLSearchParams(new URL(shared).hash.slice(7));
  expect(view === "seed" ? new URLSearchParams(params.get("r")!.split("?")[1]).getAll("thinking") : params.getAll("thinking")).toEqual(thinkingIds);
  await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator('[data-thinking-group] button[aria-expanded="true"]').last().click();
  await page.getByRole("button", { name: "Show markdown sent to the LLM", exact: true }).first().click(); await page.getByRole("dialog").waitFor();
  const updated = new URLSearchParams(new URL(await page.getByRole("dialog").locator("code").innerText()).hash.slice(7));
  expect(view === "seed" ? new URLSearchParams(updated.get("r")!.split("?")[1]).getAll("thinking") : updated.getAll("thinking")).toEqual([thinkingIds[0]]);
 }), browserBudget);
}

test("Seed delayed transcripts cannot publish an old tool-group failure after another session or lock", () => fresh(async page => {
 hold = true;
 await page.goto(href("session/slow?thinking=missing")); while (!pending.size) await page.waitForTimeout(10);
 await page.evaluate(hash => location.hash = hash, new URL(thinkingHref("seed", thinkingIds)).hash);
 await title(page, thinkingTitle(2));
 for (const release of pending) release(); pending.clear(); await page.waitForTimeout(100); expect(await page.title()).toBe(thinkingTitle(2));
 await page.route("**/api/fs/list**", route => route.fulfill({ status: 401, json: { error: "Locked" } }));
 await page.getByTestId("nav-files").click(); await title(page, "Locked · Cyberdeck");
}), browserBudget);

const contextHref = (view: "seed" | "term", event = "context-one", node = "", panel = "context") => {
 const selected = new URLSearchParams({ panel, ...(event ? { event } : {}) });
 return view === "seed" ? href(`session/contexts?${selected}`, node)
  : `${server.url}#/term?${new URLSearchParams({ session: "seed-contexts", filter: "retained", ...(node ? { node } : {}) })}&${selected}`;
};
const contextTitle = (node = "local") => `Message context · ${node} First conversation · Seed session${node === "peer-b" ? " · Peer B" : ""} · Cyberdeck`;
for (const view of ["seed", "term"] as const) {
 test(`${view} recorded message Context restores direct links, reload, new tabs and history`, () => fresh(async page => {
  await page.goto(contextHref(view, "context two/?&", "peer-b")); await title(page, contextTitle("peer-b"));
  await page.getByRole("dialog").getByText("Recorded window 2", { exact: false }).waitFor();
  await page.getByPlaceholder("Untitled session").evaluate(el => el.setAttribute("data-context-owner", "same owner"));
  const length = await page.evaluate(() => history.length), start = reads.length;
  await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" });
  await title(page, "Message · peer-b First conversation · Seed session · Peer B · Cyberdeck");
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.goBack(); await title(page, contextTitle("peer-b")); await page.getByRole("dialog").waitFor();
  await page.goForward(); await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Context", exact: true }).first().click(); await title(page, contextTitle("peer-b"));
  await page.getByRole("dialog").getByText("Recorded window 1", { exact: false }).waitFor();
  expect(await page.getByPlaceholder("Untitled session").getAttribute("data-context-owner")).toBe("same owner");
  expect(reads.slice(start).filter(({ action }) => ["GetSession", "GetSessionEvent"].includes(action._)).length).toBe(0);
  const link = page.url(); await page.reload(); await title(page, contextTitle("peer-b")); await page.getByRole("dialog").waitFor();
  await fresh(async tab => { await tab.goto(link); await title(tab, contextTitle("peer-b")); await tab.getByRole("dialog").getByText("Recorded project 1", { exact: false }).waitFor(); });
  if (view === "term") { const p = new URLSearchParams(new URL(page.url()).hash.slice(7)); expect(p.get("node")).toBe("peer-b"); expect(p.get("filter")).toBe("retained"); }
 }), browserBudget);

 test(`${view} missing message Context keeps honest errors and invalid defaults replace without read actions`, () => fresh(async page => {
  for (const event of ["no-context", "missing-message"]) {
   await page.goto(contextHref(view, event)); await title(page, "Message context not found · Seed · Cyberdeck");
   await page.getByRole("alert").filter({ hasText: "Selected message context is not in this transcript." }).waitFor();
   expect(page.url()).toContain(encodeURIComponent(event)); expect(await page.getByRole("dialog").count()).toBe(0);
  }
  await page.goto(contextHref(view, ""));
  await page.waitForFunction(view => {
   const p = new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1));
   return view === "seed" ? !new URLSearchParams((p.get("r") || "").split("?")[1]).has("panel") : !p.has("panel");
  }, view);
  await title(page, "local First conversation · Seed session · Cyberdeck");
  await page.getByRole("button", { name: "Context", exact: true }).first().click(); await title(page, contextTitle());
  await page.evaluate(() => location.hash = "#/data"); await title(page, "Data · Cyberdeck");
 }), browserBudget);
}

test("Delayed Seed Context reads cannot reopen a previous message, node or locked screen", () => fresh(async page => {
 hold = true;
 await page.goto(href("session/slow?panel=context&event=missing")); while (!pending.size) await page.waitForTimeout(10);
 await page.evaluate(hash => location.hash = hash, new URL(contextHref("seed", "context-one", "peer-b")).hash);
 await title(page, contextTitle("peer-b"));
 for (const release of pending) release(); pending.clear(); await page.waitForTimeout(100);
 expect(await page.title()).toBe(contextTitle("peer-b")); expect(await page.getByRole("dialog").count()).toBe(1);
 await page.route("**/api/fs/list**", route => route.fulfill({ status: 401, json: { error: "Locked" } }));
 await page.evaluate(() => location.hash = "#/files"); await title(page, "Locked · Cyberdeck"); expect(await page.getByRole("dialog").count()).toBe(0);
}), browserBudget);

for (const view of ["seed", "term"] as const) test(`${view} a primary-view click from Context makes one history entry and Back restores the popover`, () => fresh(async page => {
 await page.goto(contextHref(view)); await title(page, contextTitle()); await page.getByRole("dialog").waitFor();
 const length = await page.evaluate(() => history.length);
 await page.getByTestId("nav-data").click(); await title(page, "Data · Cyberdeck");
 expect(await page.evaluate(() => history.length)).toBe(length + 1);
 await page.goBack(); await title(page, contextTitle()); await page.getByRole("dialog").waitFor();
 await page.getByRole("dialog").getByText("Recorded window 1", { exact: false }).waitFor();
}), browserBudget);

for (const view of ["seed", "term"] as const) test(`${view} Context plain outside clicks close once and switching messages cannot dismiss the new context`, () => fresh(async page => {
 await page.goto(contextHref(view, "context two/?&")); await title(page, contextTitle()); await page.getByRole("dialog").waitFor();
 const length = await page.evaluate(() => history.length);
 await page.locator("header").first().getByText("Cyberdeck", { exact: true }).click(); await page.getByRole("dialog").waitFor({ state: "hidden" });
 await title(page, "Message · local First conversation · Seed session · Cyberdeck"); expect(await page.evaluate(() => history.length)).toBe(length + 1);
 await page.goBack(); await title(page, contextTitle()); await page.getByRole("dialog").getByText("Recorded window 2", { exact: false }).waitFor();
 await page.getByRole("button", { name: "Context", exact: true }).first().click();
 await page.getByRole("dialog").getByText("Recorded window 1", { exact: false }).waitFor(); await title(page, contextTitle());
}), browserBudget);


const runHref = (query = "", node = "") => href(`run/activity${query ? `?${query}` : ""}`, node);
const runTitle = (prefix = "", node = "") => `${prefix}${node || "local"} Review navigation · Seed run${node ? " · Peer A" : ""} · Cyberdeck`;
test("Seed run source and activity restore through direct links, reload, fresh tabs and node selection", () => fresh(async page => {
 for (const query of ["code=1", "activity=1", "code=1&activity=1&entry=activity%3A1"]) {
  await page.goto(runHref(query, "peer-a"));
  const prefix = query.includes("code=1") ? "Code · " : "";
  const expected = runTitle(prefix + (query.includes("entry=") ? "1 activity entry · " : query.includes("activity=1") ? "Activity · " : ""), "peer-a");
  await title(page, expected);
  if(query.includes("code=1")) await page.getByLabel("Workflow source: peer-a Review navigation").waitFor();
  if(query.includes("activity=1")) await page.getByLabel("Run activity").waitFor();
  if(query.includes("entry=")) await page.getByText(/Full recorded detail 1/).waitFor();
  await page.reload(); await title(page, expected);
  const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,expected);});
 }
}), browserBudget);

test("Seed run disclosures use one history entry per click and keep their mounted owner", () => fresh(async page => {
 await page.goto(runHref());await title(page,runTitle());
 const code=page.getByRole("button",{name:"Code",exact:true});
 await code.evaluate(el=>(el as any).__fixtureOwner="same run");
 const before=await page.evaluate(()=>history.length);
 await code.click();await title(page,runTitle("Code · "));
 expect(await page.evaluate(()=>history.length)).toBe(before+1);
 await page.getByRole("button",{name:/^Activity/}).click();await title(page,runTitle("Code · Activity · "));
 await page.getByRole("button",{name:"info · Recorded activity 1",exact:true}).click();await title(page,runTitle("Code · 1 activity entry · "));
 await page.goBack();await title(page,runTitle("Code · Activity · "));
 await page.goBack();await title(page,runTitle("Code · "));
 expect(await code.evaluate(el=>(el as any).__fixtureOwner)).toBe("same run");
 await page.goBack();await title(page,runTitle());
 await page.goForward();await title(page,runTitle("Code · "));
 await page.goForward();await title(page,runTitle("Code · Activity · "));
 await page.goForward();await title(page,runTitle("Code · 1 activity entry · "));
 await page.getByRole("button",{name:/^Activity/}).click();await title(page,runTitle("Code · "));
 expect(new URLSearchParams(new URL(page.url()).hash.slice(7)).get("r")).toBe("run/activity?code=1");
}), browserBudget);

test("Seed run disclosure links canonicalize defaults, duplicate entries and invalid flags", () => fresh(async page => {
 await page.goto(runHref("activity=0&code=garbage&entry=activity%3A2&entry=activity%3A1&entry=activity%3A1&entry="));
 await title(page,runTitle("2 activity entries · "));
 expect(new URLSearchParams(new URL(page.url()).hash.slice(7)).get("r")).toBe("run/activity?activity=1&entry=activity%3A1&entry=activity%3A2");
 expect(await page.getByText(/Full recorded detail/).count()).toBe(2);
}), browserBudget);

test("Seed run missing source and pending activity keep honest titles and clean up on navigation", () => fresh(async page => {
 await page.goto(href("run/review?code=1"));await title(page,"Workflow source not found · Seed · Cyberdeck");
 await page.getByRole("alert").filter({hasText:"Workflow source is not available"}).waitFor();
 await page.goto(href("run/review?activity=1&entry=missing"));await title(page,runTitle("Waiting for activity · 1 activity entry · "));
 await page.getByText("Waiting for recorded activity…").waitFor();
 await page.goto(href("session/one"));await title(page,"local First conversation · Seed session · Cyberdeck");
}), browserBudget);

test("Seed run read failures outrank selected disclosures without replaying commands", () => fresh(async page => {
 for (const [id, label] of [["missing","Run not found"],["denied","Access denied"],["offline","Run unavailable"]]) {
  await page.goto(href(`run/${id}?code=1&activity=1`));await title(page,`${label} · Seed · Cyberdeck`);
 }
}), browserBudget);

test("Seed run disclosures ignore late previous-run reads and retain selected activity links", () => fresh(async page => {
 hold=true;await page.goto(href("run/slow?code=1"));
 await page.waitForFunction(()=>document.body.innerText.includes("Run"));
 await page.evaluate(url=>location.hash=new URL(url).hash,runHref("activity=1&entry=activity%3A2"));
 await title(page,runTitle("1 activity entry · "));
 const link=page.url();for(const release of pending)release();pending.clear();
 await page.waitForTimeout(150);expect(page.url()).toBe(link);expect(await page.title()).toBe(runTitle("1 activity entry · "));
 await page.getByText(/Full recorded detail 2/).waitFor();
}), browserBudget);

test("Seed activity entry selection is bounded and missing stream entries remain pending", () => fresh(async page => {
 const entries=Array.from({length:105},(_,index)=>`entry=missing-${String(index).padStart(3,"0")}`).join("&");
 await page.goto(runHref(entries));await title(page,runTitle("Waiting for activity · 100 activity entries · "));
 const path=new URLSearchParams(new URL(page.url()).hash.slice(7)).get("r")!;
 expect(new URLSearchParams(path.split("?")[1]).getAll("entry").length).toBe(100);
 expect(await page.getByRole("button",{name:"info · Recorded activity 1",exact:true}).isDisabled()).toBe(true);
 await page.getByRole("button",{name:/^Activity/}).click();await title(page,runTitle());
}), browserBudget);

test("Seed run late disclosures cannot rename a locked host or replay a run", () => fresh(async page => {
 hold=true;await page.goto(href("run/slow?code=1&activity=1"));
 while(!pending.size) await page.waitForTimeout(10);
 await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
 await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
 for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(await page.title()).toBe("Locked · Cyberdeck");
 expect(await page.getByText("Workflow source is not available for this run.").count()).toBe(0);
}), browserBudget);
