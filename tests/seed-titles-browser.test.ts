import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import * as cbor from "@seed-hypermedia/client/cbor";
import * as blobs from "@seed-hypermedia/client/blobs";

// Real published Seed UI + production Cyberdeck bundle. Synthetic signatures,
// metadata and transcripts only; no real agent is messaged or started.
const account = blobs.principalToString(blobs.nobleKeyPairFromSeed(new Uint8Array(32).fill(42)).principal);
const sharedOwner = blobs.principalToString(blobs.nobleKeyPairFromSeed(new Uint8Array(32).fill(43)).principal);
const browserBudget = process.env.CYBERDECK_TEST_ORIGIN ? 90000 : 30000;
const actions: string[] = [], errors: string[] = [], unexpected: string[] = [], signingNodes: string[] = [];
const pending = new Set<() => void>();
let hold = false;
let graphStatus = 200, holdGraph = false, malformedGraph = "";
let holdRunJournal = false, nestedRunTools = false;
let recordedStatus = 200, recordedMalformed = "", holdRecorded = false, durableOnly = false, recordedEmpty = false, recordedLive = false;
let runStreamMode = "", runStreamTarget = "";
let inlineListStatus = 200, inlineCardStatus = 200, holdInlineList = false, malformedInlineList = "", inlineSucceeded = false, malformedInlineCard = "";
let holdInlineJournal = false, inlineWorkflow = false, inlineGraphStatus = 200, inlineErrorFixture = false, holdInlineGraph = false, inlineLive = false;
let inlineWindowed = false, holdInlineCard = false, inlineComposerAvailable = false, inlineShared = false;
const archivedInlineId = "archived root /?&";
const inlineChildId = (root:string) => `${root}:child /?&`;
const inlineIds = ["inline-run /?&", "inline-second"];
const inlineRun = (id: string, node: string) => ({...run(id,node),account:inlineShared ? sharedOwner : account,sessionId:"inline",status:inlineLive && id===inlineIds[0] ? "running" : inlineSucceeded ? "succeeded" : "failed",finishedAt:inlineLive && id===inlineIds[0] ? undefined : 2,title:`Recorded ${id === inlineIds[0] ? "first" : "second"} run`,...(inlineErrorFixture ? {error:{code:"INLINE_ERROR",message:"Recorded inline root error",detail:{recorded:"Root error detail"},stack:"Error: recorded inline\n at workflow.js:2"},sourceText:"// Recorded inline source\nthrow new Error('recorded');"} : {}),plan:{steps:[{id:"inline-step",label:"Recorded inline step",status:inlineSucceeded ? "done" : "failed"}]}});
const runSockets = new Map<any, { node: string; key: string }>();
const subscriptions: string[] = [];
const errorChild = "failed child /?&";
let renamed = "";
let memoryRemoved = false;
let memoryReadStatus = 200, holdMemoryRead = false;
let sessionReadStatus = 200, runReadStatus = 200, listReadStatus = 200, holdListRead = false;
let payloadStatus = 200, holdPayload = false, malformedPayload = "";
let detailRunStatus = 200, holdDetailRun = false, malformedDetailRun = "";
let holdHandoffRead = false, handoffReadStatus = 200;
let holdTriggerRead = false, triggerReadStatus = 200;
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
const workflowId = "workflow /?&";
const workflowEvents = [
 { type: "message", role: "user", content: "Inspect a recorded workflow" },
 { type: "tool_call", id: workflowId, name: "run_workflow", input: { script: "export default async () => 42", brief: "Recorded workflow brief" } },
 { type: "tool_result", toolCallId: workflowId, name: "run_workflow", output: { runId: "detail-run", output: { recorded: 42 } } },
 { type: "message", role: "assistant", content: "Workflow completed" },
];
const projectionId = "projection /?&", continuationId = "continued /?&";
const projection = `<session_continuation>
<origin session="original" />
<predecessor session="previous" title="Recorded predecessor" edge="recorded-edge" />
<initiating_event seq="2" />
<projection reason="context_limit" />
<handoff>## Recorded incoming handoff
Keep the canonical navigation</handoff>
<sources>- memory facts.md — recorded source</sources>
<excerpt>Recorded source excerpt</excerpt>
</session_continuation>`;
const handoffEvents = [
 { type: "message", role: "user", actor: "system", content: projection },
 { type: "message", role: "user", content: "Continue the recorded fixture" },
 { type: "tool_call", id: continuationId, name: "continue_session", input: { title: "Recorded successor", reason: "context_limit", handoff: { purpose: "Recorded outgoing handoff", establishedFacts: ["Preserve the composer"] } } },
 { type: "tool_result", toolCallId: continuationId, name: "continue_session", output: { successorSessionId: "two", title: "Recorded successor" } },
 { type: "message", role: "assistant", content: "Recorded continuation complete" },
];
const transcriptEvents = (id: string) => id === "inline" ? [{id:"inline-message",sessionId:id,seq:1,createdAt:1,event:{type:"message",role:"user",content:"Inspect the recorded inline runs"}}] : id.startsWith("triggered") ? [{ id: "trigger-message", sessionId: id, seq: 1, createdAt: 1, event: { type: "message", role: "user", content: id === "triggered-no-instructions" ? "Recorded trigger session" : "Recorded trigger session\n<trigger_context>\n<trigger_instructions>\nRecorded instructions body\n</trigger_instructions>\n</trigger_context>" } }] : id === "handoffs" ? handoffEvents.map((event,index)=>({id:index?`handoff-event-${index+1}`:projectionId,sessionId:id,seq:index+1,createdAt:index+1,event})) : id === "workflow-details" ? workflowEvents.map((event, index) => ({id: `workflow-event-${index + 1}`, sessionId: id, seq: index + 1, createdAt: index + 1, event})) : id === "contexts" ? ["context-one", "context two/?&", "no-context"].map((eventId, index) => ({
 id: eventId, sessionId: id, seq: index + 1, createdAt: index + 1,
 event: { type: "message", role: "user", content: `Context fixture message ${index + 1}`, ...(index < 2 ? { contextLines: [`Recorded window ${index + 1}`, `Recorded project ${index + 1}`] } : {}) },
})) : id === "thinking" ? thinkingEvents.map((event, index) => ({ id: `thinking-event-${index + 1}`, sessionId: id, seq: index + 1, createdAt: index + 1, event })) : id === "tools" ? toolEvents.map((event, index) => ({
 id: `tool-event-${index + 1}`, sessionId: id, seq: index + 1, createdAt: index + 1, event,
 ...([1, 2].includes(index) ? { truncated: true } : {}),
})) : id === "transcript" ? ["message-one", "message two/?&"].map((eventId, index) => ({
 id: eventId, sessionId: id, seq: index + 1, createdAt: index + 1,
 event: { type: "message", role: index ? "assistant" : "user", content: `Fixture transcript message ${index + 1}` },
})) : [];
const completedEntries = (id:string) => {
 const rows:any[]=[];
 const append=(seq:number,entry:any)=>rows.push({runId:id,seq,createdAt:seq,entry});
 if(recordedEmpty)return rows;
 if(id==="failed-run")for(let index=1;index<=7;index++){
  append(index*2-1,{kind:"call",op:"tool",callSeq:index,tool:"read",input:{path:`Recorded run call ${index}`}});
  append(index*2,{kind:"result",callSeq:index,status:"succeeded",output:{content:`Recorded run result ${index}`}});
 }
 if(nestedRunTools && (id==="failed-run" || id===errorChild)){
  append(101,{kind:"call",op:"tool",callSeq:id===errorChild?9:99,tool:id===errorChild?"read":"run_workflow",input:id===errorChild?{path:"Recorded descendant input"}:{script:"export default async () => 42",brief:"Recorded nested workflow"}});
  append(102,{kind:"result",callSeq:id===errorChild?9:99,status:"succeeded",output:id===errorChild?{content:"Recorded descendant result"}:{runId:"detail-run",output:{recorded:42}}});
 }
 if(durableOnly && id==="failed-run"){
  append(1001,{kind:"call",op:"tool",callSeq:501,tool:"read",input:{path:"Old durable input outside the stream window"}});
  append(1002,{kind:"result",callSeq:501,status:"succeeded",output:{content:"Old durable result outside the stream window"}});
 }
 return rows;
};
const readActions = new Set(["ListAgents","GetAgent","GetSession","GetSessionEvent","GetRun","GetAgentTrigger","ListSessions","ListRuns","ListAgentTriggers","ListAgentMemoryDir","ReadAgentMemoryFile","ListAgentTools","ListAgentCollaborators","ListAgentInvites","ListModelProviders","ListProviderModels","ListMcpServers","ListSigningIdentities","GetRunJournal"]);
const ok = (value: unknown) => new Response(cbor.encode(value) as unknown as BodyInit,{headers:{"content-type":"application/cbor"}});
const fail = (status: number, message: string) => new Response(cbor.encode({_:"Error",message}) as unknown as BodyInit,{status,headers:{"content-type":"application/cbor"}});
const agent = (id: string, node: string) => ({id,account:inlineShared ? sharedOwner : account,...(inlineShared ? {accessRole:"writer"} : {}),definition:{name:renamed || `${node} ${id === "beta" ? "Beta assistant" : "Alpha assistant"}`,systemPrompt:"Fixture",model:"fixture",modelProvider:"fixture",mcpServers:[]},stateDir:"",status:"idle",createdAt:1,updatedAt:2});
const session = (id: string, node: string) => ({id,account:id==="inline" && inlineShared ? sharedOwner : account,agentId:"alpha",title:id === "untitled" ? "" : `${node} ${id === "two" ? "Second conversation" : id === "older" ? "Older conversation" : "First conversation"}`,status:"idle",createdAt:1,updatedAt:2,...(childLists && ["one", "two"].includes(id) ? { childSessionCount: id === "one" ? 2 : 1 } : {})});
const run = (id: string, node: string) => ({id,account,rootRunId:id,depth:0,kind:"workflow",origin:"user",title:`${node} Review navigation`,status:recordedLive && id === "failed-run" ? "running" : "succeeded",createdAt:1,updatedAt:2,finishedAt:2,...(id === "failed-run" ? { status: recordedLive ? "running" : "failed", error: { code: "FIXTURE_ERROR", message: "Recorded root failure", detail: { fixture: "root detail" }, stack: "Error: recorded failure\n at workflow.js:2" }, plan: { steps: [{ id: "child-step", label: "Recorded child step", status: "failed" }] }, sourceText: "// Recorded source\nthrow new Error('fixture');" } : {}),...(id === "activity" ? {sourceText:"// Recorded workflow fixture\nreturn 42;"} : {})});
const server = Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:60,async fetch(req,server) {
  const url=new URL(req.url),path=url.pathname;
  if (path.endsWith("/agents/ws") && server.upgrade(req, { data: { node: path.split("/")[2] } })) return;
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
        [field]: inlineComposerAvailable && action._ === "ListModelProviders" ? [{id:"fixture",name:"fixture",type:"openai"}] : malformed === "list" ? {} : malformed === "entry" ? [null] : populatedServerDialog
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
    if (action._ === "GetSession" && id.startsWith("triggered")) {
      const status=triggerReadStatus;
      if(holdTriggerRead)await new Promise<void>(resolve=>pending.add(resolve));
      if(status!==200)return fail(status,"Recorded trigger transcript read failed");
    }
    if (action._ === "GetSession" && id === "handoffs") {
      const status = handoffReadStatus;
      if (holdHandoffRead) await new Promise<void>(r=>pending.add(r));
      if (status !== 200) return fail(status,"Recorded handoff read failed");
    }
    if (action._ === "GetSession" && ["transcript","inline"].includes(id) && !action.limit && sessionReadStatus !== 200) return fail(sessionReadStatus, "Transcript read failed");
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
    if (action._ === "ListRuns" && action.sessionId === "inline") {
      const status=inlineListStatus, malformed=malformedInlineList;
      if(holdInlineList) await new Promise<void>(resolve=>pending.add(resolve));
      if(status!==200)return fail(status,"Recorded inline run list failed");
      if(inlineWindowed)return ok({_:"ListRunsResponse",runs:[inlineRun(inlineIds[1],node),...Array.from({length:49},(_,index)=>({...run(`recent-${index}`,node),account:inlineShared ? sharedOwner : account,sessionId:"inline",kind:"agent",createdAt:100+index,updatedAt:200+index}))]});
      return ok(malformed === "response" ? {_:"GetRunResponse"} : {_:"ListRunsResponse",runs:malformed === "list" ? {} : malformed === "owner" ? [{...inlineRun(inlineIds[0],node),sessionId:"other"}] : malformed === "plan" ? [{...inlineRun(inlineIds[0],node),plan:{steps:{}}}] : inlineIds.map(id=>inlineRun(id,node))});
    }
    if(action._ === "GetRun" && [...inlineIds,archivedInlineId].includes(id)) {
      const status=inlineCardStatus, malformed=malformedInlineCard;
      if(holdInlineCard)await new Promise<void>(resolve=>pending.add(resolve));
      if(status!==200)return fail(status,"Recorded inline run read failed");
      const value=inlineRun(id,node);
      return ok({_:"GetRunResponse",run:malformed === "missing" ? null : malformed === "owner" ? {...value,sessionId:"other"} : malformed === "id" ? inlineRun("other-run",node) : malformed === "root" ? {...value,rootRunId:"other-root"} : malformed === "parent" ? {...value,parentRunId:"parent"} : malformed === "depth" ? {...value,depth:1} : malformed === "plan" ? {...value,plan:{steps:{}}} : malformed === "account" ? {...value,account:"different-account"} : malformed === "time" ? {...value,updatedAt:"later"} : value});
    }
    if (action._ === "ListRuns" && [...inlineIds,archivedInlineId].includes(action.rootRunId)) {
      const status=inlineGraphStatus;
      if(holdInlineGraph)await new Promise<void>(resolve=>pending.add(resolve));
      if(status !== 200)return fail(status,"Recorded inline graph failed");
      return ok({_:"ListRunsResponse",runs:inlineErrorFixture ? [{...run(inlineChildId(action.rootRunId),node),rootRunId:action.rootRunId,parentRunId:action.rootRunId,depth:1,sessionId:"inline",planStepId:"inline-step",status:"failed",title:"Recorded inline child",error:{code:"INLINE_CHILD_ERROR",message:"Recorded inline child error",detail:{recorded:"Child error detail"}}}] : []});
    }
    if (action._ === "ListRuns" && action.rootRunId === "failed-run") {
      const status = graphStatus, malformed = malformedGraph;
      if (holdGraph) await new Promise<void>(r => pending.add(r));
      if (status !== 200) return fail(status, "Recorded run graph failed");
      if (malformed === "response") return ok({ _: "GetRunResponse" });
      if (malformed === "array") return ok({ _: "ListRunsResponse", runs: {} });
      if (malformed === "root") return ok({ _: "ListRunsResponse", runs: [{ ...run(errorChild, node), rootRunId: "other-run" }] });
      return ok({ _: "ListRunsResponse", runs: [{ ...run(errorChild, node), rootRunId: "failed-run", parentRunId: "failed-run", depth: 1, planStepId: "child-step", title: `${node} Failed child`, status: "failed", error: { code: "CHILD_ERROR", message: "Recorded child failure", detail: { fixture: "child detail" } } }] });
    }
    if (action._ === "GetRun" && id === "detail-run") {
      const status = detailRunStatus, malformed = malformedDetailRun;
      if (holdDetailRun) await new Promise<void>(r => pending.add(r));
      if (status !== 200) return fail(status, "Recorded workflow read failed");
      if (malformed === "response") return ok({ _: "GetSessionResponse" });
      if (malformed === "missing") return ok({ _: "GetRunResponse", run: null });
      if (malformed === "identity") return ok({ _: "GetRunResponse", run: run("wrong-run", node) });
      if (malformed === "plan") return ok({ _: "GetRunResponse", run: { ...run(id, node), plan: { steps: {} } } });
      return ok({ _: "GetRunResponse", run: { ...run(id, node), plan: { steps: [{ id: "recorded-step", label: "Recorded plan step", status: "done" }] } } });
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
    if(id === "missing" || action._ === "GetRun" && (id === "absent" || id.startsWith("missing-")))return fail(404,"Entity not found");
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
      case "GetSession":return ok({_:"GetSessionResponse",session:session(id,node),events:transcriptEvents(id),systemPromptMarkdown:"Fixture system prompt — read only", ...(id.startsWith("triggered") ? { triggerContext: {triggerId:"fixture-trigger",triggerName:"Recorded schedule",firingId:"firing /?&",source:{type:"schedule",schedule:{kind:"weekly",daysOfWeek:[1],timeOfDay:"09:00",timezone:"UTC"}},activityKey:"recorded:activity",activitySummary:"Recorded schedule tick",activity:{kind:"fixture",value:"Recorded activity payload"},firedAt:1,status:"fired",...(id!=="triggered-no-prompt" ? {prompt:"Recorded prompt body"} : {})} } : {})});
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
      case "ListModelProviders":return ok({_:"ListModelProvidersResponse",providers:inlineComposerAvailable ? [{id:"fixture",name:"fixture",type:"openai"}] : []});
      case "ListMcpServers":return ok({_:"ListMcpServersResponse",servers:[]});
      case "ListSigningIdentities":return ok({_:"ListSigningIdentitiesResponse",identities:[]});
      case "GetRunJournal": {
       const status=recordedStatus, malformed=recordedMalformed, entries=completedEntries(action.runId);
       if(holdRecorded || holdRunJournal)await new Promise<void>(resolve=>pending.add(resolve));
       if(status!==200)return fail(status,"Recorded journal read failed");
       const response:any={_:"GetRunJournalResponse",runId:action.runId,entries};
       if(malformed==="response")response._="GetRunResponse";
       if(malformed==="identity")response.runId="another-run";
       if(malformed==="array")response.entries={};
       if(malformed==="entry")response.entries=[{runId:action.runId,seq:1,createdAt:1,entry:{kind:"call",op:"tool",tool:42}}];
       if(malformed==="description")response.entries=[{runId:action.runId,seq:1,createdAt:1,entry:{kind:"call",op:"tool",tool:"read",description:{bad:"description"}}}];
       if(malformed==="result")response.entries=[{runId:action.runId,seq:1,createdAt:1,entry:{kind:"result",callSeq:1,status:"failed",error:{message:{bad:"message"}}}}];
       if(malformed==="row-owner")response.entries=[{runId:"another-run",seq:1,createdAt:1,entry:{kind:"log"}}];
       if(malformed==="duplicate")response.entries=[{runId:action.runId,seq:1,createdAt:1,entry:{kind:"log"}},{runId:action.runId,seq:1,createdAt:2,entry:{kind:"log"}}];
       return ok(response);
      }
    }
  }
  if(path.startsWith("/api/")) {
    if(path.endsWith("/sign") && path.startsWith("/api/seed-agents")) { signingNodes.push(path.includes("/nodes/") ? path.split("/")[4] : "local"); return Response.json({sig:Buffer.alloc(64).toString("base64")}); }
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
},websocket:{open(){},async message(ws, message){
 const envelope:any = typeof message === "string" ? JSON.parse(message) : cbor.decode(new Uint8Array(message));
 if (/^(runs|sessions)\//.test(envelope.action?.key || "")) subscriptions.push(envelope.action.key);
 if (envelope.action?.key?.startsWith("runs/")) {
  runSockets.set(ws, {node:(ws.data as any).node,key:envelope.action.key});
  const mode = !runStreamTarget || runStreamTarget === envelope.action.key ? runStreamMode : "";
  if (mode === "error") { ws.send(JSON.stringify({_:"error",message:"Fixture run subscription rejected"})); return; }
  if (mode === "close") { ws.close(1011,"Fixture interrupted"); return; }
  if (mode === "malformed") { ws.send("{"); return; }
  if (mode === "silent") return;
 }
 ws.send(JSON.stringify({_:"subscribed",key:envelope.action.key,accountId:account}));
 if((durableOnly || recordedEmpty) && envelope.action?.key === "runs/failed-run")return;
 if([...inlineIds,archivedInlineId].some(id=>envelope.action?.key === `runs/${id}`)) {
  const id=envelope.action.key.slice(5);
  if(holdInlineJournal) await new Promise<void>(resolve=>pending.add(resolve));
  if(inlineErrorFixture){
   ws.send(JSON.stringify({_:"append",key:envelope.action.key,runId:inlineChildId(id),seq:1,createdAt:20,entry:{kind:"call",op:"tool",callSeq:1,tool:"read",input:{path:"Recorded descendant input"}}}));
   ws.send(JSON.stringify({_:"append",key:envelope.action.key,runId:inlineChildId(id),seq:2,createdAt:21,entry:{kind:"result",callSeq:1,status:"succeeded",output:{content:"Recorded descendant result"}}}));
  }
  for(let callSeq=1;callSeq<=7;callSeq++) {
   ws.send(JSON.stringify({_:"append",key:envelope.action.key,runId:id,seq:callSeq*2-1,createdAt:callSeq*2-1,entry:{kind:"call",op:"tool",callSeq,tool:inlineWorkflow && callSeq===2 ? "run_workflow" : "read",input:inlineWorkflow && callSeq===2 ? {script:"return 42",brief:"Recorded inline workflow"} : {path:`Recorded inline call ${callSeq}`}}}));
   ws.send(JSON.stringify({_:"append",key:envelope.action.key,runId:id,seq:callSeq*2,createdAt:callSeq*2,entry:{kind:"result",callSeq,status:"succeeded",output:inlineWorkflow && callSeq===2 ? {runId:"detail-run",output:{recorded:42}} : {content:`Recorded inline result ${callSeq}`}}}));
  }
 }
 if(holdRunJournal && envelope.action?.key === "runs/failed-run") await new Promise<void>(resolve=>pending.add(resolve));
 if(envelope.action?.key === "runs/failed-run") for (let index=1;index<=7;index++) {
  ws.send(JSON.stringify({_:"append",key:"runs/failed-run",runId:"failed-run",seq:index*2-1,createdAt:index*2-1,entry:{kind:"call",op:"tool",callSeq:index,tool:"read",input:{path:`Recorded run call ${index}`}}}));
  ws.send(JSON.stringify({_:"append",key:"runs/failed-run",runId:"failed-run",seq:index*2,createdAt:index*2,entry:{kind:"result",callSeq:index,status:"succeeded",output:{content:`Recorded run result ${index}`}}}));
 }
 if(nestedRunTools && envelope.action?.key === "runs/failed-run") {
  for(const [runId,callSeq,tool,input,output] of [[errorChild,9,"read",{path:"Recorded descendant input"},{content:"Recorded descendant result"}],["failed-run",99,"run_workflow",{script:"export default async () => 42",brief:"Recorded nested workflow"},{runId:"detail-run",output:{recorded:42}}]] as const){
   ws.send(JSON.stringify({_:"append",key:"runs/failed-run",runId,seq:101,createdAt:101,entry:{kind:"call",op:"tool",callSeq,tool,input}}));
   ws.send(JSON.stringify({_:"append",key:"runs/failed-run",runId,seq:102,createdAt:102,entry:{kind:"result",callSeq,status:"succeeded",output}}));
  }
 }
 if(envelope.action?.key === "runs/activity") for (let seq=1;seq<=2;seq++) ws.send(JSON.stringify({_:"append",key:"runs/activity",runId:"activity",seq,createdAt:seq,entry:{kind:"log",level:"info",message:`Recorded activity ${seq}`,detail:`Full recorded detail ${seq}`}}));
},close(ws){runSockets.delete(ws);}}});
let browser:Browser;
beforeAll(async()=>{browser=await chromium.launch();});
afterAll(async()=>{for(const release of pending)release();await browser.close();server.stop(true);expect(unexpected).toEqual([]);expect(errors).toEqual([]);});
async function fresh(fn:(page:Page)=>Promise<void>){
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));
 page.setDefaultNavigationTimeout(process.env.CYBERDECK_TEST_ORIGIN ? 30000 : 12000);
 await page.route("**/*",route=>new URL(route.request().url()).origin===server.url.origin?route.continue():route.abort());
 try{await fn(page);}catch(e){console.error(JSON.stringify({title:await page.title(),body:(await page.locator("body").innerText()).slice(0,1800),errors,actions:actions.slice(-15)}));throw e;}
 finally{recordedStatus=200;recordedMalformed="";holdRecorded=false;durableOnly=false;recordedEmpty=false;recordedLive=false;runStreamTarget="";inlineShared=false;inlineComposerAvailable=false;inlineWindowed=false;holdInlineCard=false;inlineLive=false;inlineErrorFixture=false;holdInlineGraph=false;inlineGraphStatus=200;holdInlineJournal=false;inlineWorkflow=false;malformedInlineCard="";inlineListStatus=200;inlineCardStatus=200;holdInlineList=false;malformedInlineList="";inlineSucceeded=false;runStreamMode="";holdTriggerRead=false;triggerReadStatus=200;nestedRunTools=false;holdRunJournal=false;holdHandoffRead=false;handoffReadStatus=200;detailRunStatus=200;holdDetailRun=false;malformedDetailRun="";graphStatus=200;holdGraph=false;malformedGraph="";serverDialogStatus=200;holdServerDialog=false;malformedServerDialog="";populatedServerDialog=false;emptySeedLists=false;childEmpty=false;childLists=false;childReadStatus=200;holdChildRead=false;malformedChild=false;globalPaged=false;globalListStatus=200;globalFailCursor="";holdGlobalList=false;malformedList="";hold=false;renamed="";memoryRemoved=false;memoryReadStatus=200;holdMemoryRead=false;sessionReadStatus=200;runReadStatus=200;listReadStatus=200;holdListRead=false;payloadStatus=200;holdPayload=false;malformedPayload="";for(const release of pending)release();pending.clear();await page.close();}
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

const selectionHref = (query = "", node = "") => href(`run/failed-run${query ? `?${query}` : ""}`, node);
const selectionTitle = (prefix = "", node = "") => runTitle(prefix, node);
const errorTitle = (child = false, node = "") => `Error · ${node || "local"} ${child ? "Failed child" : "Review navigation"} · Seed run${node ? " · Peer A" : ""} · Cyberdeck`;
const selectedPath = (url: string) => new URLSearchParams(new URL(url).hash.slice(7)).get("r");

test("Seed run selection direct links restore tool calls and root/child errors on reload and fresh tabs", () => fresh(async page => {
 for (const query of ["calls=open", "calls=closed", "error=failed-run", `error=${encodeURIComponent(errorChild)}`]) {
  const child = query.includes(encodeURIComponent(errorChild));
  const expected = query.startsWith("error=") ? errorTitle(child, "peer-a") : selectionTitle(`Tool calls ${query === "calls=open" ? "open" : "collapsed"} · `, "peer-a");
  await page.goto(selectionHref(query,"peer-a"));await title(page,expected);
  if(query.startsWith("error=")) await page.getByRole("dialog").getByText(child ? "Recorded child failure" : "Recorded root failure",{exact:true}).waitFor();
  else expect(await page.getByRole("button",{name:/^Tool calls/}).getAttribute("aria-expanded")).toBe(query === "calls=open" ? "true" : "false");
  await page.reload();await title(page,expected);
  const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,expected);});
 }
}), browserBudget);

test("Seed run selection history preserves the displayed graph and journal subscription without repeated reads", () => fresh(async page => {
 await page.goto(selectionHref());await title(page,selectionTitle());
 const calls=page.getByRole("button",{name:/^Tool calls/});await calls.waitFor();
 expect(await calls.getAttribute("aria-expanded")).toBe("false");
 await calls.evaluate(el=>(el as any).__fixtureOwner="same graph");
 const before=await page.evaluate(()=>history.length), readsBefore=reads.filter(row=>["GetRun","ListRuns"].includes(row.action._)).length;
 const subscriptionsBefore=subscriptions.length;
 await calls.click();await title(page,selectionTitle("Tool calls open · "));
 expect(await page.evaluate(()=>history.length)).toBe(before+1);
 await page.getByRole("button",{name:"Recorded root failure",exact:true}).click();await title(page,errorTitle());
 expect(await page.evaluate(()=>history.length)).toBe(before+2);
 await page.keyboard.press("Escape");await title(page,selectionTitle("Tool calls open · "));
 expect(await page.evaluate(()=>history.length)).toBe(before+3);
 await page.goBack();await title(page,errorTitle());await page.getByRole("dialog").waitFor();
 await page.goBack();await title(page,selectionTitle("Tool calls open · "));
 await page.goBack();await title(page,selectionTitle());
 await page.goForward();await title(page,selectionTitle("Tool calls open · "));
 expect(await calls.evaluate(el=>(el as any).__fixtureOwner)).toBe("same graph");
 expect(reads.filter(row=>["GetRun","ListRuns"].includes(row.action._)).length).toBe(readsBefore);
 expect(subscriptions.length).toBe(subscriptionsBefore);
}), browserBudget);

test("Seed run selection canonicalizes invalid and duplicate parameters without extra history", () => fresh(async page => {
 await page.goto(selectionHref("calls=invalid&error=&error=failed-run"));await title(page,selectionTitle());
 expect(selectedPath(page.url())).toBe("run/failed-run");
 await page.goto(selectionHref(`calls=closed&calls=open&error=${encodeURIComponent("x".repeat(513))}`));
 await title(page,selectionTitle("Tool calls collapsed · "));
 expect(selectedPath(page.url())).toBe("run/failed-run?calls=closed");
 await page.goto(selectionHref("error=gone"));await title(page,"Run error not found · Seed · Cyberdeck");
 await page.getByRole("alert").getByText("The selected run error is not available in this run.").waitFor();
 expect(selectedPath(page.url())).toBe("run/failed-run?error=gone");
 expect(await page.getByRole("dialog").count()).toBe(0);
}), browserBudget);

test("Seed run selection keeps pending tools honest and primary read failures own selected error titles", () => fresh(async page => {
 await page.goto(href("run/review?calls=open"));await title(page,runTitle("Waiting for tool calls · Tool calls open · "));
 await page.getByText("Waiting for recorded tool calls…").waitFor();
 await page.getByRole("button",{name:/^Tool calls/}).click();await title(page,runTitle("Tool calls collapsed · "));
 for(const [id,label] of [["missing","Run not found"],["denied","Access denied"],["offline","Run unavailable"]]) {
  await page.goto(href(`run/${id}?calls=open&error=failed-run`));await title(page,`${label} · Seed · Cyberdeck`);
 }
}), browserBudget);

test("Seed run selection child graph failures retry at the same URL and retain selected content", () => fresh(async page => {
 for(const [status,label] of [[403,"Access denied"],[404,"Run error not found"],[503,"Run error unavailable"]] as const) {
  await page.goto("about:blank");
  graphStatus=status;await page.goto(selectionHref(`error=${encodeURIComponent(errorChild)}`,"peer-a"));
  await title(page,`${label} · Seed · Peer A · Cyberdeck`);
  const link=page.url();graphStatus=200;
  await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,errorTitle(true,"peer-a"));
  expect(page.url()).toBe(link);await page.getByRole("dialog").getByText("Recorded child failure",{exact:true}).waitFor();
 }
}), browserBudget);

test("Seed run selection delayed children cannot reopen a closed error or change the next node", () => fresh(async page => {
 holdGraph=true;await page.goto(selectionHref(`error=${encodeURIComponent(errorChild)}`));
 await title(page,`Loading error · ${errorChild} · Seed run · Cyberdeck`);
 await page.evaluate(url=>location.hash=new URL(url).hash,selectionHref("calls=closed","peer-a"));
 await title(page,selectionTitle("Tool calls collapsed · ","peer-a"));
 const link=page.url();holdGraph=false;for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(page.url()).toBe(link);expect(await page.title()).toBe(selectionTitle("Tool calls collapsed · ","peer-a"));
 expect(await page.getByRole("dialog").count()).toBe(0);
}), browserBudget);

test("Seed run selection late error reads cannot cross the authentication gate", () => fresh(async page => {
 holdGraph=true;await page.goto(selectionHref(`error=${encodeURIComponent(errorChild)}`));
 while(!pending.size)await page.waitForTimeout(10);
 await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
 await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
 holdGraph=false;for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(await page.title()).toBe("Locked · Cyberdeck");expect(await page.getByRole("dialog").count()).toBe(0);
}), browserBudget);

test("Seed run selection error popovers fit phone and desktop in both color schemes", () => fresh(async page => {
 for(const width of [390,1280])for(const colorScheme of ["light","dark"] as const){
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});
  await page.goto(selectionHref("error=failed-run"));await title(page,errorTitle());
  const dialog=page.getByRole("dialog");await dialog.waitFor();
  const bounds=await dialog.boundingBox();expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
  await page.waitForTimeout(180);
  if(process.env.CYBERDECK_NAV_SHOTS)await page.screenshot({path:join(process.env.CYBERDECK_NAV_SHOTS,`run-error-${width}-${colorScheme}.png`)});
 }
}), browserBudget);

test("Seed run selection malformed run graphs remain unavailable and retry without showing another graph", () => fresh(async page => {
 for(const malformed of ["response","array","root"]){
  await page.goto("about:blank");malformedGraph=malformed;
  await page.goto(selectionHref(`error=${encodeURIComponent(errorChild)}`));
  await title(page,"Run error unavailable · Seed · Cyberdeck");
  expect(await page.getByRole("dialog").count()).toBe(0);
  const link=page.url();malformedGraph="";
  await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,errorTitle(true));
  expect(page.url()).toBe(link);
 }
}), browserBudget);

test("Seed run selection late children cannot reopen an error closed on the same mounted run", () => fresh(async page => {
 holdGraph=true;await page.goto(selectionHref(`error=${encodeURIComponent(errorChild)}`));
 await title(page,`Loading error · ${errorChild} · Seed run · Cyberdeck`);
 const calls=page.getByRole("button",{name:/^Tool calls/});await calls.waitFor();
 await calls.evaluate(el=>(el as any).__fixtureOwner="same pending graph");
 await page.evaluate(url=>location.hash=new URL(url).hash,selectionHref("calls=closed"));
 await title(page,selectionTitle("Tool calls collapsed · "));
 holdGraph=false;for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(await page.title()).toBe(selectionTitle("Tool calls collapsed · "));
 expect(await page.getByRole("dialog").count()).toBe(0);
 expect(await calls.evaluate(el=>(el as any).__fixtureOwner)).toBe("same pending graph");
}), browserBudget);

const detailHref = (view: string, id: string, ids: string[], node = "") => {
 const query = new URLSearchParams(); for (const value of ids) query.append("detail", value);
 return view === "Seed" ? href(`session/${id}${query.size ? `?${query}` : ""}`, node)
  : `${server.url}#/term?${new URLSearchParams({ session: `seed-${id}`, ...(node ? { node } : {}) })}${query.size ? `&${query}` : ""}`;
};
const detailTitle = (count = 1, node = "local") => `${count ? `${count} tool detail${count === 1 ? "" : "s"} · ` : ""}${node} First conversation · Seed session${node === "local" ? "" : " · Peer B"} · Cyberdeck`;
for (const view of ["Seed", "Sessions"]) {
 test(`${view} recorded tool details restore direct links, reload, fresh tabs and parent groups`, () => fresh(async page => {
  await page.goto(detailHref(view, "thinking", thinkingIds, "peer-b"));
  await title(page, detailTitle(2, "peer-b"));
  expect(await page.locator("[data-tool-detail]").count()).toBe(2);
  expect(await page.locator('[data-thinking-group] button[title="Hide tool calls"]').count()).toBe(2);
  await page.reload(); await title(page, detailTitle(2, "peer-b"));
  const link = page.url(); await fresh(async tab => { await tab.goto(link); await title(tab, detailTitle(2, "peer-b")); expect(await tab.locator("[data-tool-detail]").count()).toBe(2); });
 }), browserBudget);

 test(`${view} recorded tool details push once and keep the transcript and composer through history`, () => fresh(async page => {
  await page.goto(detailHref(view, "thinking", []));
  await page.locator('[data-thinking-group]').first().locator('button[title="Show all tool calls"]').click();
  await page.getByPlaceholder("Untitled session").evaluate(el => el.setAttribute("data-details-owner", "same owner"));
  const before = await page.evaluate(() => history.length), start = reads.length, streams = subscriptions.length;
  await page.getByRole("button", { name: "Show tool details", exact: true }).first().click();
  await page.waitForFunction(() => document.title.startsWith("1 tool detail"));
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack(); expect(await page.locator("[data-tool-detail]").count()).toBe(0);
  await page.goForward(); await page.locator("[data-tool-detail]").waitFor();
  expect(await page.getByPlaceholder("Untitled session").getAttribute("data-details-owner")).toBe("same owner");
  await page.locator('[data-thinking-group]').first().locator('button[title="Hide tool calls"]').click();
  await title(page, detailTitle(0)); expect(await page.locator("[data-tool-detail]").count()).toBe(0);
  await page.goBack(); await page.locator("[data-tool-detail]").waitFor();
  expect(reads.slice(start).filter(({action}) => action._ === "GetSession").length).toBe(0);
  expect(subscriptions.length).toBe(streams);
 }), browserBudget);

 test(`${view} recorded tool detail links canonicalize duplicates and bound selections without hiding missing content`, () => fresh(async page => {
  await page.goto(detailHref(view, "thinking", [thinkingIds[0], thinkingIds[0], "", "bad\u0001"]));
  await title(page, detailTitle()); expect(await page.locator("[data-tool-detail]").count()).toBe(1);
  const query = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
  const params = view === "Seed" ? new URLSearchParams(query.get("r")!.split("?")[1]) : query;
  expect(params.getAll("detail")).toEqual([thinkingIds[0]]);
  await page.goto(detailHref(view, "thinking", ["missing"])); await title(page, "Tool details not found · Seed · Cyberdeck");
  await page.getByRole("alert").filter({ hasText: "Selected tool details are not in this transcript." }).waitFor();
  await page.reload(); await title(page, "Tool details not found · Seed · Cyberdeck");
  await page.goto(detailHref(view, "thinking", Array.from({ length: 105 }, (_, i) => `missing-${i}`)));
  await title(page, "Tool details not found · Seed · Cyberdeck");
  await page.locator('button[title="Show all tool calls"]').first().click();
  expect(await page.getByRole("button", { name: "Show tool details", exact: true }).first().isDisabled()).toBe(true);
 }), browserBudget);

 test(`${view} recorded workflow details restore the plan and read failures retry at the same URL`, () => fresh(async page => {
  for (const [status, expected] of [[403, "Access denied"], [404, "Workflow run not found"], [503, "Workflow run unavailable"]] as const) {
   detailRunStatus = status;
   await page.goto("about:blank");
   await page.goto(detailHref(view, "workflow-details", [workflowId], "peer-b"));
   await title(page, `${expected} · Seed · Peer B · Cyberdeck`);
   if (status === 503) { await page.getByRole("alert").filter({hasText:"Couldn’t load this run"}).waitFor(); expect(await page.getByText("Couldn’t load this session",{exact:true}).count()).toBe(0); }
   const link = page.url(), before = await page.evaluate(() => history.length);
   detailRunStatus = 200;
   await page.getByRole("button", { name: "Retry", exact: true }).click();
   await title(page, detailTitle(1, "peer-b")); await page.getByText("Recorded plan step", { exact: true }).waitFor();
   expect(page.url()).toBe(link); expect(await page.evaluate(() => history.length)).toBe(before);
   await page.reload(); await title(page, detailTitle(1, "peer-b")); await page.getByText("Recorded plan step", { exact: true }).waitFor();
  }
 }), browserBudget);
}

test("Seed recorded workflow late reads cannot reopen closed details, change owners or cross lock", () => fresh(async page => {
 holdDetailRun = true; detailRunStatus = 503;
 await page.goto(detailHref("Seed", "workflow-details", [workflowId]));
 while (!pending.size) await page.waitForTimeout(10);
 await title(page, "Loading workflow run · Seed · Cyberdeck");
 await page.getByRole("button", { name: "Hide tool details", exact: true }).click(); await title(page, detailTitle(0));
 for (const release of pending) release(); pending.clear(); await page.waitForTimeout(100); expect(await page.title()).toBe(detailTitle(0));
 await page.evaluate(url => location.hash = new URL(url).hash, detailHref("Seed", "thinking", [thinkingIds[0]], "peer-b"));
 await title(page, detailTitle(1, "peer-b"));
 await page.route("**/api/fs/list**", route => route.fulfill({status: 401, json: {error: "Locked"}}));
 await page.getByTestId("nav-files").click(); await title(page, "Locked · Cyberdeck");
 expect(await page.locator("[data-tool-detail]").count()).toBe(0);
}), browserBudget);

for (const view of ["Seed", "Sessions"]) test(`${view} recorded workflow invalid reads preserve selection and recover without history`, () => fresh(async page => {
 for (const malformed of ["response", "missing", "identity", "plan"]) {
  malformedDetailRun = malformed;
  await page.goto("about:blank"); await page.goto(detailHref(view, "workflow-details", [workflowId]));
  await title(page, `Workflow run ${malformed === "missing" ? "not found" : "unavailable"} · Seed · Cyberdeck`);
  expect(await page.locator("[data-tool-detail]").count()).toBe(1);
  const link = page.url(), before = await page.evaluate(() => history.length);
  malformedDetailRun = ""; await page.getByRole("button", { name: "Retry", exact: true }).click();
  await title(page, detailTitle()); await page.getByText("Recorded plan step", { exact: true }).waitFor();
  expect(page.url()).toBe(link); expect(await page.evaluate(() => history.length)).toBe(before);
 }
}), browserBudget);

for (const view of ["Seed", "Sessions"]) test(`${view} recorded workflow late failures cannot replace another node or locked screen`, () => fresh(async page => {
 holdDetailRun = true; detailRunStatus = 403;
 await page.goto(detailHref(view, "workflow-details", [workflowId]));
 while (!pending.size) await page.waitForTimeout(10);
 await title(page, "Loading workflow run · Seed · Cyberdeck");
 await page.evaluate(link => location.hash = new URL(link).hash, detailHref(view, "thinking", [thinkingIds[0]], "peer-b"));
 await title(page, detailTitle(1, "peer-b"));
 for (const release of pending) release(); pending.clear(); await page.waitForTimeout(100);
 expect(await page.title()).toBe(detailTitle(1, "peer-b"));
 // Start another outstanding read on the other owner, then authenticate away.
 await page.evaluate(link => location.hash = new URL(link).hash, detailHref(view, "workflow-details", [workflowId], "peer-b"));
 while (!pending.size) await page.waitForTimeout(10);
 await title(page, "Loading workflow run · Seed · Peer B · Cyberdeck");
 await page.route("**/api/fs/list**", route => route.fulfill({status:401,json:{error:"Locked"}}));
 await page.getByTestId("nav-files").click(); await title(page,"Locked · Cyberdeck");
 for (const release of pending) release(); pending.clear(); await page.waitForTimeout(100);
 expect(await page.title()).toBe("Locked · Cyberdeck");
 expect(await page.locator("[data-tool-detail]").count()).toBe(0);
}), browserBudget);

for (const view of ["Seed", "Sessions"]) test(`${view} recorded tool detail message shares preserve canonical details and node`, () => fresh(async page => {
 await page.goto(detailHref(view,"thinking",[thinkingIds[0]],"peer-b"));
 await title(page,detailTitle(1,"peer-b"));
 await page.getByRole("button",{name:"Show markdown sent to the LLM"}).first().click();
 const dialog=page.getByRole("dialog").filter({hasText:"Message details"}); await dialog.waitFor();
 const shared=new URL(await dialog.locator("code").innerText()),query=new URLSearchParams(shared.hash.split("?")[1]);
 expect(query.get("node")).toBe("peer-b");
 const nested=view==="Seed"?new URLSearchParams(query.get("r")!.split("?")[1]):query;
 expect(nested.getAll("detail")).toEqual([thinkingIds[0]]);
 expect(nested.has("panel")).toBe(false);
 await fresh(async tab=>{await tab.goto(shared.href);await tab.locator("[data-tool-detail]").waitFor();expect(await tab.title()).toContain("peer-b First conversation");});
}),browserBudget);

const handoffHref = (view:string,tokens:string[]=[],node="",panel="",event="")=>{
 const query = new URLSearchParams();for(const token of tokens)query.append("handoff",token);
 if(panel)query.set("panel",panel);if(event)query.set("event",event);
 return view==="Seed"?href(`session/handoffs${query.size?`?${query}`:""}`,node)
  :`${server.url}#/term?${new URLSearchParams({session:"seed-handoffs",filter:"peer-b",...(node?{node}:{})})}${query.size?`&${query}`:""}`;
};
const handoffTitle=(count=0,node="local",panel=false)=>`${panel?"Handoff projection · ":""}${count?`${count} expanded handoff${count===1?"":"s"} · `:""}${node} First conversation · Seed session${node==="local"?"":" · Peer B"} · Cyberdeck`;
const handoffTokens=[`p:${projectionId}`,`t:${continuationId}`];
for(const view of ["Seed","Sessions"]){
 test(`${view} handoff summaries restore direct links, reload, new tabs and selected node`,()=>fresh(async page=>{
  await page.goto(handoffHref(view,handoffTokens,"peer-b"));await title(page,handoffTitle(2,"peer-b"));
  await page.getByText("Recorded incoming handoff",{exact:true}).waitFor();await page.getByText("Recorded outgoing handoff",{exact:true}).waitFor();
  const link=page.url();await page.reload();await title(page,handoffTitle(2,"peer-b"));
  await fresh(async tab=>{await tab.goto(link);await title(tab,handoffTitle(2,"peer-b"));await tab.getByText("Recorded outgoing handoff",{exact:true}).waitFor();});
  expect(reads.filter(({action})=>action._==="CreateSession"||action._==="MessageSession").length).toBe(0);
 }),browserBudget);
 test(`${view} handoff summary history retains the transcript, composer and subscriptions`,()=>fresh(async page=>{
  await page.goto(handoffHref(view));await title(page,handoffTitle());
  await page.getByPlaceholder("Untitled session").evaluate(el=>el.setAttribute("data-handoff-owner","retained"));
  const before=await page.evaluate(()=>history.length),start=reads.length,streams=subscriptions.length;
  await page.locator('[data-handoff-token]').first().locator('button[title="Show handoff"]').click();await title(page,handoffTitle(1));
  expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.goBack();await title(page,handoffTitle());await page.goForward();await title(page,handoffTitle(1));
  expect(await page.getByPlaceholder("Untitled session").getAttribute("data-handoff-owner")).toBe("retained");
  expect(reads.slice(start).filter(({action})=>action._==="GetSession").length).toBe(0);expect(subscriptions.length).toBe(streams);
 }),browserBudget);
 test(`${view} handoff projection dialogs restore direct links and close through parent history`,()=>fresh(async page=>{
  await page.goto(handoffHref(view,handoffTokens,"peer-b","handoff",projectionId));await title(page,handoffTitle(2,"peer-b",true));
  const dialog=page.getByRole("dialog");await dialog.getByText("Lineage",{exact:true}).waitFor();await dialog.getByText("Loaded excerpts",{exact:true}).waitFor();
  const link=page.url();await page.reload();await title(page,handoffTitle(2,"peer-b",true));
  await fresh(async tab=>{await tab.goto(link);await title(tab,handoffTitle(2,"peer-b",true));await tab.getByRole("dialog").waitFor();});
  const before=await page.evaluate(()=>history.length);await page.keyboard.press("Escape");await title(page,handoffTitle(2,"peer-b"));expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.goBack();await title(page,handoffTitle(2,"peer-b",true));await page.getByRole("dialog").waitFor();await page.goForward();await page.getByRole("dialog").waitFor({state:"hidden"});
  const start=reads.length,streams=subscriptions.length,length=await page.evaluate(()=>history.length);
  await page.locator('button[title="View every detail of this handoff"]').first().click();await title(page,handoffTitle(2,"peer-b",true));expect(await page.evaluate(()=>history.length)).toBe(length+1);
  expect(reads.slice(start).filter(({action})=>action._==="GetSession").length).toBe(0);expect(subscriptions.length).toBe(streams);
 }),browserBudget);
 test(`${view} handoff malformed and missing selections have canonical URLs and honest titles`,()=>fresh(async page=>{
  await page.goto(handoffHref(view,[handoffTokens[1],handoffTokens[0],handoffTokens[0],"invalid","p:","p:bad\u0001"]));await title(page,handoffTitle(2));
  const outer=new URLSearchParams(new URL(page.url()).hash.split("?")[1]),query=view==="Seed"?new URLSearchParams(outer.get("r")!.split("?")[1]):outer;
  expect(query.getAll("handoff")).toEqual(handoffTokens);
  for(const [tokens,panel,event] of [[["p:missing"],"",""],[[],"handoff","handoff-event-2"],[[],"handoff","missing"]] as [string[],string,string][]){
   await page.goto(handoffHref(view,tokens,"",panel,event));await title(page,"Handoff not found · Seed · Cyberdeck");await page.getByRole("alert").filter({hasText:"Selected handoff is not in this transcript."}).waitFor();
  }
  await page.goto(handoffHref(view,[],"","handoff"));await title(page,handoffTitle());
  const current=new URLSearchParams(new URL(page.url()).hash.split("?")[1]),canonical=view==="Seed"?new URLSearchParams(current.get("r")!.split("?")[1]):current;expect(canonical.has("panel")).toBe(false);
  await page.goto(handoffHref(view,Array.from({length:105},(_,index)=>`p:missing-${index}`)));await title(page,"Handoff not found · Seed · Cyberdeck");
  expect(await page.locator('button[title="Show handoff"]').first().isDisabled()).toBe(true);
 }),browserBudget);
 test(`${view} handoff message shares preserve summaries and node without following a successor`,()=>fresh(async page=>{
  await page.goto(handoffHref(view,handoffTokens,"peer-b"));await title(page,handoffTitle(2,"peer-b"));
  await page.getByRole("button",{name:"Show markdown sent to the LLM"}).first().click();
  const dialog=page.getByRole("dialog").filter({hasText:"Message details"});await dialog.waitFor();
  const shared=new URL(await dialog.locator("code").innerText()),outer=new URLSearchParams(shared.hash.split("?")[1]);expect(outer.get("node")).toBe("peer-b");
  const query=view==="Seed"?new URLSearchParams(outer.get("r")!.split("?")[1]):outer;expect(query.getAll("handoff")).toEqual(handoffTokens);
  await fresh(async tab=>{await tab.goto(shared.href);await tab.getByText("Recorded outgoing handoff",{exact:true}).waitFor();});
  expect(page.url()).toContain("handoffs");
 }),browserBudget);
 test(`${view} handoff late denied reads cannot reopen a hidden dialog or rename a locked owner`,()=>fresh(async page=>{
  holdHandoffRead=true;handoffReadStatus=403;await page.goto(handoffHref(view,[],"","handoff",projectionId));while(!pending.size)await page.waitForTimeout(10);
  await page.evaluate(link=>location.hash=new URL(link).hash,handoffHref(view,handoffTokens,"peer-b"));while(pending.size<2)await page.waitForTimeout(10);
  holdHandoffRead=false;handoffReadStatus=200;for(const release of pending)release();pending.clear();
  await title(page,"Access denied · Seed · Peer B · Cyberdeck");
  holdHandoffRead=true;
  await page.evaluate(link=>location.hash=new URL(link).hash,handoffHref(view,[],"","handoff",projectionId));while(!pending.size)await page.waitForTimeout(10);
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));await page.getByTestId("nav-files").click();await title(page,"Locked · Cyberdeck");
  for(const release of pending)release();pending.clear();await page.waitForTimeout(100);
  expect(await page.title()).toBe("Locked · Cyberdeck");expect(await page.getByRole("dialog").count()).toBe(0);
 }),browserBudget);
}

const runDetailId = "wf-failed-run:2";
const runDetailQuery = (id = runDetailId) => `detail=${encodeURIComponent(id)}`;
const runToolQuery = (id = runDetailId) => `tool=${encodeURIComponent(id)}`;
const runDetailsTitle = (count = 1, node = "") => selectionTitle(`${count} tool detail${count === 1 ? "" : "s"} · Tool calls open · `, node);
const runInspectorTitle = (node = "") => `${"Tool input/output · read · "}${node || "local"} Review navigation · Seed run${node ? " · Peer A" : ""} · Cyberdeck`;

test("Seed standalone run tools restore details and inspectors on direct links, reload and fresh tabs", () => fresh(async page => {
 for (const inspector of [false,true]) {
  await page.goto(selectionHref(inspector ? runToolQuery() : runDetailQuery(),"peer-a"));
  const expected=inspector ? runInspectorTitle("peer-a") : runDetailsTitle(1,"peer-a");
  await title(page,expected);
  if(inspector){await page.getByRole("dialog").getByText(/Recorded run call 2/).waitFor();await page.getByRole("dialog").getByText(`${server.url}seed-fixture/peer-a`,{exact:true}).waitFor();}
  else await page.locator(`[data-tool-detail="${runDetailId}"]`).getByText(/Recorded run result 2/).waitFor();
  await page.reload();await title(page,expected);
  const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,expected);});
 }
}), browserBudget);

test("Seed standalone run tools use one history entry and preserve graph, reads and subscription", () => fresh(async page => {
 await page.goto(selectionHref("calls=open"));await title(page,selectionTitle("Tool calls open · "));
 const calls=page.getByRole("button",{name:/^Tool calls/});await calls.evaluate(el=>(el as any).__fixtureOwner="same tool graph");
 const count=await page.evaluate(()=>history.length), readCount=reads.length, subCount=subscriptions.length;
 await page.getByLabel("Run tool calls").getByTitle("Show tool details",{exact:true}).nth(1).click();await title(page,runDetailsTitle());
 expect(await page.evaluate(()=>history.length)).toBe(count+1);
 await page.getByLabel("Run tool calls").getByTitle("View raw tool input/output",{exact:true}).nth(1).click();await title(page,runInspectorTitle());
 expect(await page.evaluate(()=>history.length)).toBe(count+2);
 await page.keyboard.press("Escape");await title(page,runDetailsTitle());
 expect(await page.evaluate(()=>history.length)).toBe(count+3);
 await page.goBack();await title(page,runInspectorTitle());
 await page.goBack();await title(page,runDetailsTitle());
 await page.goBack();await title(page,selectionTitle("Tool calls open · "));
 await page.goForward();await title(page,runDetailsTitle());
 expect(await calls.evaluate(el=>(el as any).__fixtureOwner)).toBe("same tool graph");
 expect(reads.length).toBe(readCount);expect(subscriptions.length).toBe(subCount);
 await calls.click();await title(page,selectionTitle("Tool calls collapsed · "));
 expect(selectedPath(page.url())).toBe("run/failed-run?calls=closed");
 await page.goBack();await title(page,runDetailsTitle());
}), browserBudget);

test("Seed standalone run tools canonicalize duplicate, invalid, bounded and hidden detail selections", () => fresh(async page => {
 await page.goto(selectionHref(`calls=closed&${runDetailQuery()}&${runDetailQuery()}&detail=&detail=%00&tool=&tool=ignored`));
 await title(page,runDetailsTitle());expect(selectedPath(page.url())).toBe(`run/failed-run?calls=open&${runDetailQuery()}`);
 await page.goto(selectionHref(`${runToolQuery()}&error=failed-run`));await title(page,runInspectorTitle());
 expect(selectedPath(page.url())).toBe(`run/failed-run?${runToolQuery()}`);expect(await page.getByRole("dialog").count()).toBe(1);
 const many=Array.from({length:105},(_,i)=>`detail=missing-${String(i).padStart(3,"0")}`).join("&");
 await page.goto(selectionHref(many));await title(page,"Run tools not found · Seed · Cyberdeck");
 expect(new URLSearchParams(selectedPath(page.url())!.split("?")[1]).getAll("detail").length).toBe(100);
 expect(await page.getByLabel("Run tool calls").getByTitle("Show tool details",{exact:true}).first().isDisabled()).toBe(true);
}), browserBudget);

test("Seed standalone run tools recover only owned durable journals without fetching arbitrary content", () => fresh(async page => {
 const readsBefore=reads.filter(row=>row.action._==="GetSessionEvent" || row.action._==="GetRunJournal").length;
 holdRunJournal=true;await page.goto(selectionHref(runToolQuery()));
 await title(page,`Waiting for tool · ${runDetailId} · local Review navigation · Seed run · Cyberdeck`);
 await page.getByText("Waiting for selected recorded tools…").waitFor();
 expect(await page.getByRole("dialog").count()).toBe(0);const link=page.url();
 holdRunJournal=false;for(const release of pending)release();pending.clear();
 await title(page,runInspectorTitle());expect(page.url()).toBe(link);
 await waitInlineFixture(()=>reads.filter(row=>row.action._==="GetSessionEvent" || row.action._==="GetRunJournal").length===readsBefore+2);
 expect(reads.filter(row=>row.action._==="GetSessionEvent" || row.action._==="GetRunJournal").length).toBe(readsBefore+2);
 expect(reads.slice(-20).filter(row=>row.action._==="GetRunJournal").every(row=>["failed-run",errorChild].includes(row.action.runId))).toBe(true);
}), browserBudget);

test("Seed standalone run tools preserve absent journal selections and graph errors retry at the same URL", () => fresh(async page => {
 for(const [status,label] of [[403,"Access denied"],[404,"Run tools not found"],[503,"Run tools unavailable"]] as const){
  await page.goto("about:blank");graphStatus=status;
  await page.goto(selectionHref(runToolQuery("wf-child:1")));await title(page,`${label} · Seed · Cyberdeck`);
  const link=page.url(), length=await page.evaluate(()=>history.length);graphStatus=200;
  await page.getByRole("button",{name:"Retry",exact:true}).click();
  await title(page,"Run tools not found · Seed · Cyberdeck");
  expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
 }
}), browserBudget);

test("Seed standalone run tools discard late journal selections across run and node transitions", () => fresh(async page => {
 holdRunJournal=true;await page.goto(selectionHref(runToolQuery()));while(!pending.size)await page.waitForTimeout(10);
 await page.evaluate(url=>location.hash=new URL(url).hash,selectionHref("calls=closed","peer-a"));
 await title(page,selectionTitle("Tool calls collapsed · ","peer-a"));
 const link=page.url();holdRunJournal=false;for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(page.url()).toBe(link);expect(await page.title()).toBe(selectionTitle("Tool calls collapsed · ","peer-a"));
 expect(await page.getByRole("dialog").count()).toBe(0);
 await page.evaluate(url=>location.hash=new URL(url).hash,href("run/activity?code=1"));await title(page,runTitle("Code · "));
}), browserBudget);

test("Seed standalone run tools cannot reopen closed inspectors or rename a locked host", () => fresh(async page => {
 holdRunJournal=true;await page.goto(selectionHref(runToolQuery()));while(!pending.size)await page.waitForTimeout(10);
 await page.evaluate(url=>location.hash=new URL(url).hash,selectionHref("calls=open"));
 await title(page,selectionTitle("Waiting for tool calls · Tool calls open · "));
 holdRunJournal=false;for(const release of pending)release();pending.clear();await title(page,selectionTitle("Tool calls open · "));
 expect(await page.getByRole("dialog").count()).toBe(0);
 await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
 await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
 await page.waitForTimeout(100);expect(await page.getByRole("dialog").count()).toBe(0);
}), browserBudget);

test("Seed standalone run tools keep primary failures accurate and do not replay run commands", () => fresh(async page => {
 for(const [id,label] of [["missing","Run not found"],["denied","Access denied"],["offline","Run unavailable"]]){
  await page.goto(href(`run/${id}?${runToolQuery()}&${runDetailQuery()}`));await title(page,`${label} · Seed · Cyberdeck`);
  expect(await page.getByRole("dialog").count()).toBe(0);
 }
}), browserBudget);

test("Seed standalone run tools restore descendant IDs containing reserved characters after delayed graph reads", () => fresh(async page => {
 nestedRunTools=true;holdGraph=true;
 const id=`wf-${errorChild}:9`;
 await page.goto(selectionHref(`${runDetailQuery(id)}&${runToolQuery(id)}`,"peer-a"));
 await title(page,`Waiting for tool · ${id} · peer-a Review navigation · Seed run · Peer A · Cyberdeck`);
 holdGraph=false;for(const release of pending)release();pending.clear();
 await title(page,runInspectorTitle("peer-a"));await page.getByRole("dialog").getByText(/Recorded descendant result/).waitFor();
 const link=page.url();await page.reload();await title(page,runInspectorTitle("peer-a"));expect(page.url()).toBe(link);
}), browserBudget);

test("Seed standalone run tools own workflow loading, read failures, malformed data and read-only retry", () => fresh(async page => {
 for(const [status,malformed,label] of [[403,"","Access denied"],[404,"","Workflow run not found"],[503,"","Workflow run unavailable"],[200,"plan","Workflow run unavailable"]] as const){
  await page.goto("about:blank");nestedRunTools=true;detailRunStatus=status;malformedDetailRun=malformed;
  await page.goto(selectionHref(runDetailQuery("wf-failed-run:99")));await title(page,`${label} · Seed · Cyberdeck`);
  const link=page.url(), count=await page.evaluate(()=>history.length);detailRunStatus=200;malformedDetailRun="";
  await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,runDetailsTitle());
  await page.getByText("Recorded plan step",{exact:true}).waitFor();
  expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
 }
}), browserBudget);

test("Seed standalone run tools ignore late workflow errors after collapse and authentication changes", () => fresh(async page => {
 nestedRunTools=true;holdDetailRun=true;detailRunStatus=403;
 await page.goto(selectionHref(runDetailQuery("wf-failed-run:99")));await title(page,"Loading workflow run · Seed · Cyberdeck");
 while(!pending.size)await page.waitForTimeout(10);
 await page.getByRole("button",{name:/^Tool calls/}).click();await title(page,selectionTitle("Tool calls collapsed · "));
 holdDetailRun=false;for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(await page.title()).toBe(selectionTitle("Tool calls collapsed · "));
 expect(await page.getByRole("alert").count()).toBe(0);
 await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
 await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
 expect(await page.getByRole("dialog").count()).toBe(0);
}), browserBudget);

test("Seed standalone run tools retain the selected external server and signer independently", () => fresh(async page => {
 const path=`server=${encodeURIComponent(`${server.url}seed-fixture/external`)}&${runToolQuery()}`;
 await page.goto(selectionHref(path,"peer-a"));
 await title(page,"Tool input/output · read · external Review navigation · Seed run · Peer A · Cyberdeck");
 await page.getByRole("dialog").getByText(/Recorded run result 2/).waitFor();
 await page.getByRole("dialog").getByText(`${server.url}seed-fixture/external`,{exact:true}).waitFor();
 expect(reads.some(row=>row.node==="external" && row.action._==="GetRun" && row.action.runId==="failed-run")).toBe(true);
 await page.reload();await title(page,"Tool input/output · read · external Review navigation · Seed run · Peer A · Cyberdeck");
}), browserBudget);

test("Seed standalone run tools cannot publish delayed journal content after lock", () => fresh(async page => {
 holdRunJournal=true;await page.goto(selectionHref(runToolQuery()));while(!pending.size)await page.waitForTimeout(10);
 await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
 await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
 holdRunJournal=false;for(const release of pending)release();pending.clear();await page.waitForTimeout(150);
 expect(await page.title()).toBe("Locked · Cyberdeck");expect(await page.getByRole("dialog").count()).toBe(0);
}), browserBudget);

test("Seed standalone run tools keep recorded details, dialogs and waiting/error states within phone and desktop bounds", () => fresh(async page => {
 for(const width of [390,1280])for(const colorScheme of ["light","dark"] as const){
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});
  for(const state of ["details","inspector","waiting","error"]){
   await page.goto("about:blank");graphStatus=state==="error" ? 503 : 200;
   await page.goto(selectionHref(state==="details" ? runDetailQuery() : runToolQuery(state==="waiting" || state==="error" ? "wf-absent:1" : runDetailId)));
   await title(page,state==="details" ? runDetailsTitle() : state==="inspector" ? runInspectorTitle() : state==="error" ? "Run tools unavailable · Seed · Cyberdeck" : "Run tools not found · Seed · Cyberdeck");
   await page.waitForTimeout(200);
   if(state==="inspector"){
    const bounds=await page.getByRole("dialog").boundingBox();expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
   }
   expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
   if(process.env.CYBERDECK_NAV_SHOTS)await page.screenshot({path:join(process.env.CYBERDECK_NAV_SHOTS,`run-tools-${state}-${width}-${colorScheme}.png`)});
  }
 }
}), browserBudget);

test("Seed standalone run tools give the visible inspector title ownership over pending background details", () => fresh(async page => {
 await page.goto(selectionHref(`${runDetailQuery("wf-absent:1")}&${runToolQuery()}`));
 await title(page,runInspectorTitle());await page.getByRole("dialog").getByText(/Recorded run result 2/).waitFor();
 await page.keyboard.press("Escape");await title(page,"Run tools not found · Seed · Cyberdeck");
 await page.getByText("The selected tool is not in this completed run's recorded journal.").waitFor();
}), browserBudget);

const triggerSections=["activity","instructions","prompt"] as const;
const triggerLabels={activity:"Activity details",instructions:"Trigger instructions",prompt:"Trigger prompt"};
const triggerHref=(view:string,sections:readonly string[]=triggerSections,node="",id="triggered")=>{
 const q=new URLSearchParams();for(const field of sections)q.append("trigger-context",field);
 return view==="Seed" ? href(`session/${id}${q.size?`?${q}`:""}`,node) : `${server.url}#/term?${new URLSearchParams({session:`seed-${id}`,filter:"retained",...(node?{node}:{})})}${q.size?`&${q}`:""}`;
};
const triggerTitle=(sections:readonly string[]=triggerSections,node="local")=>`${sections.length?`${[...sections].sort().map(field=>triggerLabels[field as keyof typeof triggerLabels]).join(" + ")} · Recorded schedule · `:""}${node} First conversation · Seed session${node!=="local"?" · Peer B":""} · Cyberdeck`;
for(const view of ["Seed","Sessions"]){
 test(`${view} recorded trigger context restores direct links, reload, fresh tabs and selected nodes`,()=>fresh(async page=>{
  await page.goto(triggerHref(view,triggerSections,"peer-b"));await title(page,triggerTitle(triggerSections,"peer-b"));
  for(const field of triggerSections)expect(await page.getByRole("button",{name:triggerLabels[field],exact:true}).getAttribute("aria-expanded")).toBe("true");
  await page.getByText("Recorded prompt body",{exact:true}).waitFor();await page.getByText("Recorded instructions body",{exact:true}).waitFor();await page.getByText(/Recorded activity payload/).waitFor();
  await page.reload();await title(page,triggerTitle(triggerSections,"peer-b"));
  const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,triggerTitle(triggerSections,"peer-b"));});
 }),browserBudget);
 test(`${view} recorded trigger context pushes once and retains the transcript, composer and subscription`,()=>fresh(async page=>{
  await page.goto(triggerHref(view,[]));await title(page,triggerTitle([]));
  const button=page.getByRole("button",{name:"Trigger prompt",exact:true});await button.waitFor();
  const composer=page.locator("textarea").first();await composer.evaluate(el=>(el as any).__fixtureOwner="same trigger composer");await composer.fill("Keep this unsent draft");
  const count=await page.evaluate(()=>history.length),readCount=reads.length,subCount=subscriptions.length;
  await button.click();await title(page,triggerTitle(["prompt"]));expect(await page.evaluate(()=>history.length)).toBe(count+1);
  await page.getByRole("button",{name:"Activity details",exact:true}).click();await title(page,triggerTitle(["activity","prompt"]));
  await page.goBack();await title(page,triggerTitle(["prompt"]));await page.goBack();await title(page,triggerTitle([]));
  await page.goForward();await title(page,triggerTitle(["prompt"]));
  expect(await composer.evaluate(el=>(el as any).__fixtureOwner)).toBe("same trigger composer");expect(await composer.inputValue()).toBe("Keep this unsent draft");
  expect(reads.length).toBe(readCount);expect(subscriptions.length).toBe(subCount);
  if(view==="Sessions")expect(new URLSearchParams(new URL(page.url()).hash.slice(7)).get("filter")).toBe("retained");
 }),browserBudget);
 test(`${view} recorded trigger context canonicalizes duplicates and unsupported selections with replace`,()=>fresh(async page=>{
  await page.goto(triggerHref(view,["prompt","activity","prompt","","unknown","PROMPT","instructions"]));await title(page,triggerTitle());
  const q=view==="Seed"?new URLSearchParams(selectedPath(page.url())!.split("?")[1]):new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
  expect(q.getAll("trigger-context")).toEqual([...triggerSections]);
  await page.goto(triggerHref(view,["unknown"]));await title(page,triggerTitle([]));
  expect(page.url()).not.toContain("trigger-context");
 }),browserBudget);
 test(`${view} recorded trigger context keeps absent prompt, instructions and context honest`,()=>fresh(async page=>{
  for(const [id,sections] of [["one",["activity"]],["triggered-no-prompt",["prompt"]],["triggered-no-instructions",["instructions"]]] as const){
   await page.goto(triggerHref(view,sections,"",id));await title(page,"Trigger context not found · Seed · Cyberdeck");
   await page.getByRole("alert").getByText("Selected trigger context is not in this transcript.",{exact:true}).waitFor();
   expect(page.url()).toContain("trigger-context");
  }
 }),browserBudget);
 test(`${view} recorded trigger context read failures retry at the same URL without firing anything`,()=>fresh(async page=>{
  for(const [status,label] of [[403,"Access denied"],[404,"Session not found"],[503,"Session unavailable"]] as const){
   await page.goto("about:blank");triggerReadStatus=status;await page.goto(triggerHref(view,["activity"]));await title(page,`${label} · Seed · Cyberdeck`);
   const link=page.url(),count=await page.evaluate(()=>history.length);triggerReadStatus=200;
   await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,triggerTitle(["activity"]));
   expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
  }
 }),browserBudget);
 test(`${view} recorded trigger context ignores late denied transcripts after node and lock changes`,()=>fresh(async page=>{
  holdTriggerRead=true;triggerReadStatus=403;await page.goto(triggerHref(view,["prompt"]));while(!pending.size)await page.waitForTimeout(10);
  holdTriggerRead=false;triggerReadStatus=200;
  await page.evaluate(url=>location.hash=new URL(url).hash,triggerHref(view,["activity"],"peer-b"));await title(page,triggerTitle(["activity"],"peer-b"));
  for(const release of pending)release();pending.clear();await page.waitForTimeout(100);expect(await page.title()).toBe(triggerTitle(["activity"],"peer-b"));
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
  await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");expect(await page.getByText("Recorded activity payload",{exact:false}).count()).toBe(0);
 }),browserBudget);
}

for(const view of ["Seed","Sessions"])test(`${view} recorded trigger context message links retain the selected fields and signer`,()=>fresh(async page=>{
 await page.goto(triggerHref(view,["activity"],"peer-b"));await title(page,triggerTitle(["activity"],"peer-b"));
 await page.getByRole("button",{name:"Show markdown sent to the LLM",exact:true}).first().click();
 const share=await page.getByRole("dialog").locator("code").innerText();
 const outer=new URLSearchParams(new URL(share).hash.slice(7));
 expect(outer.get("node")).toBe("peer-b");
 const query=view==="Seed"?new URLSearchParams(outer.get("r")!.split("?")[1]):outer;
 expect(query.getAll("trigger-context")).toEqual(["activity"]);
 await page.keyboard.press("Escape");
 await page.getByRole("button",{name:"Trigger prompt",exact:true}).click();await title(page,"Message · "+triggerTitle(["activity","prompt"],"peer-b"));
 await page.getByRole("button",{name:"Show markdown sent to the LLM",exact:true}).first().click();
 const updated=new URLSearchParams(new URL(await page.getByRole("dialog").locator("code").innerText()).hash.slice(7));
 expect((view==="Seed"?new URLSearchParams(updated.get("r")!.split("?")[1]):updated).getAll("trigger-context")).toEqual(["activity","prompt"]);
}),browserBudget);

test("Seed recorded trigger context cannot publish delayed contents after authentication lock",()=>fresh(async page=>{
 holdTriggerRead=true;await page.goto(triggerHref("Seed",["activity"]));while(!pending.size)await page.waitForTimeout(10);
 await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
 await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
 holdTriggerRead=false;for(const release of pending)release();pending.clear();await page.waitForTimeout(100);
 expect(await page.title()).toBe("Locked · Cyberdeck");expect(await page.getByText("Recorded prompt body",{exact:true}).count()).toBe(0);
}),browserBudget);

test("Seed recorded trigger context and missing-field states fit phone and desktop in both color schemes",()=>fresh(async page=>{
 for(const width of [390,1280])for(const colorScheme of ["light","dark"] as const){
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme});
  for(const state of ["expanded","missing"]){
   await page.goto(triggerHref("Seed",state==="expanded"?triggerSections:["prompt"],"",state==="expanded"?"triggered":"triggered-no-prompt"));
   await title(page,state==="expanded"?triggerTitle():"Trigger context not found · Seed · Cyberdeck");await page.waitForTimeout(180);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
   if(process.env.CYBERDECK_NAV_SHOTS)await page.screenshot({path:join(process.env.CYBERDECK_NAV_SHOTS,`trigger-context-${state}-${width}-${colorScheme}.png`)});
  }
 }
}),browserBudget);


const interruptedTitle = (node = "") => `Run updates unavailable · Seed${node ? " · Peer A" : ""} · Cyberdeck`;
const interruptRunSockets = (node = "local", message = "Fixture late run subscription failure") => {
 for (const [socket, owner] of runSockets) if(owner.node === node) socket.send(JSON.stringify({_:"error",message}));
};

test("Seed run journal failures restore honest errors through direct links, reload and fresh tabs", () => fresh(async page => {
 runStreamMode="error";
 await page.goto(selectionHref(runToolQuery(),"peer-a"));await title(page,interruptedTitle("peer-a"));
 await page.getByText("Run updates interrupted",{exact:true}).waitFor();
 expect(await page.getByText("Waiting for selected recorded tools…",{exact:true}).count()).toBe(0);
 await page.getByRole("dialog").getByText(/Recorded run result 2/).waitFor();
 const link=page.url();await page.reload();await title(page,interruptedTitle("peer-a"));
 await fresh(async tab=>{runStreamMode="error";await tab.goto(link);await title(tab,interruptedTitle("peer-a"));});
}),browserBudget);

test("Seed run journal retry retains canonical history, graph owner and selected tools without replaying commands", () => fresh(async page => {
 const journalStart=reads.length;
 runStreamMode="error";await page.goto(selectionHref(runToolQuery()));await title(page,interruptedTitle());
 await waitInlineFixture(()=>reads.slice(journalStart).filter(row=>row.action._==="GetRunJournal").length===2);
 const link=page.url(),count=await page.evaluate(()=>history.length),readCount=reads.length,subCount=subscriptions.filter(key=>key==="runs/failed-run").length;
 const graph=page.getByText("Recorded child step",{exact:true});await graph.evaluate(el=>(el as any).__fixtureJournalOwner="retained");
 runStreamMode="";await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,runInspectorTitle());
 await page.getByRole("dialog").getByText(/Recorded run result 2/).waitFor();
 expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
 expect(await graph.evaluate(el=>(el as any).__fixtureJournalOwner)).toBe("retained");
 expect(reads.length).toBe(readCount);expect(subscriptions.filter(key=>key==="runs/failed-run").length).toBe(subCount+1);
 expect(await page.getByText("Run updates interrupted",{exact:true}).count()).toBe(0);
}),browserBudget);

test("Seed run journal errors preserve recorded tools and activity while history keeps one subscription", () => fresh(async page => {
 const journalStart=reads.length;
 await page.goto(selectionHref(runToolQuery()));await title(page,runInspectorTitle());
 await waitInlineFixture(()=>reads.slice(journalStart).filter(row=>row.action._==="GetRunJournal").length===2);
 const before=subscriptions.length,readCount=reads.length;interruptRunSockets();await title(page,interruptedTitle());
 await page.getByRole("dialog").getByText(/Recorded run result 2/).waitFor();
 await page.keyboard.press("Escape");await title(page,interruptedTitle());
 await page.goBack();await page.getByRole("dialog").waitFor();await title(page,interruptedTitle());
 await page.goForward();await page.getByRole("dialog").waitFor({state:"hidden"});
 expect(subscriptions.length).toBe(before);expect(reads.length).toBe(readCount);
 await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,selectionTitle());
 await page.goto(runHref("activity=1&entry=activity%3A1"));await title(page,runTitle("1 activity entry · "));
 interruptRunSockets();await title(page,interruptedTitle());
 await page.getByText(/Full recorded detail 1/).waitFor();
}),browserBudget);

test("Seed run journal disconnected sockets report failure and recover automatically without route writes", () => fresh(async page => {
 runStreamMode="close";await page.goto(selectionHref("calls=open"));await title(page,interruptedTitle());
 const link=page.url(),count=await page.evaluate(()=>history.length);runStreamMode="";
 await title(page,selectionTitle("Tool calls open · "));
 expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
}),browserBudget);

test("Seed run journal malformed stream messages are visible and retryable", () => fresh(async page => {
 runStreamMode="malformed";await page.goto(runHref("activity=1"));await title(page,interruptedTitle());
 await page.getByText("Run updates interrupted",{exact:true}).waitFor();await page.getByText("Recorded activity could not be loaded.",{exact:true}).waitFor();runStreamMode="";
 await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,runTitle("Activity · "));
}),browserBudget);

test("Seed run journal missing acknowledgements time out and retry at the same selected URL", () => fresh(async page => {
 await page.clock.install();runStreamMode="silent";await page.goto(selectionHref(runToolQuery()));
 await title(page,runInspectorTitle());
 const link=page.url();await page.clock.fastForward(15001);await title(page,interruptedTitle());
 runStreamMode="";await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,runInspectorTitle());expect(page.url()).toBe(link);
}),browserBudget);

test("Seed run journal late errors cannot retitle another run, signing node or authentication boundary", () => fresh(async page => {
 await page.goto(selectionHref(runToolQuery()));await title(page,runInspectorTitle());
 const oldSockets=[...runSockets.keys()];
 await page.evaluate(link=>location.hash=new URL(link).hash,runHref("code=1","peer-a"));await title(page,runTitle("Code · ","peer-a"));
 for(const socket of oldSockets)socket.send(JSON.stringify({_:"error",message:"Late stale subscription"}));
 await page.waitForTimeout(100);expect(await page.title()).toBe(runTitle("Code · ","peer-a"));
 interruptRunSockets("peer-a");await title(page,interruptedTitle("peer-a"));
 await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
 interruptRunSockets("peer-a");await page.waitForTimeout(100);expect(await page.title()).toBe("Locked · Cyberdeck");expect(await page.getByText("Run updates interrupted",{exact:true}).count()).toBe(0);
}),browserBudget);

test("Seed run journal external server ownership remains independent of the signing machine", () => fresh(async page => {
 runStreamMode="error";const query=`server=${encodeURIComponent(`${server.url}seed-fixture/external`)}&${runToolQuery()}`;
 await page.goto(selectionHref(query,"peer-a"));await title(page,interruptedTitle("peer-a"));const link=page.url();
 runStreamMode="";await page.getByRole("button",{name:"Retry",exact:true}).click();
 await title(page,"Tool input/output · read · external Review navigation · Seed run · Peer A · Cyberdeck");expect(page.url()).toBe(link);
 await page.getByRole("dialog").getByText(`${server.url}seed-fixture/external`,{exact:true}).waitFor();
}),browserBudget);

test("Seed run journal failure and recovery fit desktop and phone in both color preferences", () => fresh(async page => {
 for(const width of [390,1280])for(const colorScheme of ["light","dark"] as const){
  await page.goto("about:blank");await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});runStreamMode="error";
  await page.goto(selectionHref(runDetailQuery()));await title(page,interruptedTitle());await page.waitForTimeout(200);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(process.env.CYBERDECK_NAV_SHOTS)await page.screenshot({path:join(process.env.CYBERDECK_NAV_SHOTS,`journal-error-${width}-${colorScheme}.png`)});
  if(width===390)expect((await page.getByRole("button",{name:"Retry",exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  runStreamMode="silent";await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,"Reconnecting run updates · Seed · Cyberdeck");await page.waitForTimeout(200);
  if(process.env.CYBERDECK_NAV_SHOTS)await page.screenshot({path:join(process.env.CYBERDECK_NAV_SHOTS,`journal-reconnecting-${width}-${colorScheme}.png`)});
  interruptRunSockets();await title(page,interruptedTitle());
  runStreamMode="";await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,runDetailsTitle());await page.waitForTimeout(200);
  if(process.env.CYBERDECK_NAV_SHOTS)await page.screenshot({path:join(process.env.CYBERDECK_NAV_SHOTS,`journal-recovered-${width}-${colorScheme}.png`)});
 }
}),browserBudget);


test("Seed run journal retry shows connecting state and rejects unrelated acknowledgements", () => fresh(async page => {
 runStreamMode="error";await page.goto(selectionHref(runToolQuery()));await title(page,interruptedTitle());
 for(const [socket,owner] of runSockets)if(owner.node==="local")socket.send(JSON.stringify({_:"subscribed",key:"runs/some-other-run",accountId:account}));
 await page.waitForTimeout(100);expect(await page.title()).toBe(interruptedTitle());
 runStreamMode="silent";const link=page.url(),count=await page.evaluate(()=>history.length),subscriptionStart=subscriptions.length;
 await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,"Reconnecting run updates · Seed · Cyberdeck");
 await page.getByText("Reconnecting run updates…",{exact:true}).waitFor();
 expect(await page.getByRole("button",{name:"Retry",exact:true}).count()).toBe(0);
 expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
 await waitInlineFixture(()=>subscriptions.length>subscriptionStart && [...runSockets.values()].some(owner=>owner.node==="local" && owner.key==="runs/failed-run"));
 interruptRunSockets();await title(page,interruptedTitle());runStreamMode="";
 await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,runInspectorTitle());
}),browserBudget);

test("Seed run journal signing failures stay owned and retry without locking the requested view", () => fresh(async page => {
 let deny=true;
 await page.route("**/api/seed-agents/sign",async route=>{
  const data=route.request().postDataJSON().data;
  const envelope:any=cbor.decode(new Uint8Array(Buffer.from(data,"base64")));
  if(deny && envelope.action?._==="Subscribe" && envelope.action.key.startsWith("runs/"))return route.fulfill({status:403,json:{error:"Fixture signing denied"}});
  return route.continue();
 });
 await page.goto(selectionHref(runToolQuery()));await title(page,"Access denied · Seed · Cyberdeck");
 await page.getByText("Run updates interrupted",{exact:true}).waitFor();const link=page.url();deny=false;
 await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,runInspectorTitle());expect(page.url()).toBe(link);
}),browserBudget);


test("Seed run journal delayed signing cannot publish failure into a later signing node", () => fresh(async page => {
 let release:(()=>void)|undefined;
 await page.route("**/api/seed-agents/sign",async route=>{
  const envelope:any=cbor.decode(new Uint8Array(Buffer.from(route.request().postDataJSON().data,"base64")));
  if(envelope.action?._==="Subscribe" && envelope.action.key.startsWith("runs/")){
   await new Promise<void>(resolve=>release=resolve);
   return route.fulfill({status:403,json:{error:"Fixture late signing failure"}});
  }
  return route.continue();
 });
 await page.goto(selectionHref(runToolQuery()));while(!release)await page.waitForTimeout(10);
 await page.evaluate(link=>location.hash=new URL(link).hash,selectionHref(runToolQuery(),"peer-a"));await title(page,runInspectorTitle("peer-a"));
 release();await page.waitForTimeout(150);expect(await page.title()).toBe(runInspectorTitle("peer-a"));
 await page.getByRole("dialog").getByText(/Recorded run result 2/).waitFor();
}),browserBudget);

const inlineHref = (view: string, states: string[] = [], node = "", external = false) => {
 const query=new URLSearchParams();for(const value of states)query.append("inline-calls",value);
 if(external)query.set("server",`${server.url}seed-fixture/external`);
 return view === "Seed" ? href(`session/inline${query.size ? `?${query}` : ""}`,node)
  : `${server.url}#/term?${new URLSearchParams({session:"seed-inline",...(node ? {node} : {})})}${query.size ? `&${query}` : ""}`;
};
const inlineTitle = (states: string[] = [], node = "", external = false) => `${states.length === 1 ? `Run tool calls ${states[0].startsWith("open:") ? "open" : "collapsed"} · ` : states.length ? `${states.length} run tool lists · ` : ""}${external ? "external" : node || "local"} First conversation · Seed session${node ? ` · ${node === "peer-a" ? "Peer A" : "Peer B"}` : ""} · Cyberdeck`;
const runCalls = (page: Page, id = inlineIds[0]) => page.locator(`[data-inline-run-calls=${JSON.stringify(id)}]`);
const inlineParams = (page: Page, view: string) => {
 const outer=new URLSearchParams(new URL(page.url()).hash.slice(7));
 return view === "Seed" ? new URLSearchParams(outer.get("r")!.split("?")[1]) : outer;
};
for(const view of ["Seed","Sessions"]) {
 test(`Seed inline run ${view} direct links, reload and fresh tabs restore independent lists and the signing node`,()=>fresh(async page=>{
  const states=[`open:${inlineIds[0]}`,`closed:${inlineIds[1]}`];
  await page.goto(inlineHref(view,states,"peer-b"));await title(page,inlineTitle(states,"peer-b"));
  expect(await runCalls(page).getAttribute("aria-expanded")).toBe("true");
  expect(await runCalls(page,inlineIds[1]).getAttribute("aria-expanded")).toBe("false");
  await page.getByLabel("Run tool calls",{exact:true}).getByText("Recorded inline result 7",{exact:false}).waitFor();
  await page.reload();await title(page,inlineTitle(states,"peer-b"));
  const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,inlineTitle(states,"peer-b"));expect(await runCalls(tab).getAttribute("aria-expanded")).toBe("true");});
 }),browserBudget);
 test(`Seed inline run ${view} pushes once per card and history retains the composer, transcript and subscriptions`,()=>fresh(async page=>{
  await page.goto(inlineHref(view,[`closed:${inlineIds[0]}`]));await title(page,inlineTitle([`closed:${inlineIds[0]}`]));
  await runCalls(page).waitFor();await page.getByPlaceholder("Untitled session").evaluate(el=>(el as any).__inlineOwner="same transcript");
  const streamCount=subscriptions.length, readCount=reads.length, length=await page.evaluate(()=>history.length);
  await runCalls(page).click();await title(page,inlineTitle([`open:${inlineIds[0]}`]));expect(await page.evaluate(()=>history.length)).toBe(length+1);
  await runCalls(page,inlineIds[1]).click();await title(page,inlineTitle(["one","two"]));expect(await page.evaluate(()=>history.length)).toBe(length+2);
  await page.goBack();await title(page,inlineTitle([`open:${inlineIds[0]}`]));await page.goBack();await title(page,inlineTitle([`closed:${inlineIds[0]}`]));
  await page.goForward();await title(page,inlineTitle([`open:${inlineIds[0]}`]));
  expect(await page.getByPlaceholder("Untitled session").evaluate(el=>(el as any).__inlineOwner)).toBe("same transcript");
  expect(reads.slice(readCount).filter(({action})=>["GetSession","GetRun","ListRuns"].includes(action._))).toEqual([]);expect(subscriptions.length).toBe(streamCount);
 }),browserBudget);
 test(`Seed inline run ${view} normalizes bounded conflicting states and preserves honest missing titles`,()=>fresh(async page=>{
  const id=inlineIds[0];await page.goto(inlineHref(view,[`closed:${id}`,`open:${id}`,`open:${id}`,"open:","OPEN:other","open:bad\u0001"]));
  await title(page,inlineTitle([`open:${id}`]));expect(inlineParams(page,view).getAll("inline-calls")).toEqual([`open:${id}`]);
  const length=await page.evaluate(()=>history.length);await page.waitForTimeout(100);expect(await page.evaluate(()=>history.length)).toBe(length);
  await page.goto(inlineHref(view,["open:missing"]));await title(page,"Run cards not found · Seed · Cyberdeck");await page.getByRole("alert").filter({hasText:"Selected run cards are not in this session."}).waitFor();
  await page.reload();await title(page,"Run cards not found · Seed · Cyberdeck");
  await page.goto(inlineHref(view,Array.from({length:105},(_,i)=>`closed:missing-${i}`)));await title(page,"Run cards not found · Seed · Cyberdeck");
  expect(inlineParams(page,view).getAll("inline-calls").length).toBe(100);expect(await runCalls(page).isDisabled()).toBe(true);
 }),browserBudget);
 test(`Seed inline run ${view} selected completed cards reveal recorded tools without replaying execution`,()=>fresh(async page=>{
  inlineSucceeded=true;await page.goto(inlineHref(view,[`open:${inlineIds[0]}`]));await title(page,inlineTitle([`open:${inlineIds[0]}`]));
  await page.getByLabel("Run tool calls",{exact:true}).getByText("Recorded inline result 7",{exact:false}).waitFor();
  expect(await runCalls(page).getAttribute("aria-expanded")).toBe("true");expect(await runCalls(page,inlineIds[1]).count()).toBe(0);
  await page.reload();await title(page,inlineTitle([`open:${inlineIds[0]}`]));await runCalls(page).waitFor();
 }),browserBudget);
 test(`Seed inline run ${view} list errors and malformed data retry at the selected URL without history changes`,()=>fresh(async page=>{
  for(const [status,malformed,label] of [[403,"","Access denied"],[404,"","Run cards not found"],[503,"","Run cards unavailable"],[200,"response","Run cards unavailable"],[200,"list","Run cards unavailable"],[200,"owner","Run cards unavailable"],[200,"plan","Run cards unavailable"]] as const){
   inlineListStatus=status;malformedInlineList=malformed;await page.goto("about:blank");await page.goto(inlineHref(view,[`open:${inlineIds[0]}`]));await title(page,`${label} · Seed · Cyberdeck`);
   const link=page.url(),length=await page.evaluate(()=>history.length);inlineListStatus=200;malformedInlineList="";
   await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineTitle([`open:${inlineIds[0]}`]));
   expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
  }
 }),browserBudget);
 test(`Seed inline run ${view} card read failures retry without another transcript or history entry`,()=>fresh(async page=>{
  for(const [status,malformed] of [[403,""],[404,""],[503,""],[200,"owner"],[200,"id"]] as const){
   malformedInlineCard=malformed;inlineCardStatus=status;await page.goto("about:blank");await page.goto(inlineHref(view,[`open:${inlineIds[0]}`]));
   await title(page,`${status === 403 ? "Access denied" : status === 404 ? "Run card not found" : "Run card unavailable"} · Seed · Cyberdeck`);
   const before=reads.length,link=page.url(),length=await page.evaluate(()=>history.length);inlineCardStatus=200;malformedInlineCard="";
   await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineTitle([`open:${inlineIds[0]}`]));await runCalls(page).waitFor();
   expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);expect(reads.slice(before).filter(({action})=>action._==="GetSession")).toEqual([]);
  }
 }),browserBudget);
 test(`Seed inline run ${view} late denied lists cannot rename another node, view or locked owner`,()=>fresh(async page=>{
  holdInlineList=true;inlineListStatus=403;await page.goto(inlineHref(view,[`open:${inlineIds[0]}`]));await title(page,"Loading run cards · Seed · Cyberdeck");
  while(!pending.size)await page.waitForTimeout(10);holdInlineList=false;inlineListStatus=200;
  await page.evaluate(link=>location.hash=new URL(link).hash,inlineHref(view,[`closed:${inlineIds[1]}`],"peer-b"));await title(page,inlineTitle([`closed:${inlineIds[1]}`],"peer-b"));
  for(const release of pending)release();pending.clear();await page.waitForTimeout(100);expect(await page.title()).toBe(inlineTitle([`closed:${inlineIds[1]}`],"peer-b"));
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");expect(await runCalls(page).count()).toBe(0);
 }),browserBudget);
 test(`Seed inline run ${view} message shares retain list selections and signing node`,()=>fresh(async page=>{
  // The transcript supplies a real user message; its share link describes the same run disclosures.
  await page.goto(inlineHref(view,[`open:${inlineIds[0]}`],"peer-b"));await title(page,inlineTitle([`open:${inlineIds[0]}`],"peer-b"));
  await page.getByRole("button",{name:"Show markdown sent to the LLM",exact:true}).first().click();
  const outer=new URLSearchParams(new URL(await page.getByRole("dialog").locator("code").innerText()).hash.slice(7));expect(outer.get("node")).toBe("peer-b");
  const query=view === "Seed" ? new URLSearchParams(outer.get("r")!.split("?")[1]) : outer;expect(query.getAll("inline-calls")).toEqual([`open:${inlineIds[0]}`]);
 }),browserBudget);
}
test("Seed inline run external-server reads keep the selected signing node and URL",()=>fresh(async page=>{
 await page.goto(inlineHref("Seed",[`open:${inlineIds[0]}`],"peer-b",true));await title(page,inlineTitle([`open:${inlineIds[0]}`],"peer-b",true));
 await runCalls(page).waitFor();expect(reads.filter(({action})=>action._ === "GetRun").at(-1)?.node).toBe("external");await page.reload();await title(page,inlineTitle([`open:${inlineIds[0]}`],"peer-b",true));
}),browserBudget);

for(const view of ["Seed","Sessions"])test(`Seed inline run ${view} visual states fit phones and desktop with usable controls`,()=>fresh(async page=>{
 const shots=process.env.CYBERDECK_NAV_SHOTS;
 for(const width of [390,1280])for(const scheme of ["light","dark"] as const){
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:scheme});
  for(const state of ["open","closed","missing","error","loading"]){
   inlineListStatus=state === "error" ? 503 : 200;holdInlineList=state === "loading";
   const states=[`${state === "closed" ? "closed" : "open"}:${state === "missing" ? "absent" : inlineIds[0]}`];
   await page.goto("about:blank");await page.goto(inlineHref(view,states));
   await title(page,state === "error" ? "Run cards unavailable · Seed · Cyberdeck" : state === "missing" ? "Run cards not found · Seed · Cyberdeck" : state === "loading" ? "Loading run cards · Seed · Cyberdeck" : inlineTitle(states));
   if(state === "open")await page.getByLabel("Run tool calls",{exact:true}).getByText("Recorded inline result 7",{exact:false}).waitFor();
   const control=state === "open" || state === "closed" ? runCalls(page) : state === "error" ? page.getByRole("button",{name:"Retry",exact:true}) : null;
   if(control && width === 390)expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
   if(shots){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,`inline-${view.toLowerCase()}-${state}-${width}-${scheme}.png`),animations:"disabled"});}
   holdInlineList=false;for(const release of pending)release();pending.clear();
  }
 }
}),browserBudget);

// Inline journal tool IDs are scoped to their containing card, independently of
// transcript tool IDs. A missing replay entry remains waiting, never a false 404.
const inlineSelection = (root = inlineIds[0], seq = 2) => JSON.stringify([root, `wf-${root}:${seq}`]);
const inlineDetailHref = (view: string, details: string[] = [inlineSelection()], inspector = "", node = "", states: string[] = [], external = false) => {
 const link = new URL(inlineHref(view,states,node,external));
 const outer = new URLSearchParams(link.hash.split("?")[1]);
 const q = view === "Seed" ? new URLSearchParams((outer.get("r") || "").split("?")[1]) : outer;
 for(const value of details)q.append("inline-detail",value);
 if(inspector)q.set("inline-tool",inspector);
 if(view === "Seed")outer.set("r",`session/inline?${q}`);
 link.hash = `${view === "Seed" ? "/seed" : "/term"}?${view === "Seed" ? outer : q}`;
 return link.href;
};
const inlineDetailTitle = (count=1, inspector=false, node="", states:string[]=[]) => `${inspector ? "Recorded tool input/output · read · " : ""}${count ? `${count} recorded tool detail${count===1?"":"s"} · ` : ""}${inlineTitle(states,node)}`;
for(const view of ["Seed","Sessions"]) {
 test(`Seed inline tools ${view} direct links, refresh and new tabs restore independent details and inspectors`,()=>fresh(async page=>{
  const selections=[inlineSelection(),inlineSelection(inlineIds[1],3)];
  await page.goto(inlineDetailHref(view,selections,inlineSelection(),"peer-b"));await title(page,inlineDetailTitle(2,true,"peer-b"));
  await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();
  expect(await page.getByTitle("Hide tool details",{exact:true}).count()).toBe(2);
  await page.reload();await title(page,inlineDetailTitle(2,true,"peer-b"));
  const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,inlineDetailTitle(2,true,"peer-b"));await tab.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();});
 }),browserBudget);
 test(`Seed inline tools ${view} history and card closure retain other selections, transcript and subscriptions`,()=>fresh(async page=>{
  await page.goto(inlineDetailHref(view,[inlineSelection(),inlineSelection(inlineIds[1],3)]));await title(page,inlineDetailTitle(2));
  const composer=page.locator("textarea").first();await composer.fill("Keep this unsent inline draft");await composer.evaluate(el=>(el as any).__owner="inline transcript");
  const subCount=subscriptions.length,readCount=reads.length,length=await page.evaluate(()=>history.length);
  await page.getByTitle("View raw tool input/output",{exact:true}).nth(1).click();await title(page,inlineDetailTitle(2,true));
  expect(await page.evaluate(()=>history.length)).toBe(length+1);
  await page.keyboard.press("Escape");await title(page,inlineDetailTitle(2));expect(await page.evaluate(()=>history.length)).toBe(length+2);
  await runCalls(page).click();await title(page,inlineDetailTitle(1,false,"",[`closed:${inlineIds[0]}`]));
  expect(inlineParams(page,view).getAll("inline-detail")).toEqual([inlineSelection(inlineIds[1],3)]);
  await page.goBack();await title(page,inlineDetailTitle(2));await page.goBack();await title(page,inlineDetailTitle(2,true));
  await page.goForward();await title(page,inlineDetailTitle(2));
  expect(await composer.inputValue()).toBe("Keep this unsent inline draft");expect(await composer.evaluate(el=>(el as any).__owner)).toBe("inline transcript");
  expect(subscriptions.length).toBe(subCount);expect(reads.slice(readCount).filter(({action})=>["GetSession","GetRun","ListRuns"].includes(action._))).toEqual([]);
 }),browserBudget);
 test(`Seed inline tools ${view} canonicalizes malformed, duplicate, bounded and conflicting details without extra history`,()=>fresh(async page=>{
  await page.goto(inlineDetailHref(view,[inlineSelection(),inlineSelection(),"[]","{}","no-json",JSON.stringify(["x","bad\u0001"]),JSON.stringify(["", "tool"])],"not-json","",[`closed:${inlineIds[0]}`]));
  await title(page,inlineDetailTitle(1,false,"",[`open:${inlineIds[0]}`]));
  expect(inlineParams(page,view).getAll("inline-detail")).toEqual([inlineSelection()]);expect(inlineParams(page,view).get("inline-tool")).toBeNull();
  const length=await page.evaluate(()=>history.length);await page.waitForTimeout(100);expect(await page.evaluate(()=>history.length)).toBe(length);
  await page.goto(inlineDetailHref(view,Array.from({length:105},(_,i)=>inlineSelection(inlineIds[0],i+1))));await title(page,"Waiting for selected recorded tools · Seed · Cyberdeck");expect(inlineParams(page,view).getAll("inline-detail").length).toBe(100);
 }),browserBudget);
 test(`Seed inline tools ${view} completed cards reveal details and missing journal entries wait honestly`,()=>fresh(async page=>{
  inlineSucceeded=true;await page.goto(inlineDetailHref(view));await title(page,inlineDetailTitle());await page.getByTitle("Hide tool details",{exact:true}).waitFor();
  await page.goto(inlineDetailHref(view,[inlineSelection(inlineIds[0],99)],inlineSelection(inlineIds[0],99)));await title(page,"Waiting for selected recorded tools · Seed · Cyberdeck");
  await page.getByRole("dialog").getByRole("status").getByText("Waiting for selected recorded tools…",{exact:true}).waitFor();
  expect(page.url()).toContain("inline-tool");await page.keyboard.press("Escape");await title(page,"Waiting for selected recorded tools · Seed · Cyberdeck");
  await page.goto(inlineDetailHref(view,[inlineSelection("absent")]));await title(page,"Run cards not found · Seed · Cyberdeck");
 }),browserBudget);
 test(`Seed inline tools ${view} delayed journal restoration does not replace composer or add history`,()=>fresh(async page=>{
  holdInlineJournal=true;await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,"Waiting for selected recorded tools · Seed · Cyberdeck");
  const length=await page.evaluate(()=>history.length),link=page.url();const composer=page.locator("textarea").first();await composer.evaluate(el=>(el as any).__owner="waiting composer");
  while(!pending.size)await page.waitForTimeout(10);holdInlineJournal=false;for(const release of pending)release();pending.clear();await title(page,inlineDetailTitle(0,true));
  await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);expect(await composer.evaluate(el=>(el as any).__owner)).toBe("waiting composer");
 }),browserBudget);
 test(`Seed inline tools ${view} workflow failures retry at the same URL and ignore late denied owners`,()=>fresh(async page=>{
  inlineWorkflow=true;detailRunStatus=503;await page.goto(inlineDetailHref(view));await title(page,"Workflow run unavailable · Seed · Cyberdeck");
  const link=page.url(),length=await page.evaluate(()=>history.length);detailRunStatus=200;await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle());await page.getByText("Recorded plan step",{exact:true}).waitFor();expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
  await page.goto("about:blank");holdDetailRun=true;detailRunStatus=403;await page.goto(inlineDetailHref(view));await title(page,"Loading workflow run · Seed · Cyberdeck");while(!pending.size)await page.waitForTimeout(10);
  holdDetailRun=false;detailRunStatus=200;await page.evaluate(link=>location.hash=new URL(link).hash,inlineDetailHref(view,[],"","peer-b"));await title(page,inlineTitle([],"peer-b"));
  for(const release of pending)release();pending.clear();await page.waitForTimeout(100);expect(await page.title()).toBe(inlineTitle([],"peer-b"));
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");expect(await page.getByRole("dialog").count()).toBe(0);
 }),browserBudget);
 test(`Seed inline tools ${view} message shares retain detail selections and the signing node`,()=>fresh(async page=>{
  await page.goto(inlineDetailHref(view,[inlineSelection()],"","peer-b"));await title(page,inlineDetailTitle(1,false,"peer-b"));await page.getByRole("button",{name:"Show markdown sent to the LLM",exact:true}).first().click();
  const outer=new URLSearchParams(new URL(await page.getByRole("dialog").locator("code").innerText()).hash.slice(7));expect(outer.get("node")).toBe("peer-b");
  expect((view === "Seed" ? new URLSearchParams(outer.get("r")!.split("?")[1]) : outer).getAll("inline-detail")).toEqual([inlineSelection()]);
 }),browserBudget);
}

for(const view of ["Seed","Sessions"]) {
 test(`Seed inline tools ${view} opening details on two cards pushes once each and keeps inspector selection separate`,()=>fresh(async page=>{
  await page.goto(inlineHref(view,[`open:${inlineIds[0]}`,`open:${inlineIds[1]}`]));await title(page,inlineTitle(["one","two"]));
  const length=await page.evaluate(()=>history.length);await page.getByTitle("Show tool details",{exact:true}).nth(1).click();await title(page,inlineDetailTitle(1,false,"",["one","two"]));expect(await page.evaluate(()=>history.length)).toBe(length+1);
  await page.getByTitle("Show tool details",{exact:true}).nth(8).click();await title(page,inlineDetailTitle(2,false,"",["one","two"]));expect(await page.evaluate(()=>history.length)).toBe(length+2);
  await page.getByTitle("View raw tool input/output",{exact:true}).nth(1).click();await title(page,inlineDetailTitle(2,true,"",["one","two"]));
  await page.goBack();await title(page,inlineDetailTitle(2,false,"",["one","two"]));await page.goBack();await title(page,inlineDetailTitle(1,false,"",["one","two"]));await page.goForward();await title(page,inlineDetailTitle(2,false,"",["one","two"]));
 }),browserBudget);
 test(`Seed inline tools ${view} selected-card and list failures preserve detail URLs and retry ownership`,()=>fresh(async page=>{
  for(const owner of ["list","card"])for(const status of [403,404,503]){
   await page.goto("about:blank");if(owner === "list")inlineListStatus=status;else inlineCardStatus=status;
   await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,`${status===403?"Access denied":`Run card${owner==="list"?"s":""} ${status===404?"not found":"unavailable"}`} · Seed · Cyberdeck`);
   const link=page.url(),length=await page.evaluate(()=>history.length);inlineListStatus=200;inlineCardStatus=200;await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle(0,true));expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
  }
 }),browserBudget);
 test(`Seed inline tools ${view} unavailable graph retry retains the selected inspector and URL`,()=>fresh(async page=>{
  inlineGraphStatus=503;await page.goto(inlineDetailHref(view,[],inlineSelection(inlineIds[0],99)));await title(page,"Recorded tools unavailable · Seed · Cyberdeck");
  const link=page.url(),length=await page.evaluate(()=>history.length);inlineGraphStatus=200;await page.getByRole("dialog").getByRole("button",{name:"Retry",exact:true}).click();await title(page,"Waiting for selected recorded tools · Seed · Cyberdeck");expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
 }),browserBudget);
 test(`Seed inline tools ${view} late journal entries cannot reopen another node or authenticated owner`,()=>fresh(async page=>{
  holdInlineJournal=true;await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,"Waiting for selected recorded tools · Seed · Cyberdeck");while(!pending.size)await page.waitForTimeout(10);
  holdInlineJournal=false;await page.evaluate(link=>location.hash=new URL(link).hash,inlineDetailHref(view,[inlineSelection(inlineIds[1],3)],"","peer-b"));await title(page,inlineDetailTitle(1,false,"peer-b"));
  for(const release of pending)release();pending.clear();await page.waitForTimeout(100);expect(await page.title()).toBe(inlineDetailTitle(1,false,"peer-b"));expect(await page.getByRole("dialog").count()).toBe(0);
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");expect(await page.getByTitle("Hide tool details",{exact:true}).count()).toBe(0);
 }),browserBudget);
 test(`Seed inline tools ${view} phone and desktop details, inspector, waiting and read errors stay usable`,()=>fresh(async page=>{
  const shots=process.env.CYBERDECK_NAV_SHOTS;
  for(const width of [390,1280])for(const scheme of ["light","dark"] as const){
   await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:scheme});
   for(const state of ["detail","inspector","waiting","loading","error"]){
    inlineWorkflow=state === "loading" || state === "error";holdDetailRun=state === "loading";detailRunStatus=state === "error"?503:200;
    await page.goto("about:blank");await page.goto(inlineDetailHref(view,state === "inspector" ? [] : [inlineSelection()],state === "inspector" ? inlineSelection() : state === "waiting" ? inlineSelection(inlineIds[0],99) : ""));
    await title(page,state === "loading" ? "Loading workflow run · Seed · Cyberdeck" : state === "error" ? "Workflow run unavailable · Seed · Cyberdeck" : state === "waiting" ? "Waiting for selected recorded tools · Seed · Cyberdeck" : inlineDetailTitle(state === "inspector" ? 0 : 1,state === "inspector"));
    if(state === "inspector")await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();
    if(await page.getByRole("dialog").count())await page.getByRole("dialog").evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
    const controls=state === "detail" ? page.getByTitle("Hide tool details",{exact:true}) : state === "inspector" || state === "waiting" ? page.getByRole("dialog").getByRole("button",{name:"Close",exact:true}) : state === "error" ? page.getByRole("button",{name:"Retry",exact:true}) : null;
    if(state === "detail" || state === "loading")await withinViewport(page,page.getByTitle("Hide tool details",{exact:true}));
    if(state === "error")await withinViewport(page,page.getByRole("button",{name:"Retry",exact:true}));
    if(controls && width === 390){const box=(await controls.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.width).toBeGreaterThanOrEqual(44);}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if(shots){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,`inline-tools-${view.toLowerCase()}-${state}-${width}-${scheme}.png`),animations:"disabled"});}
    holdDetailRun=false;for(const release of pending)release();pending.clear();
   }
  }
 }),browserBudget);
}
test("Seed inline tools external-server inspector keeps the selected signing node and recorded content",()=>fresh(async page=>{
 await page.goto(inlineDetailHref("Seed",[],inlineSelection(),"peer-b",[],true));await title(page,"Recorded tool input/output · read · external First conversation · Seed session · Peer B · Cyberdeck");
 await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();expect(reads.filter(({action})=>action._ === "GetRun").at(-1)?.node).toBe("external");await page.reload();await title(page,"Recorded tool input/output · read · external First conversation · Seed session · Peer B · Cyberdeck");
}),browserBudget);

const inlineErrorHref = (view:string, target=inlineIds[0], node="", root=inlineIds[0]) => {
 const link=new URL(inlineHref(view,[],node)),outer=new URLSearchParams(link.hash.split("?")[1]);
 const q=view === "Seed" ? new URLSearchParams(outer.get("r")!.split("?")[1]) : outer;
 q.set("inline-error",JSON.stringify([root,target]));if(view === "Seed")outer.set("r",`session/inline?${q}`);
 link.hash=`/${view === "Seed" ? "seed" : "term"}?${view === "Seed" ? outer : q}`;return link.href;
};
const inlineErrorTitle = (child=false,node="") => `Error · Recorded ${child ? "inline child" : "first run"} · Seed session${node ? " · Peer B" : ""} · Cyberdeck`;
for(const view of ["Seed","Sessions"]){
 test(`Seed inline errors ${view} root and descendant popovers restore links, refresh, fresh tabs and node`,()=>fresh(async page=>{
  inlineErrorFixture=true;
  for(const target of [inlineIds[0],inlineChildId(inlineIds[0])]){
   const child=target!==inlineIds[0];await page.goto(inlineErrorHref(view,target,"peer-b"));await title(page,inlineErrorTitle(child,"peer-b"));await page.locator("[data-seed-inline-error]").getByText(child?"INLINE_CHILD_ERROR":"INLINE_ERROR",{exact:true}).waitFor();
   await page.reload();await title(page,inlineErrorTitle(child,"peer-b"));
  }
  const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,inlineErrorTitle(true,"peer-b"));});
 }),browserBudget);
 test(`Seed inline errors ${view} keyboard, history, popover switching and outside navigation write once`,()=>fresh(async page=>{
  inlineErrorFixture=true;await page.goto(inlineHref(view));await title(page,inlineTitle());
  const composer=page.locator("textarea").first();await composer.fill("Keep this error draft");await composer.evaluate(el=>(el as any).__errorOwner="same composer");
  await page.evaluate(link=>location.hash=new URL(link).hash,inlineErrorHref(view));await title(page,inlineErrorTitle());
  await page.locator(`[data-seed-inline-error-trigger=${JSON.stringify(inlineChildId(inlineIds[0]))}]`).waitFor();
  // A graph can render errors before its journal subscription arrives. Wait
  // for both initial journals before measuring URL-only lifecycle changes.
  await runCalls(page,inlineIds[0]).waitFor();await runCalls(page,inlineIds[1]).waitFor();
  const length=await page.evaluate(()=>history.length),subCount=subscriptions.length,readCount=reads.length;
  await page.keyboard.press("Escape");await title(page,inlineTitle());await page.locator("[data-seed-inline-error]").waitFor({state:"hidden"});expect(await page.evaluate(()=>history.length)).toBe(length+1);
  const trigger=page.locator(`[data-seed-inline-error-trigger=${JSON.stringify(inlineIds[0])}]`);await trigger.focus();await page.keyboard.press("Enter");await title(page,inlineErrorTitle());expect(await page.evaluate(()=>history.length)).toBe(length+2);
  await page.goBack();await title(page,inlineTitle());await page.goForward();await title(page,inlineErrorTitle());
  const switchBefore=await page.evaluate(()=>history.length);
  await page.locator(`[data-seed-inline-error-trigger=${JSON.stringify(inlineIds[1])}]`).click({position:{x:4,y:4}});await title(page,"Error · Recorded second run · Seed session · Cyberdeck");expect(await page.evaluate(()=>history.length)).toBe(switchBefore+1);
  await page.goBack();await title(page,inlineErrorTitle());await page.goForward();await title(page,"Error · Recorded second run · Seed session · Cyberdeck");
  expect(await composer.inputValue()).toBe("Keep this error draft");expect(await composer.evaluate(el=>(el as any).__errorOwner)).toBe("same composer");expect(subscriptions.length).toBe(subCount);expect(reads.length).toBe(readCount);
  const before=await page.evaluate(()=>history.length);await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.goBack();await title(page,"Error · Recorded second run · Seed session · Cyberdeck");
 }),browserBudget);
 test(`Seed inline errors ${view} missing selection and graph failures retain URL and retry without history`,()=>fresh(async page=>{
  inlineErrorFixture=true;await page.goto(inlineErrorHref(view,"absent"));await title(page,"Run error not found · Seed · Cyberdeck");await page.getByRole("alert").getByText("The selected error is not available in this run card.",{exact:true}).waitFor();
  for(const status of [403,503]){
   await page.goto("about:blank");inlineGraphStatus=status;await page.goto(inlineErrorHref(view,inlineChildId(inlineIds[0])));await title(page,`${status===403?"Access denied":"Run error unavailable"} · Seed · Cyberdeck`);
   const link=page.url(),length=await page.evaluate(()=>history.length);inlineGraphStatus=200;await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineErrorTitle(true));expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
  }
 }),browserBudget);
 test(`Seed inline errors ${view} delayed graph errors cannot rename another node, view or locked owner`,()=>fresh(async page=>{
  inlineErrorFixture=true;holdInlineGraph=true;inlineGraphStatus=403;await page.goto(inlineErrorHref(view,inlineChildId(inlineIds[0])));await title(page,"Loading error · Recorded run · Seed session · Cyberdeck");while(!pending.size)await page.waitForTimeout(10);
  holdInlineGraph=false;inlineGraphStatus=200;await page.evaluate(link=>location.hash=new URL(link).hash,inlineErrorHref(view,inlineIds[0],"peer-b"));await title(page,inlineErrorTitle(false,"peer-b"));
  for(const release of pending)release();pending.clear();await page.waitForTimeout(100);expect(await page.title()).toBe(inlineErrorTitle(false,"peer-b"));
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");expect(await page.locator("[data-seed-inline-error]").count()).toBe(0);
 }),browserBudget);
 test(`Seed inline errors ${view} descendant tool details and inspector belong to the containing card graph`,()=>fresh(async page=>{
  inlineErrorFixture=true;const selected=JSON.stringify([inlineIds[0],`wf-${inlineChildId(inlineIds[0])}:1`]);
  await page.goto(inlineDetailHref(view,[selected],selected,"peer-b"));await title(page,inlineDetailTitle(1,true,"peer-b"));await page.getByRole("dialog").getByText("Recorded descendant result",{exact:false}).waitFor();await page.reload();await title(page,inlineDetailTitle(1,true,"peer-b"));
  expect(inlineParams(page,view).getAll("inline-detail")).toEqual([selected]);
 }),browserBudget);
 test(`Seed inline errors ${view} popovers, loading and errors fit desktop and phone with touch targets`,()=>fresh(async page=>{
  const shots=process.env.CYBERDECK_NAV_SHOTS;inlineErrorFixture=true;
  for(const width of [390,1280])for(const scheme of ["light","dark"] as const){
   await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:scheme});
   for(const state of ["root","child","loading","error","missing"]){
    holdInlineGraph=state === "loading";inlineGraphStatus=state === "error" ? 503 : 200;await page.goto("about:blank");await page.goto(inlineErrorHref(view,state === "root" ? inlineIds[0] : state === "missing" ? "absent" : inlineChildId(inlineIds[0])));
    await title(page,state === "loading" ? "Loading error · Recorded run · Seed session · Cyberdeck" : state === "error" ? "Run error unavailable · Seed · Cyberdeck" : state === "missing" ? "Run error not found · Seed · Cyberdeck" : inlineErrorTitle(state === "child"));
    const popover=page.locator("[data-seed-inline-error]");if(await popover.count())await popover.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
    if(width===390 && (state === "root" || state === "child"))expect((await page.locator(`[data-seed-inline-error-trigger=${JSON.stringify(state==="root"?inlineIds[0]:inlineChildId(inlineIds[0]))}]`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if(width===390 && state === "error")expect((await page.getByRole("button",{name:"Retry",exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(shots){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,`inline-errors-${view.toLowerCase()}-${state}-${width}-${scheme}.png`),animations:"disabled"});}
    holdInlineGraph=false;for(const release of pending)release();pending.clear();
   }
  }
 }),browserBudget);
}

for(const view of ["Seed","Sessions"])test(`Seed inline errors ${view} canonical modal precedence drops conflicting selections with replace`,()=>fresh(async page=>{
 inlineErrorFixture=true;
 const link=new URL(inlineDetailHref(view,[],inlineSelection()));const outer=new URLSearchParams(link.hash.split("?")[1]);
 const q=view==="Seed"?new URLSearchParams(outer.get("r")!.split("?")[1]):outer;q.set("inline-error",JSON.stringify([inlineIds[0],inlineIds[0]]));
 if(view==="Seed")outer.set("r",`session/inline?${q}`);link.hash=`/${view==="Seed"?"seed":"term"}?${view==="Seed"?outer:q}`;
 await page.goto(link.href);await title(page,inlineDetailTitle(0,true));expect(inlineParams(page,view).get("inline-error")).toBeNull();expect(await page.getByRole("dialog").count()).toBe(1);expect(await page.locator("[data-seed-inline-error]").count()).toBe(0);
 for(const panel of ["message","context","handoff","tool","unknown"]){
  q.set("panel",panel);if(view==="Seed")outer.set("r",`session/inline?${q}`);link.hash=`/${view==="Seed"?"seed":"term"}?${view==="Seed"?outer:q}`;
  await page.goto(link.href);await title(page,inlineDetailTitle(0,true));expect(inlineParams(page,view).get("panel")).toBeNull();expect(inlineParams(page,view).get("inline-tool")).toBe(inlineSelection());expect(inlineParams(page,view).get("inline-error")).toBeNull();
 }
 q.set("panel","prompt");if(view==="Seed")outer.set("r",`session/inline?${q}`);link.hash=`/${view==="Seed"?"seed":"term"}?${view==="Seed"?outer:q}`;
 await page.goto(link.href);await title(page,"Current system prompt · local First conversation · Seed session · Cyberdeck");expect(inlineParams(page,view).get("inline-tool")).toBeNull();expect(inlineParams(page,view).get("inline-error")).toBeNull();
 const length=await page.evaluate(()=>history.length);await page.waitForTimeout(100);expect(await page.evaluate(()=>history.length)).toBe(length);
}),browserBudget);

for(const view of ["Seed","Sessions"])test(`Seed inline tools ${view} live cards keep detail and error graph ownership on refresh`,()=>fresh(async page=>{
 inlineLive=true;inlineErrorFixture=true;const child=inlineChildId(inlineIds[0]);
 await page.goto(inlineDetailHref(view,[inlineSelection()],inlineSelection(),"peer-b"));await title(page,inlineDetailTitle(1,true,"peer-b"));await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();
 await page.reload();await title(page,inlineDetailTitle(1,true,"peer-b"));
 await page.evaluate(link=>location.hash=new URL(link).hash,inlineErrorHref(view,child,"peer-b"));await title(page,inlineErrorTitle(true,"peer-b"));await page.locator("[data-seed-inline-error]").getByText("INLINE_CHILD_ERROR",{exact:true}).waitFor();
}),browserBudget);

const withinViewport = async (page:Page, locator:any) => {
 await page.waitForFunction(element=>{if(!element)return false;const box=element.getBoundingClientRect();const parent=element.closest("[data-seed-transcript-scroll]")?.getBoundingClientRect();return box.top >= (parent?.top || 0)-1 && box.bottom <= (parent?.bottom || innerHeight)+1;},await locator.elementHandle());
};
for(const view of ["Seed","Sessions"]){
 test(`Seed inline tools ${view} selected read errors restore visibly on phone, reload, new tabs and history`,()=>fresh(async page=>{
  await page.setViewportSize({width:390,height:900});
  for(const owner of ["list","card"]){
   if(owner==="list")inlineListStatus=503;else inlineCardStatus=503;
   await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,`${owner==="list"?"Run cards":"Run card"} unavailable · Seed · Cyberdeck`);await withinViewport(page,page.getByRole("button",{name:"Retry",exact:true}));
   inlineListStatus=200;inlineCardStatus=200;await page.goto("about:blank");
  }
  inlineWorkflow=true;detailRunStatus=503;
  await page.goto(inlineDetailHref(view));await title(page,"Workflow run unavailable · Seed · Cyberdeck");const retry=page.getByRole("button",{name:"Retry",exact:true});await withinViewport(page,retry);
  const link=page.url();await page.reload();await title(page,"Workflow run unavailable · Seed · Cyberdeck");await withinViewport(page,retry);
  await fresh(async tab=>{await tab.setViewportSize({width:390,height:900});inlineWorkflow=true;detailRunStatus=503;await tab.goto(link);await title(tab,"Workflow run unavailable · Seed · Cyberdeck");await withinViewport(tab,tab.getByRole("button",{name:"Retry",exact:true}));});
  inlineWorkflow=true;detailRunStatus=503;
  await page.evaluate(url=>location.hash=new URL(url).hash,inlineDetailHref(view,[]));await title(page,inlineTitle());await page.goBack();await title(page,"Workflow run unavailable · Seed · Cyberdeck");await withinViewport(page,retry);
 }),browserBudget);
 test(`Seed inline tools ${view} revealed selections pause following and retain manual scroll, composer and subscriptions`,()=>fresh(async page=>{
  await page.setViewportSize({width:390,height:900});await page.goto(inlineDetailHref(view));await title(page,inlineDetailTitle());
  const detail=page.getByTitle("Hide tool details",{exact:true});await withinViewport(page,detail);await runCalls(page,inlineIds[1]).waitFor();
  const scroller=page.locator("[data-seed-transcript-scroll]");
  const append = (callSeq:number) => {for(const [socket,data] of runSockets)if(data.key===`runs/${inlineIds[0]}`){
   socket.send(JSON.stringify({_:"append",key:data.key,runId:inlineIds[0],seq:callSeq*2-1,createdAt:callSeq*2-1,entry:{kind:"call",op:"tool",callSeq,tool:"read",input:{path:"Late recorded input"}}}));
   socket.send(JSON.stringify({_:"append",key:data.key,runId:inlineIds[0],seq:callSeq*2,createdAt:callSeq*2,entry:{kind:"result",callSeq,status:"succeeded",output:{content:"Late recorded output"}}}));
  }};
  append(8);await page.waitForTimeout(150);await withinViewport(page,detail);
  await scroller.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event("scroll",{bubbles:true}));});
  const link=page.url(),length=await page.evaluate(()=>history.length),readCount=reads.length,subCount=subscriptions.length;
  const composer=page.locator("textarea").first();await composer.evaluate(el=>(el as any).__selectionOwner="same composer");
  append(9);
  await page.waitForTimeout(150);expect(await scroller.evaluate(el=>el.scrollTop)).toBe(0);expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);expect(reads.slice(readCount).filter(({action})=>["GetSession","GetRun","ListRuns"].includes(action._))).toEqual([]);expect(subscriptions.length).toBe(subCount);expect(await composer.evaluate(el=>(el as any).__selectionOwner)).toBe("same composer");
  await page.evaluate(url=>location.hash=new URL(url).hash,inlineDetailHref(view,[inlineSelection(inlineIds[1],3)]));await title(page,inlineDetailTitle());await withinViewport(page,page.getByTitle("Hide tool details",{exact:true}));
  await page.goBack();await title(page,inlineDetailTitle());await withinViewport(page,page.getByTitle("Hide tool details",{exact:true}));
 }),browserBudget);
}


for(const view of ["Seed","Sessions"])test(`Seed older run ${view} restores a selected card beyond the latest fifty roots`,()=>fresh(async page=>{
 inlineWindowed=true;inlineSucceeded=true;
 const selected=[`open:${inlineIds[0]}`];
 await page.goto(inlineHref(view,selected,"peer-b"));await title(page,inlineTitle(selected,"peer-b"));
 await runCalls(page).waitFor();await page.getByText("Recorded inline result 7",{exact:false}).waitFor();
 expect(reads.filter(row=>row.action._==="ListRuns" && row.action.sessionId==="inline").at(-1)?.node).toBe("peer-b");
 await page.reload();await title(page,inlineTitle(selected,"peer-b"));await runCalls(page).waitFor();
 const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,inlineTitle(selected,"peer-b"));await runCalls(tab).waitFor();});
}),browserBudget);

for(const view of ["Seed","Sessions"]){
 test(`Seed older run ${view} restores multiple older roots and independent recorded details`,()=>fresh(async page=>{
  inlineWindowed=true;inlineSucceeded=true;
  const details=[inlineSelection(),inlineSelection(archivedInlineId,3)];
  await page.goto(inlineDetailHref(view,details,"","peer-b"));await title(page,inlineDetailTitle(2,false,"peer-b"));
  expect(await page.getByTitle("Hide tool details",{exact:true}).count()).toBe(2);
  for(const id of [inlineIds[0],archivedInlineId])expect(await runCalls(page,id).getAttribute("aria-expanded")).toBe("true");
  expect(reads.filter(row=>row.action._==="GetRun" && row.action.runId===archivedInlineId).at(-1)?.node).toBe("peer-b");
  await page.reload();await title(page,inlineDetailTitle(2,false,"peer-b"));expect(await page.getByTitle("Hide tool details",{exact:true}).count()).toBe(2);
 }),browserBudget);
 test(`Seed older run ${view} closing and history keep recovered cards, composer and journal owners`,()=>fresh(async page=>{
  inlineWindowed=true;inlineComposerAvailable=true;
  await page.goto(inlineHref(view));await title(page,inlineTitle());
  const composer=page.locator('[contenteditable="true"]').first();await composer.fill("Keep the older run draft");await composer.evaluate(el=>(el as any).__olderOwner="same composer");
  await page.evaluate(url=>location.hash=new URL(url).hash,inlineDetailHref(view,[],inlineSelection()));await title(page,inlineDetailTitle(0,true));
  await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();
  const length=await page.evaluate(()=>history.length),readCount=reads.length,subCount=subscriptions.length;
  await page.keyboard.press("Escape");await title(page,inlineTitle());await page.getByRole("dialog").waitFor({state:"hidden"});
  await runCalls(page).waitFor({state:"hidden"});expect(await runCalls(page).count()).toBe(1);expect(await page.evaluate(()=>history.length)).toBe(length+1);
  const baseLink=page.url(),visibleCards=await page.locator('[data-seed-inline-card]:visible').evaluateAll(elements=>elements.map(el=>el.getAttribute("data-seed-inline-card")));
  expect(visibleCards).toEqual([inlineIds[1]]);
  await page.goBack();await title(page,inlineDetailTitle(0,true));await page.goForward();await title(page,inlineTitle());await runCalls(page).waitFor({state:"hidden"});
  await page.evaluate(url=>location.hash=new URL(url).hash,inlineHref(view,[`open:${inlineIds[0]}`]));await title(page,inlineTitle([`open:${inlineIds[0]}`]));await runCalls(page).waitFor();
  expect(await composer.innerText()).toContain("Keep the older run draft");expect(await composer.evaluate(el=>(el as any).__olderOwner)).toBe("same composer");
  expect(subscriptions.length).toBe(subCount);expect(reads.slice(readCount).filter(row=>["GetSession","GetRun","ListRuns"].includes(row.action._))).toEqual([]);
  await fresh(async tab=>{await tab.goto(baseLink);await title(tab,inlineTitle());await runCalls(tab,inlineIds[1]).waitFor();expect(await tab.locator('[data-seed-inline-card]:visible').evaluateAll(elements=>elements.map(el=>el.getAttribute("data-seed-inline-card")))).toEqual(visibleCards);expect(await runCalls(tab).count()).toBe(0);});
 }),browserBudget);
 test(`Seed older run ${view} root and descendant error links restore the older graph and title`,()=>fresh(async page=>{
  inlineWindowed=true;inlineErrorFixture=true;
  for(const target of [inlineIds[0],inlineChildId(inlineIds[0])]){
   await page.goto(inlineErrorHref(view,target,"peer-b"));await title(page,inlineErrorTitle(target!==inlineIds[0],"peer-b"));
   await page.locator("[data-seed-inline-error]").getByText(target===inlineIds[0]?"INLINE_ERROR":"INLINE_CHILD_ERROR",{exact:true}).waitFor();
   await page.reload();await title(page,inlineErrorTitle(target!==inlineIds[0],"peer-b"));
  }
 }),browserBudget);
 test(`Seed older run ${view} manual scrolling while an older card loads survives its late arrival`,()=>fresh(async page=>{
  inlineWindowed=true;await page.setViewportSize({width:390,height:900});
  await page.goto(inlineHref(view,[`open:${inlineIds[1]}`]));await title(page,inlineTitle([`open:${inlineIds[1]}`]));
  await page.getByText("Recorded inline result 7",{exact:false}).waitFor();
  holdInlineCard=true;
  await page.evaluate(url=>location.hash=new URL(url).hash,inlineHref(view,[`open:${inlineIds[0]}`,`open:${inlineIds[1]}`]));await title(page,"Loading run cards · Seed · Cyberdeck");
  while(!pending.size)await page.waitForTimeout(10);
  const scroller=page.locator("[data-seed-transcript-scroll]");
  await scroller.evaluate(el=>{el.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:-20}));el.scrollTop=0;el.dispatchEvent(new Event("scroll",{bubbles:true}));});
  holdInlineCard=false;for(const release of pending)release();pending.clear();await title(page,inlineTitle(["one","two"]));await runCalls(page).waitFor();
  await page.waitForTimeout(150);expect(await scroller.evaluate(el=>el.scrollTop)).toBe(0);
 }),browserBudget);
 test(`Seed older run ${view} a failed refresh keeps its recorded card, draft and journal until read-only retry`,()=>fresh(async page=>{
  inlineWindowed=true;inlineComposerAvailable=true;
  await page.goto(inlineHref(view,[`open:${inlineIds[0]}`]));await title(page,inlineTitle([`open:${inlineIds[0]}`]));
  await page.getByText("Recorded inline result 7",{exact:false}).waitFor();
  const composer=page.locator('[contenteditable="true"]').first();await composer.fill("Keep the refresh draft");await composer.evaluate(el=>(el as any).__retryOwner="same editor");
  const subCount=subscriptions.length,link=page.url(),length=await page.evaluate(()=>history.length);
  inlineCardStatus=503;
  for(const [socket,owner] of runSockets)if(owner.key===`runs/${inlineIds[0]}`)socket.send(JSON.stringify({_:"change",key:owner.key,value:inlineRun(inlineIds[0],"local")}));
  await title(page,"Run cards unavailable · Seed · Cyberdeck");await runCalls(page).waitFor();
  expect(await page.getByRole("button",{name:"Retry",exact:true}).count()).toBe(1);
  inlineCardStatus=200;await page.getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineTitle([`open:${inlineIds[0]}`]));
  expect(await composer.innerText()).toContain("Keep the refresh draft");expect(await composer.evaluate(el=>(el as any).__retryOwner)).toBe("same editor");expect(subscriptions.length).toBe(subCount);
  expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
 }),browserBudget);
 test(`Seed older run ${view} denied, missing and unavailable reads retry only the selected root`,()=>fresh(async page=>{
  inlineWindowed=true;
  for(const [status,malformed,label] of [[403,"","Access denied"],[404,"","Run cards not found"],[503,"","Run cards unavailable"],[200,"missing","Run cards not found"]] as const){
   inlineCardStatus=status;malformedInlineCard=malformed;
   await page.goto("about:blank");await page.goto(inlineHref(view,[`closed:${inlineIds[0]}`]));await title(page,`${label} · Seed · Cyberdeck`);
   const link=page.url(),length=await page.evaluate(()=>history.length),before=reads.length;
   inlineCardStatus=200;malformedInlineCard="";await page.getByRole("button",{name:"Retry",exact:true}).first().click();
   await title(page,inlineTitle([`closed:${inlineIds[0]}`]));await runCalls(page).waitFor();
   expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
   expect(reads.slice(before).filter(row=>row.action._==="GetSession" || row.action._==="ListRuns" && row.action.sessionId)).toEqual([]);
  }
 }),browserBudget);
 test(`Seed older run ${view} rejects foreign roots, child runs and malformed recorded content before graph reads`,()=>fresh(async page=>{
  inlineWindowed=true;
  for(const malformed of ["owner","account","id","root","parent","depth","plan","time"]){
   malformedInlineCard=malformed;await page.goto("about:blank");const before=reads.length;
   await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,"Run cards unavailable · Seed · Cyberdeck");
   expect(reads.slice(before).filter(row=>row.action._==="ListRuns" && row.action.rootRunId===inlineIds[0])).toEqual([]);
   expect(await page.getByRole("dialog").count()).toBe(0);expect(await runCalls(page).count()).toBe(0);
   const link=page.url(),length=await page.evaluate(()=>history.length);malformedInlineCard="";
   await page.getByRole("button",{name:"Retry",exact:true}).first().click();await title(page,inlineDetailTitle(0,true));
   expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
  }
 }),browserBudget);
 test(`Seed older run ${view} rapid node and primary navigation ignore late selected-root outcomes`,()=>fresh(async page=>{
  inlineWindowed=true;holdInlineCard=true;inlineCardStatus=403;
  await page.goto(inlineDetailHref(view,[],inlineSelection(),"peer-a"));await title(page,"Loading run cards · Seed · Peer A · Cyberdeck");
  while(!pending.size)await page.waitForTimeout(10);holdInlineCard=false;inlineCardStatus=200;
  await page.evaluate(url=>location.hash=new URL(url).hash,inlineDetailHref(view,[],inlineSelection(),"peer-b"));await title(page,inlineDetailTitle(0,true,"peer-b"));
  for(const release of pending)release();pending.clear();await page.waitForTimeout(100);expect(await page.title()).toBe(inlineDetailTitle(0,true,"peer-b"));
  await page.keyboard.press("Escape");await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");
  expect(await page.getByRole("dialog").count()).toBe(0);
 }),browserBudget);
 test(`Seed older run ${view} authentication lock drops pending recovered content and owns the title`,()=>fresh(async page=>{
  inlineWindowed=true;holdInlineCard=true;
  await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,"Loading run cards · Seed · Cyberdeck");
  while(!pending.size)await page.waitForTimeout(10);
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
  holdInlineCard=false;for(const release of pending)release();pending.clear();await page.waitForTimeout(100);
  expect(await page.title()).toBe("Locked · Cyberdeck");expect(await runCalls(page).count()).toBe(0);expect(await page.getByRole("dialog").count()).toBe(0);
 }),browserBudget);
 test(`Seed older run ${view} unavailable session and list reads do not authorize selected-root lookups`,()=>fresh(async page=>{
  inlineWindowed=true;
  for(const owner of ["session","list"]){
   if(owner==="session")sessionReadStatus=403;else inlineListStatus=403;
   await page.goto("about:blank");const before=reads.length;
   await page.goto(inlineHref(view,[`open:${inlineIds[0]}`]));await title(page,"Access denied · Seed · Cyberdeck");
   expect(reads.slice(before).filter(row=>row.action._==="GetRun" && row.action.runId===inlineIds[0])).toEqual([]);
   sessionReadStatus=200;inlineListStatus=200;
  }
 }),browserBudget);
 test(`Seed older run ${view} a live older root restores without changing the current pinned run`,()=>fresh(async page=>{
  inlineWindowed=true;inlineLive=true;
  await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,inlineDetailTitle(0,true));
  await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();
  await page.reload();await title(page,inlineDetailTitle(0,true));expect(reads.filter(row=>row.action._==="GetRun" && row.action.runId===inlineIds[0]).length).toBeGreaterThanOrEqual(2);
 }),browserBudget);
 test(`Seed older run ${view} restored, loading and failed selections fit phone and desktop`,()=>fresh(async page=>{
  inlineWindowed=true;const shots=process.env.CYBERDECK_NAV_SHOTS;
  for(const width of [390,1280])for(const scheme of ["light","dark"] as const){
   await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:scheme});
   for(const state of ["populated","cleared","loading","error","missing"]){
    inlineCardStatus=state==="error"?503:state==="missing"?404:200;holdInlineCard=state==="loading";
    await page.goto("about:blank");await page.goto(inlineHref(view,[`open:${inlineIds[0]}`]));
    await title(page,(state==="populated" || state==="cleared")?inlineTitle([`open:${inlineIds[0]}`]):`${state==="loading"?"Loading run cards":state==="error"?"Run cards unavailable":"Run cards not found"} · Seed · Cyberdeck`);
    if(state==="cleared"){await runCalls(page).waitFor();await page.evaluate(url=>location.hash=new URL(url).hash,inlineHref(view));await title(page,inlineTitle());await runCalls(page).waitFor({state:"hidden"});}
    const control=state==="cleared"?runCalls(page,inlineIds[1]):state==="populated"?runCalls(page):state==="loading"?page.getByText("Loading selected run cards…",{exact:true}):page.getByRole("button",{name:"Retry",exact:true}).first();
    await withinViewport(page,control);if(width===390 && state!=="loading")expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(shots){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,`older-${view.toLowerCase()}-${state}-${width}-${scheme}.png`),animations:"disabled"});}
    holdInlineCard=false;for(const release of pending)release();pending.clear();
   }
  }
 }),browserBudget);
}
test("Seed older run external-server restoration keeps its signing node and canonical URL",()=>fresh(async page=>{
 inlineWindowed=true;
 await page.goto(inlineDetailHref("Seed",[],inlineSelection(),"peer-b",[],true));await title(page,"Recorded tool input/output · read · external First conversation · Seed session · Peer B · Cyberdeck");
 expect(reads.filter(row=>row.action._==="GetRun" && row.action.runId===inlineIds[0]).at(-1)?.node).toBe("external");
 const link=page.url();await page.reload();await title(page,"Recorded tool input/output · read · external First conversation · Seed session · Peer B · Cyberdeck");expect(page.url()).toBe(link);
}),browserBudget);


for(const view of ["Seed","Sessions"])test(`Seed older run ${view} authorized collaborators restore roots owned by the displayed session account`,()=>fresh(async page=>{
 inlineWindowed=true;inlineShared=true;inlineComposerAvailable=true;
 await page.goto(inlineDetailHref(view,[],inlineSelection(),"peer-b"));await title(page,inlineDetailTitle(0,true,"peer-b"));
 await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).waitFor();
 await page.keyboard.press("Escape");await title(page,inlineTitle([],"peer-b"));await page.locator('[contenteditable="true"]').first().waitFor();
 await page.reload();await title(page,inlineTitle([],"peer-b"));
 // The displayed owner differs from the signing identity; authorization remains
 // the server's job. An unrelated owner in a root response is still rejected.
 malformedInlineCard="account";await page.goto("about:blank");await page.goto(inlineDetailHref(view,[],inlineSelection(),"peer-b"));await title(page,"Run cards unavailable · Seed · Peer B · Cyberdeck");
}),browserBudget);


for(const view of ["Seed","Sessions"])test(`Seed older run ${view} delayed transcript layout keeps a selected read visible until manual scrolling`,()=>fresh(async page=>{
 inlineWindowed=true;inlineWorkflow=true;detailRunStatus=503;await page.setViewportSize({width:390,height:900});
 await page.goto(inlineDetailHref(view));await title(page,"Workflow run unavailable · Seed · Cyberdeck");
 const retry=page.getByRole("button",{name:"Retry",exact:true}),scroller=page.locator("[data-seed-transcript-scroll]");await withinViewport(page,retry);
 const link=page.url(),length=await page.evaluate(()=>history.length),subCount=subscriptions.length;
 // A late formatted block can change layout before the selected read, even
 // after its journal and error response have arrived.
 await scroller.evaluate(el=>{const spacer=document.createElement("div");spacer.dataset.layoutFixture="";spacer.style.height="240px";el.firstElementChild!.prepend(spacer);});
 await withinViewport(page,retry);
 await scroller.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event("scroll",{bubbles:true}));});await page.waitForTimeout(50);
 await page.locator('[data-layout-fixture]').evaluate(el=>{(el as HTMLElement).style.height="480px";});await page.waitForTimeout(100);
 expect(await scroller.evaluate(el=>el.scrollTop)).toBe(0);expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);expect(subscriptions.length).toBe(subCount);
}),browserBudget);

async function waitInlineFixture(ready:()=>boolean){const deadline=Date.now()+8000;while(!ready()){if(Date.now()>deadline)throw new Error("Inline fixture did not become ready");await new Promise(resolve=>setTimeout(resolve,10));}}
for(const view of ["Seed","Sessions"])test(`Seed inline journal ${view} interrupted selected tools restore errors on direct links, reload and new tabs`,()=>fresh(async page=>{
 runStreamMode="error";runStreamTarget=`runs/${inlineIds[0]}`;
 await page.goto(inlineDetailHref(view,[],inlineSelection(),"peer-a"));
 if(process.env.CYBERDECK_NAV_BASELINE){await page.waitForTimeout(300);await page.screenshot({path:process.env.CYBERDECK_NAV_BASELINE});}
 await title(page,"Run updates unavailable · Seed · Peer A · Cyberdeck");
 await page.getByRole("dialog").getByText("Run updates interrupted",{exact:true}).waitFor();
 expect(await page.getByText("Waiting for selected recorded tools…",{exact:true}).count()).toBe(0);
 const link=page.url();await page.reload();await title(page,"Run updates unavailable · Seed · Peer A · Cyberdeck");
 await fresh(async tab=>{runStreamMode="error";runStreamTarget=`runs/${inlineIds[0]}`;await tab.goto(link);await title(tab,"Run updates unavailable · Seed · Peer A · Cyberdeck");});
}),browserBudget);
const inlineJournalNotice=(page:Page,root=inlineIds[0])=>page.locator(`[data-seed-inline-journal=${JSON.stringify(root)}]`);
const inlineJournalTitle=(node="",pending=false)=>`${pending ? "Reconnecting run updates" : "Run updates unavailable"} · Seed${node ? ` · ${node==="peer-a"?"Peer A":"Peer B"}` : ""} · Cyberdeck`;
const inlineInterrupt=(root=inlineIds[0],node="local",message="Recorded run updates interrupted")=>{
 for(const [socket,owner]of runSockets)if(owner.node===node && owner.key===`runs/${root}`)socket.send(JSON.stringify({_:"error",message}));
};
for(const view of ["Seed","Sessions"]){
 test(`Seed inline journal ${view} retry reconnects only the selected card while retaining history, composer and recorded tools`,()=>fresh(async page=>{
  await page.goto(inlineDetailHref(view,[inlineSelection(),inlineSelection(inlineIds[1],3)]));await title(page,inlineDetailTitle(2));
  await page.getByText("Recorded inline result 3",{exact:false}).first().waitFor();
  const composer=page.locator("textarea").first();await composer.fill("Keep this inline connection draft");await composer.evaluate(el=>(el as any).__journalOwner="same composer");
  const count=await page.evaluate(()=>history.length),subCount=subscriptions.length,readCount=reads.length,link=page.url();
  inlineInterrupt();await title(page,inlineJournalTitle());await inlineJournalNotice(page).getByRole("button",{name:"Retry",exact:true}).waitFor();
  expect(await page.getByText("Recorded inline result 2",{exact:false}).count()).toBeGreaterThan(0);
  runStreamTarget=`runs/${inlineIds[0]}`;runStreamMode="silent";
  await inlineJournalNotice(page).getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineJournalTitle("",true));
  await inlineJournalNotice(page).getByText("Reconnecting run updates…",{exact:true}).waitFor();
  await waitInlineFixture(()=>subscriptions.length===subCount+1);
  for(const[socket,owner]of runSockets)if(owner.key===`runs/${inlineIds[0]}`)socket.send(JSON.stringify({_:"subscribed",key:"runs/unrelated",accountId:account}));
  await page.waitForTimeout(50);expect(await page.title()).toBe(inlineJournalTitle("",true));
  for(const[socket,owner]of runSockets)if(owner.key===`runs/${inlineIds[0]}`)socket.send(JSON.stringify({_:"subscribed",key:owner.key,accountId:account}));
  await title(page,inlineDetailTitle(2));expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
  expect(await composer.inputValue()).toBe("Keep this inline connection draft");expect(await composer.evaluate(el=>(el as any).__journalOwner)).toBe("same composer");
  expect(subscriptions.length).toBe(subCount+1);expect(reads.length).toBe(readCount);
  await runCalls(page,inlineIds[1]).click();await title(page,inlineDetailTitle(1,false,"",[`closed:${inlineIds[1]}`]));
  await page.goBack();await title(page,inlineDetailTitle(2));await page.goForward();await title(page,inlineDetailTitle(1,false,"",[`closed:${inlineIds[1]}`]));
  expect(subscriptions.length).toBe(subCount+1);expect(reads.length).toBe(readCount);
 }),browserBudget);
 test(`Seed inline journal ${view} interrupted inspectors retain their content and recover within the dialog`,()=>fresh(async page=>{
  await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,inlineDetailTitle(0,true));
  const dialog=page.getByRole("dialog");await dialog.getByText("Recorded inline result 2",{exact:false}).first().waitFor();await dialog.evaluate(el=>(el as any).__journalInspector="retained");
  const link=page.url(),count=await page.evaluate(()=>history.length),before=subscriptions.length;
  inlineInterrupt();await title(page,inlineJournalTitle());
  expect(await dialog.getByText("Recorded inline result 2",{exact:false}).count()).toBe(1);
  await dialog.getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle(0,true));
  expect(await dialog.evaluate(el=>(el as any).__journalInspector)).toBe("retained");expect(subscriptions.length).toBe(before+1);
  expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
 }),browserBudget);
 test(`Seed inline journal ${view} error popovers retain recorded failures and offer an owned retry`,()=>fresh(async page=>{
  inlineErrorFixture=true;await page.goto(inlineErrorHref(view,inlineChildId(inlineIds[0])));await title(page,inlineErrorTitle(true));
  const popover=page.locator(`[data-seed-inline-error=${JSON.stringify(inlineChildId(inlineIds[0]))}]`);await popover.getByText("Recorded inline child error",{exact:false}).waitFor();
  const link=page.url(),count=await page.evaluate(()=>history.length);inlineInterrupt();await title(page,inlineJournalTitle());
  await popover.getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineErrorTitle(true));
  await popover.getByText("Recorded inline child error",{exact:false}).waitFor();expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
 }),browserBudget);
 test(`Seed inline journal ${view} empty failed lists show an interruption instead of waiting for tools`,()=>fresh(async page=>{
  runStreamMode="error";runStreamTarget=`runs/${inlineIds[0]}`;await page.goto(inlineHref(view,[`open:${inlineIds[0]}`]));await title(page,inlineJournalTitle());
  await page.getByText("Recorded tool calls could not be loaded.",{exact:true}).waitFor();
  expect(await page.getByText("Waiting for recorded tool calls…",{exact:true}).count()).toBe(0);
  const link=page.url(),count=await page.evaluate(()=>history.length);runStreamMode="";
  await inlineJournalNotice(page).getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineTitle([`open:${inlineIds[0]}`]));
  await page.getByText("Recorded inline result 2",{exact:false}).first().waitFor();expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
 }),browserBudget);
 test(`Seed inline journal ${view} interrupted sockets reconnect without replacing recorded selections`,()=>fresh(async page=>{
  runStreamMode="close";runStreamTarget=`runs/${inlineIds[0]}`;await page.goto(inlineDetailHref(view,[inlineSelection()]));await title(page,inlineJournalTitle());
  const link=page.url(),count=await page.evaluate(()=>history.length);runStreamMode="";
  await title(page,inlineDetailTitle(1));await page.getByText("Recorded inline result 2",{exact:false}).first().waitFor();
  expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
 }),browserBudget);
 test(`Seed inline journal ${view} malformed updates are visible and retry at the selected URL`,()=>fresh(async page=>{
  runStreamMode="malformed";runStreamTarget=`runs/${inlineIds[0]}`;await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,inlineJournalTitle());
  await page.getByRole("dialog").getByText("invalid message",{exact:false}).waitFor();const link=page.url();runStreamMode="";
  await page.getByRole("dialog").getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle(0,true));expect(page.url()).toBe(link);
 }),browserBudget);
 test(`Seed inline journal ${view} missing acknowledgements time out and retry without replaying commands`,()=>fresh(async page=>{
  await page.clock.install();runStreamMode="silent";runStreamTarget=`runs/${inlineIds[0]}`;await page.goto(inlineDetailHref(view,[],inlineSelection()));
  await waitInlineFixture(()=>[...runSockets.values()].some(owner=>owner.key===runStreamTarget));
  const link=page.url(),count=await page.evaluate(()=>history.length);await page.clock.fastForward(16000);await title(page,inlineJournalTitle());
  runStreamMode="";await page.getByRole("dialog").getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle(0,true));
  expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);
 }),browserBudget);
 test(`Seed inline journal ${view} signing denials belong to the selected node and retry without locking`,()=>fresh(async page=>{
  let deny=true;
  await page.route(/\/api\/seed-agents(?:\/nodes\/[^/]+)?\/sign$/,async route=>{
   const envelope:any=cbor.decode(new Uint8Array(Buffer.from(route.request().postDataJSON().data,"base64")));
   if(deny && envelope.action?._==="Subscribe" && envelope.action.key===`runs/${inlineIds[0]}`)return route.fulfill({status:403,json:{error:"Fixture run signing denied"}});
   return route.continue();
  });
  await page.goto(inlineDetailHref(view,[],inlineSelection(),"peer-b"));await title(page,"Access denied · Seed · Peer B · Cyberdeck");
  const link=page.url();deny=false;await page.getByRole("dialog").getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle(0,true,"peer-b"));expect(page.url()).toBe(link);
 }),browserBudget);
 test(`Seed inline journal ${view} late signing failures cannot rename another node or primary view`,()=>fresh(async page=>{
  let release:(()=>void)|undefined;
  await page.route(/\/api\/seed-agents(?:\/nodes\/[^/]+)?\/sign$/,async route=>{
   const envelope:any=cbor.decode(new Uint8Array(Buffer.from(route.request().postDataJSON().data,"base64")));
   if(!release && envelope.action?._==="Subscribe" && envelope.action.key===`runs/${inlineIds[0]}`){await new Promise<void>(resolve=>release=resolve);return route.fulfill({status:403,json:{error:"Fixture late inline signing denial"}});}
   return route.continue();
  });
  await page.goto(inlineDetailHref(view,[],inlineSelection(),"peer-a"));await waitInlineFixture(()=>!!release);
  await page.evaluate(url=>location.hash=new URL(url).hash,inlineDetailHref(view,[],inlineSelection(),"peer-b"));await title(page,inlineDetailTitle(0,true,"peer-b"));release!();
  await page.waitForTimeout(100);expect(await page.title()).toBe(inlineDetailTitle(0,true,"peer-b"));
  await page.keyboard.press("Escape");await page.getByTestId("nav-data").click();await title(page,"Data · Cyberdeck");inlineInterrupt(inlineIds[0],"peer-a");await page.waitForTimeout(100);expect(await page.title()).toBe("Data · Cyberdeck");
 }),browserBudget);
 test(`Seed inline journal ${view} multiple selected cards keep independent errors and retries`,()=>fresh(async page=>{
  await page.goto(inlineDetailHref(view,[inlineSelection(),inlineSelection(inlineIds[1],3)]));await title(page,inlineDetailTitle(2));await page.getByText("Recorded inline result 3",{exact:false}).first().waitFor();
  const before=subscriptions.length,link=page.url();inlineInterrupt();inlineInterrupt(inlineIds[1]);await title(page,inlineJournalTitle());
  await inlineJournalNotice(page,inlineIds[1]).getByRole("button",{name:"Retry",exact:true}).click();await inlineJournalNotice(page,inlineIds[1]).waitFor({state:"hidden"});expect(await page.title()).toBe(inlineJournalTitle());
  await inlineJournalNotice(page).getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle(2));expect(subscriptions.length).toBe(before+2);expect(page.url()).toBe(link);
 }),browserBudget);
 test(`Seed inline journal ${view} hidden recovered cards retain journals without renaming cleared URLs`,()=>fresh(async page=>{
  inlineWindowed=true;await page.goto(inlineDetailHref(view));await title(page,inlineDetailTitle());await page.getByText("Recorded inline result 2",{exact:false}).first().waitFor();
  const before=subscriptions.length;inlineInterrupt();await title(page,inlineJournalTitle());
  await page.evaluate(url=>location.hash=new URL(url).hash,inlineHref(view));await title(page,inlineTitle());inlineInterrupt();await page.waitForTimeout(100);expect(await page.title()).toBe(inlineTitle());
  await page.goBack();await title(page,inlineJournalTitle());await inlineJournalNotice(page).getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle());expect(subscriptions.length).toBe(before+1);
 }),browserBudget);
 test(`Seed inline journal ${view} locked authentication releases subscriptions and owns late outcomes`,()=>fresh(async page=>{
  await page.goto(inlineDetailHref(view));await title(page,inlineDetailTitle());inlineInterrupt();await title(page,inlineJournalTitle());
  await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));await page.evaluate(()=>location.hash="#/files");await title(page,"Locked · Cyberdeck");
  inlineInterrupt();await page.waitForTimeout(100);expect(await page.title()).toBe("Locked · Cyberdeck");expect(await inlineJournalNotice(page).count()).toBe(0);
 }),browserBudget);
 test(`Seed inline journal ${view} live and completed recovered cards share the same interruption ownership`,()=>fresh(async page=>{
  inlineWindowed=true;inlineLive=true;await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,inlineDetailTitle(0,true));
  await page.getByRole("dialog").getByText("Recorded inline result 2",{exact:false}).first().waitFor();const link=page.url();inlineInterrupt();await title(page,inlineJournalTitle());
  await page.getByRole("dialog").getByRole("button",{name:"Retry",exact:true}).click();await title(page,inlineDetailTitle(0,true));expect(page.url()).toBe(link);
 }),browserBudget);
}
test("Seed inline journal external servers keep the signing node independent of the journal owner",()=>fresh(async page=>{
 runStreamMode="error";runStreamTarget=`runs/${inlineIds[0]}`;await page.goto(inlineDetailHref("Seed",[],inlineSelection(),"peer-b",[],true));await title(page,inlineJournalTitle("peer-b"));
 const link=page.url();runStreamMode="";await page.getByRole("dialog").getByRole("button",{name:"Retry",exact:true}).click();
 await title(page,"Recorded tool input/output · read · external First conversation · Seed session · Peer B · Cyberdeck");expect(page.url()).toBe(link);
}),browserBudget);
for(const view of ["Seed","Sessions"])test(`Seed inline journal ${view} waiting, error, reconnect and recovered reads fit phone and desktop`,()=>fresh(async page=>{
 const shots=process.env.CYBERDECK_NAV_SHOTS;
 for(const width of [390,1280])for(const scheme of ["light","dark"] as const){
  await page.goto("about:blank");await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:scheme});
  holdInlineJournal=true;runStreamMode="";runStreamTarget=`runs/${inlineIds[0]}`;
  await page.goto(inlineDetailHref(view,[],inlineSelection()));await title(page,"Waiting for selected recorded tools · Seed · Cyberdeck");
  const dialog=page.getByRole("dialog");await withinViewport(page,dialog.getByText("Waiting for selected recorded tools…",{exact:true}));
  if(shots)await page.screenshot({path:join(shots,`inline-journal-${view.toLowerCase()}-waiting-${width}-${scheme}.png`),animations:"disabled"});
  await waitInlineFixture(()=>pending.size>0);inlineInterrupt();await title(page,inlineJournalTitle());
  const retry=dialog.getByRole("button",{name:"Retry",exact:true});await withinViewport(page,retry);
  await dialog.evaluate(async el=>{await Promise.all(el.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));});
  if(width===390)expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if(shots)await page.screenshot({path:join(shots,`inline-journal-${view.toLowerCase()}-error-${width}-${scheme}.png`),animations:"disabled"});
  const beforeRetry=subscriptions.filter(key=>key===runStreamTarget).length;
  runStreamMode="silent";await retry.click();await title(page,inlineJournalTitle("",true));
  await waitInlineFixture(()=>subscriptions.filter(key=>key===runStreamTarget).length===beforeRetry+1);
  await withinViewport(page,dialog.getByText("Reconnecting run updates…",{exact:true}));
  if(shots)await page.screenshot({path:join(shots,`inline-journal-${view.toLowerCase()}-reconnecting-${width}-${scheme}.png`),animations:"disabled"});
  holdInlineJournal=false;for(const release of pending)release();pending.clear();runStreamMode="";inlineInterrupt();await title(page,inlineJournalTitle());
  await retry.click();await title(page,inlineDetailTitle(0,true));await dialog.getByText("Recorded inline result 2",{exact:false}).first().waitFor();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(shots)await page.screenshot({path:join(shots,`inline-journal-${view.toLowerCase()}-recovered-${width}-${scheme}.png`),animations:"disabled"});
 }
}),Math.max(browserBudget,120000));

const recordedOldId="wf-failed-run:501";
const recordedNotice=(page:Page)=>page.locator('[data-run-recorded-journal]');
const recordedMissingTitle="Run tools not found · Seed · Cyberdeck";
test("Seed completed journal restores an old tool outside the stream window on direct links, reload and fresh tabs",()=>fresh(async page=>{
 durableOnly=true;
 await page.goto(selectionHref(runToolQuery(recordedOldId),"peer-a"));await title(page,runInspectorTitle("peer-a"));
 await page.getByRole("dialog").getByText(/Old durable result outside the stream window/).waitFor();
 const link=page.url();await page.reload();await title(page,runInspectorTitle("peer-a"));expect(page.url()).toBe(link);
 await fresh(async tab=>{await tab.goto(link);await title(tab,runInspectorTitle("peer-a"));await tab.getByRole("dialog").getByText(/Old durable input outside the stream window/).waitFor();});
}),browserBudget);

test("Seed completed journal keeps canonical history and mounted tools while selecting old durable details",()=>fresh(async page=>{
 durableOnly=true;await page.goto(selectionHref("calls=open"));await page.getByLabel("Run tool calls").getByTitle("Show tool details",{exact:true}).last().waitFor();
 const calls=page.getByRole("button",{name:/^Tool calls/});await calls.evaluate(el=>(el as any).__recordedOwner="same completed tree");
 const before=await page.evaluate(()=>history.length),readCount=reads.length,subCount=subscriptions.length;
 await page.getByLabel("Run tool calls").getByTitle("Show tool details",{exact:true}).last().click();await title(page,runDetailsTitle());
 expect(selectedPath(page.url())).toBe(`run/failed-run?calls=open&detail=${encodeURIComponent(recordedOldId)}`);
 await page.getByLabel("Run tool calls").getByTitle("View raw tool input/output",{exact:true}).last().click();await title(page,runInspectorTitle());
 await page.keyboard.press("Escape");await title(page,runDetailsTitle());
 await page.goBack();await title(page,runInspectorTitle());await page.goBack();await title(page,runDetailsTitle());
 await page.goBack();await title(page,selectionTitle("Tool calls open · "));await page.goForward();await title(page,runDetailsTitle());
 expect(await page.evaluate(()=>history.length)).toBe(before+3);
 expect(await calls.evaluate(el=>(el as any).__recordedOwner)).toBe("same completed tree");
 expect(reads.length).toBe(readCount);expect(subscriptions.length).toBe(subCount);
}),browserBudget);

test("Seed completed journal proves missing selections only after every owned terminal journal finishes",()=>fresh(async page=>{
 holdRecorded=true;await page.goto(selectionHref(runToolQuery("wf-unrelated:1")));
 await title(page,"Waiting for tool · wf-unrelated:1 · local Review navigation · Seed run · Cyberdeck");
 await waitInlineFixture(()=>reads.filter(row=>row.action._==="GetRunJournal").length>=2 && pending.size>=2);
 const link=page.url(),length=await page.evaluate(()=>history.length);
 holdRecorded=false;for(const release of pending)release();pending.clear();await title(page,recordedMissingTitle);
 await page.getByText("The selected tool is not in this completed run's recorded journal.").waitFor();
 expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(length);
 expect(reads.filter(row=>row.action._==="GetRunJournal").slice(-2).map(row=>row.action.runId).sort()).toEqual(["failed-run",errorChild].sort());
 await page.reload();await title(page,recordedMissingTitle);
}),browserBudget);

test("Seed completed journal restores empty tool lists without an endless waiting title",()=>fresh(async page=>{
 recordedEmpty=true;await page.goto(selectionHref("calls=open"));await title(page,selectionTitle("Tool calls open · "));
 await page.getByText("No tool calls were recorded in this completed run.",{exact:true}).waitFor();
 expect(await page.getByText("Waiting for recorded tool calls…",{exact:true}).count()).toBe(0);
 const link=page.url();await page.reload();await title(page,selectionTitle("Tool calls open · "));expect(page.url()).toBe(link);
}),browserBudget);

for(const [status,malformed,label]of [[403,"","Access denied"],[404,"","Run tools not found"],[503,"","Run tools unavailable"],[200,"response","Run tools unavailable"],[200,"identity","Run tools unavailable"],[200,"array","Run tools unavailable"],[200,"entry","Run tools unavailable"],[200,"description","Run tools unavailable"],[200,"result","Run tools unavailable"],[200,"row-owner","Run tools unavailable"],[200,"duplicate","Run tools unavailable"]]as const)
 test(`Seed completed journal ${status} ${malformed||"read"} failures retry at the same selected URL`,()=>fresh(async page=>{
  durableOnly=true;recordedStatus=status;recordedMalformed=malformed;
  await page.goto(selectionHref(runToolQuery(recordedOldId)));await title(page,`${label} · Seed · Cyberdeck`);
  await recordedNotice(page).getByRole("button",{name:"Retry",exact:true}).waitFor();
  const link=page.url(),count=await page.evaluate(()=>history.length),subCount=subscriptions.length;
  recordedStatus=200;recordedMalformed="";await recordedNotice(page).getByRole("button",{name:"Retry",exact:true}).click();
  await title(page,runInspectorTitle());await page.getByRole("dialog").getByText(/Old durable result outside the stream window/).waitFor();
  expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);expect(subscriptions.length).toBe(subCount);
 }),browserBudget);

test("Seed completed journal read failure preserves received tools and keeps a separate read-only Retry",()=>fresh(async page=>{
 recordedStatus=503;await page.goto(selectionHref("calls=open"));await title(page,"Recorded tools unavailable · Seed · Cyberdeck");
 await page.getByLabel("Run tool calls").getByText(/Recorded run result 2/).waitFor();
 const link=page.url(),count=await page.evaluate(()=>history.length),subCount=subscriptions.length;
 recordedStatus=200;await recordedNotice(page).getByRole("button",{name:"Retry",exact:true}).click();await title(page,selectionTitle("Tool calls open · "));
 expect(page.url()).toBe(link);expect(await page.evaluate(()=>history.length)).toBe(count);expect(subscriptions.length).toBe(subCount);
}),browserBudget);

test("Seed completed journal late reads cannot restore a prior run, node, cleared selection or locked view",()=>fresh(async page=>{
 for(const destination of ["run","node","closed","locked"]){
  await page.goto("about:blank");durableOnly=true;holdRecorded=true;recordedStatus=503;
  await page.goto(selectionHref(runToolQuery(recordedOldId)));await waitInlineFixture(()=>pending.size>=2);
  const target=destination==="run"?href("run/activity?code=1"):destination==="node"?selectionHref("calls=closed","peer-b"):destination==="closed"?selectionHref("calls=closed"):`${server.url}#/files`;
  if(destination==="locked")await page.route("**/api/fs/list**",route=>route.fulfill({status:401,json:{error:"Locked"}}));
  holdRecorded=false;recordedStatus=200;await page.evaluate(url=>location.hash=new URL(url).hash,target);
  const expected=destination==="run"?runTitle("Code · "):destination==="node"?"Tool calls collapsed · peer-b Review navigation · Seed run · Peer B · Cyberdeck":destination==="closed"?selectionTitle("Tool calls collapsed · "):"Locked · Cyberdeck";
  await title(page,expected);const link=page.url();for(const release of pending)release();pending.clear();await page.waitForTimeout(100);
  expect(page.url()).toBe(link);expect(await page.title()).toBe(expected);expect(await page.getByRole("dialog").count()).toBe(0);
  if(destination==="locked")await page.unroute("**/api/fs/list**");
 }
}),browserBudget);

test("Seed completed journal external-server reads remain bound to the selected signing node",()=>fresh(async page=>{
 durableOnly=true;const signCount=signingNodes.length;
 await page.goto(selectionHref(`server=${encodeURIComponent(`${server.url}seed-fixture/external`)}&${runToolQuery(recordedOldId)}`,"peer-b"));
 await title(page,"Tool input/output · read · external Review navigation · Seed run · Peer B · Cyberdeck");
 await page.getByRole("dialog").getByText(/Old durable result outside the stream window/).waitFor();
 expect(reads.filter(row=>row.action._==="GetRunJournal").slice(-2).every(row=>row.node==="external")).toBe(true);
 expect(signingNodes.length).toBeGreaterThan(signCount);expect(signingNodes.slice(signCount).every(node=>node==="peer-b")).toBe(true);
}),browserBudget);

test("Seed completed journal never treats a live run as an authoritative missing-tool result",()=>fresh(async page=>{
 recordedLive=true;durableOnly=true;const before=reads.filter(row=>row.action._==="GetRunJournal").length;
 await page.goto(selectionHref(runToolQuery(recordedOldId)));await title(page,`Waiting for tool · ${recordedOldId} · local Review navigation · Seed run · Cyberdeck`);
 await page.waitForTimeout(100);expect(reads.filter(row=>row.action._==="GetRunJournal").length).toBe(before);
 recordedLive=false;for(const[socket,owner]of runSockets)if(owner.key==="runs/failed-run")socket.send(JSON.stringify({_:"change",key:owner.key,value:run("failed-run","local")}));
 await title(page,runInspectorTitle());await page.getByRole("dialog").getByText(/Old durable result outside the stream window/).waitFor();
}),browserBudget);

test("Seed completed journal old tools, missing selections, empty lists and read errors fit phone and desktop",()=>fresh(async page=>{
 for(const width of [390,1280])for(const colorScheme of ["light","dark"]as const){
  await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme});
  for(const state of ["tool","missing","empty","error"]){
   await page.goto("about:blank");durableOnly=true;recordedEmpty=state==="empty";recordedStatus=state==="error"?503:200;
   await page.goto(selectionHref(state==="empty"?"calls=open":runToolQuery(state==="missing"?"wf-unrelated:1":recordedOldId)));
   await title(page,state==="tool"?runInspectorTitle():state==="missing"?recordedMissingTitle:state==="empty"?selectionTitle("Tool calls open · "):"Run tools unavailable · Seed · Cyberdeck");
   if(state==="tool")await page.getByRole("dialog").evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})));});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
   if(width===390 && (state==="missing"||state==="error")){
    const retry=page.getByRole("button",{name:"Retry",exact:true});const bounds=await retry.boundingBox();expect(bounds!.height).toBeGreaterThanOrEqual(44);expect(bounds!.width).toBeGreaterThanOrEqual(44);
   }
   if(process.env.CYBERDECK_NAV_SHOTS)await page.screenshot({path:join(process.env.CYBERDECK_NAV_SHOTS,`completed-journal-${state}-${width}-${colorScheme}.png`)});
  }
 }
}),browserBudget);
