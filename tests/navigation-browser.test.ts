import { afterAll, beforeAll, expect, test as bunTest } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";

// Real production React bundle, deterministic read-only API. No fleet, process,
// media, authentication service, or user data is changed by these tests.
const test = (name: string, fn: () => Promise<void>) => bunTest(name, fn, 30000);
const requests: string[] = [], mutations: string[] = [], errors: string[] = [];
const browserSockets = new Set<any>();
const browserMessages: any[] = [];
let locked = false;
let browserUnavailable = false;
let missingLog = false, holdLog = false;
const browserConnections: string[] = [];
const deferred = new Map<string, () => void>();
const projects = ["alpha", "beta"].map(slug => ({ slug, name: slug === "alpha" ? "Alpha project" : "Beta project", status: "active", depth: 0, parent: null, repos: [], hosts: ["Test"], links: [], body: `# ${slug}`, file: `projects/${slug}/index.md` }));
const runs = ["run-a", "run-b"].map(id => ({ id, task: id === "run-a" ? "T-1" : "T-2", title: id, host: "Test", startedAt: "2026-10-12T00:00:00Z", finishedAt: "2026-10-12T00:01:00Z", status: "done", step: "done", verdict: "pass", dir: `/runs/${id}` }));
const overview = { fleetDir: "/home/test/Code/Deck", status: { host: "Test", time: "", hosts: [{name:"Test",roles:[],kind:"laptop",os:"macos",online:true,cyberdeck:null}], repo: { branch: "test", dirty: 0 }, handoffOpen: 0, sessionsIndexed: 0 }, projects, todo: { sections: [] }, handoff: [{file:"handoff/test-cx.md",host:"Test",agent:"cx",text:"test notes"}], collab: { tasks: [], runs, auto: false }, services: { probedAt: null, rows: [] } };
const entry = (name: string, size = 1) => ({ name, size, type: "file", mtime: size, mode: 0o644, uid: 1, gid: 1, nlink: 1, ino: size, hidden: name.startsWith("."), target: null, targetType: null });
const session = (id: string) => ({ id, title: `Shell ${id}`, cwd: "/home/test", cmd: null, tool: "shell", prompt: null, runner: "pty", state: "running", createdAt: 1, exitedAt: null, exitCode: null, clients: 0, lastOutputAt: null, bells: 0, busy: false });
const server = Bun.serve<{legacy:boolean}>({port:0,hostname:"127.0.0.1",async fetch(req, server) {
  const u = new URL(req.url), original = u.pathname;
  if (/^\/api\/browser\/[^/]+\/stream$/.test(original) && server.upgrade(req,{data:{legacy:original.includes("/claude/")}})) { browserConnections.push(original); return; }
  if (original.startsWith("/api/")) {
    requests.push(original + u.search);
    if (req.method !== "GET") { mutations.push(req.method + " " + original); return Response.json({error:"Test forbids mutations"},{status:405}); }
    if (locked && original !== "/api/auth/whoami" && !req.headers.get("authorization")?.includes("fixture-token")) return Response.json({error:"Locked"},{status:401});
    if (original === "/api/auth/whoami") return Response.json({method:"none"});
    const path = original.replace(/^\/api\/nodes\/[^/]+\/proxy\//, "/api/");
    if (path === "/api/fleet/nodes") return Response.json({self:{nodeId:"local",name:"Test",urls:[]},nodes:[{id:"peer-a",name:"Peer A",online:true,status:null,url:"http://peer-a.test",last_seen:null},{id:"peer-b",name:"Peer B",online:true,status:null,url:"http://peer-b.test",last_seen:null}]});
    if (path === "/api/control/overview") return Response.json(overview);
    if (path === "/api/control/collab") return Response.json(overview.collab);
    if (path.startsWith("/api/control/collab/runs/")) {
      if (missingLog && u.searchParams.get("file") === "result.md") return Response.json({error:"Missing log"},{status:404});
      if (holdLog && path.includes("/run-a/")) await new Promise<void>(r=>deferred.set("log",r));
      return Response.json({text:`${path} ${u.searchParams.get("file")}`,size:50});
    }
    if (path === "/api/control/sessions") {
      if (u.searchParams.get("q") === "slow") await new Promise<void>(r => deferred.set("slow", r));
      return Response.json(u.searchParams.get("q") ? [{host:"Test",tool:"cx",id:"test-session",title:u.searchParams.get("q"),cwd:"/home/test",updated:"2026-10-12",started:"2026-10-12",file:""}] : []);
    }
    if (path === "/api/repos") return Response.json([]);
    if (path === "/api/data") return Response.json({dirs:[{id:1,root:"/home/test",path:"/home/test/media",name:"media",kind:"data",size_bytes:1,cache_bytes:0,mtime:1},{id:2,root:"/other",path:"/other/cache",name:"cache",kind:"cache",size_bytes:1,cache_bytes:0,mtime:1}]});
    if (path === "/api/status") return Response.json({nodeName:"Test",version:"test",roots:[],repos:0});
    if (path === "/api/fs/list") {
      const dir = u.searchParams.get("path") || "/home/test";
      if (dir === "/slow") await new Promise<void>(r => deferred.set("files", r));
      if (dir === "/missing") return Response.json({error:"Directory not found"},{status:404});
      return Response.json({path:dir,parent:"/home",home:"/home/test",users:{1:"test"},groups:{1:"test"},entries:[entry("alpha.txt",20),entry("beta.txt",10),entry(".hidden",30)]});
    }
    if (path === "/api/fs/search") return Response.json({results:[`${u.searchParams.get("dir")}/nested/${u.searchParams.get("q")}.txt`]});
    if (path === "/api/cmux/tree") return Response.json({available:true,running:true,tree:[{kind:"window",ref:"w1",children:[{kind:"workspace",ref:"ws1",title:"Work",children:[{kind:"surface",ref:"s1",title:"First shell",active:true,children:[]},{kind:"surface",ref:"s2",title:"Second shell",children:[]}]}]}]});
    if (path === "/api/cmux/screen") return Response.json({text:`screen ${u.searchParams.get("surface")} scrollback=${u.searchParams.get("scrollback")}`});
    if (path === "/api/applications") return Response.json({applications:[]});
    if (path === "/api/sessions") return Response.json({sessions:[session("one"),session("two")]});
    if (path === "/api/browser/profiles") return Response.json({available:!browserUnavailable,profiles:[{name:"chatgpt",open:true,exists:true},{name:"claude",open:false,exists:true},{name:"default",open:false,exists:false}]});
    const conv = path.match(/^\/api\/cloud\/(?:chatgpt|claude)\/conversations\/(.+)$/)?.[1];
    if (conv) {
      if (conv === "missing") return Response.json({error:"Not found"},{status:404});
      if (conv === "slow") await new Promise<void>(r => deferred.set("cloud", r));
      return Response.json({frontmatter:{title:conv === "conversation-b" ? "Conversation B" : "Slow conversation",provider:"chatgpt",messages:"1"},markdown:`Body for ${conv}`});
    }
    if (/^\/api\/cloud\/.*\/conversations/.test(path)) return Response.json([]);
    return Response.json({error:"Fixture endpoint unavailable"},{status:404});
  }
  const file = Bun.file(join(import.meta.dir,"../dist/ui",original === "/" ? "index.html" : original));
  return await file.exists() ? new Response(file) : new Response("Not found",{status:404});
}, websocket: {
  open(ws) {
    browserSockets.add(ws);
    ws.send(JSON.stringify({t:"state",...(ws.data.legacy?{}:{navigationProtocol:1}),url:"about:blank",title:""}));
  },
  message(ws, raw) {
    const message = JSON.parse(String(raw));
    browserMessages.push(message);
    if (!["nav","back","forward","reload"].includes(message.t) || message.navigationId === undefined) return;
    // A parent restore must ignore unacknowledged state from the already-open profile.
    ws.send(JSON.stringify({t:"state",url:"https://stale.example/",title:"Stale profile"}));
    const url = message.t === "nav" ? new URL(message.url).toString() : "https://remote.example/one";
    const label = new URL(url).pathname.split("/").filter(Boolean).at(-1) || "home";
    if (ws.data.legacy) {
      ws.send(JSON.stringify({t:"state",url,title:`Remote ${label[0].toUpperCase()}${label.slice(1)}`}));
      return;
    }
    ws.send(JSON.stringify({t:"state",navigationProtocol:1,url,title:`Remote ${label[0].toUpperCase()}${label.slice(1)}`,navigationId:message.navigationId}));
  },
  close(ws) { browserSockets.delete(ws); },
}});
let browser: Browser, page: Page;
const hash = () => page.evaluate(() => location.hash);
const param = (key: string) => page.evaluate(key => new URLSearchParams(location.hash.split("?")[1]).get(key), key);
let visit = 0;
async function go(route: string) { await page.goto(`${server.url}?visit=${++visit}#/${route}`); }
async function title(value: string) { try { await page.waitForFunction(value => document.title === value, value); } catch (e) { throw new Error(`Expected title ${value}, got ${await page.title()}; errors=${errors.join("; ")}; hash=${await hash()}; bar=${await page.getByPlaceholder("https://").inputValue().catch(()=>"none")}; messages=${JSON.stringify(browserMessages.slice(-12))}`); } }
async function settle() { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage({viewport:{width:1440,height:1000}}); page.setDefaultTimeout(15000); page.on("pageerror",e => errors.push(e.message)); });
afterAll(async () => { for (const release of deferred.values()) release(); await browser?.close(); server.stop(true); });

test("primary views have titles and unknown routes render a useful error on fresh open", async () => {
  for (const [route, expected] of [["fleet","Home"],["desktop","Desktop"],["applications","Applications"],["spotify","Spotify"],["desk","Desk"],["services","Services"],["data","Data"],["cloud","Cloud"],["remote","Screen remote"]]) {
    await go(route); await title(`${expected} · Cyberdeck`);
  }
  await go("missing/nested"); await page.getByRole("heading",{name:"Page not found",exact:true}).waitFor(); await title("Page not found · Cyberdeck");
  await page.reload(); await page.getByRole("heading",{name:"Page not found",exact:true}).waitFor();
});

test("node links ignore stale storage, restore in new tabs, and traverse browser history", async () => {
  await go("files?path=%2Fhome%2Ftest&node=peer-a"); await page.getByTestId("files-table").waitFor();
  expect(await page.getByTestId("node-switcher").inputValue()).toBe("peer-a");
  expect(requests.some(p=>p.startsWith("/api/nodes/peer-a/proxy/fs/list"))).toBe(true);
  await page.evaluate(()=>localStorage.setItem("cyberdeck-active-node","peer-b"));
  const shared=page.url(), fresh=await browser.newPage();
  await fresh.goto(shared); await fresh.getByTestId("files-table").waitFor(); expect(await fresh.getByTestId("node-switcher").inputValue()).toBe("peer-a"); await fresh.close();
  const before=await page.evaluate(()=>history.length);
  await page.getByTestId("node-switcher").selectOption("peer-b"); await page.getByTestId("files-table").waitFor();
  expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.goBack(); await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).get("node")==="peer-a");
  await page.goForward(); await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).get("node")==="peer-b");
  await page.getByTestId("nav-services").click(); expect(await param("node")).toBe("peer-b");
  await go("files?path=%2Fhome%2Ftest"); await page.getByTestId("files-table").waitFor(); expect(await page.getByTestId("node-switcher").inputValue()).toBe("");
});

test("canonical aliases and repeated navigation replace or deduplicate, not add entries", async () => {
  await go("services?service=worker&host=Test"); await title("Service not found · Services · Cyberdeck");
  expect(await param("service")).toBe(null); expect(await param("svc")).toBe("worker");
  await page.getByTestId("nav-services").click(); const before=await page.evaluate(()=>history.length);
  await page.getByTestId("nav-services").click(); expect(await page.evaluate(()=>history.length)).toBe(before);
  await go("applications?app=steam"); expect(await param("app")).toBe("vimm"); expect(await param("tab")).toBe("steam");
});

test("file filters, hidden files, sort order and recursive search restore on reload and Back", async () => {
  await go("files?path=%2Fhome%2Ftest&hidden=1&sort=size&order=desc&q=txt"); await page.getByTestId("files-table").waitFor();
  expect(await page.getByTestId("files-filter").inputValue()).toBe("txt"); expect(await page.getByTestId("toggle-hidden").isChecked()).toBe(true);
  expect(await page.locator('[data-testid^="row-"]').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("alpha.txt")]));
  await page.getByTestId("toggle-hidden").uncheck(); expect(await param("hidden")).toBe(null);
  await page.goBack(); await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).get("hidden")==="1"); expect(await page.getByTestId("toggle-hidden").isChecked()).toBe(true);
  await page.reload(); await page.getByTestId("files-table").waitFor(); expect(await page.getByTestId("files-filter").inputValue()).toBe("txt");
  await page.getByTestId("files-filter").press("Enter"); await page.getByText("1 result for",{exact:false}).waitFor(); expect(await param("deep")).toBe("1");
  await page.reload(); await page.getByText("1 result for",{exact:false}).waitFor();
});

test("rapid file navigation ignores late results; missing directories have matching error titles", async () => {
  await go("files?path=%2Fslow"); while(!deferred.has("files")) await new Promise(r=>setTimeout(r,10));
  await page.evaluate(()=>location.hash="#/files?path=%2Fhome%2Ftest"); await page.getByTestId("files-table").waitFor();
  deferred.get("files")!(); deferred.delete("files"); await settle();
  expect(await page.getByTestId("breadcrumbs").innerText()).not.toContain("slow"); await title("/home/test · Files · Cyberdeck");
  await go("files?path=%2Fmissing"); await title("Cannot open /missing · Files · Cyberdeck");
});

test("project selection canonicalizes once, supports Back, and never substitutes unknown projects", async () => {
  await go("projects"); await title("Alpha project · Projects · Cyberdeck"); expect(await param("p")).toBe("alpha");
  await page.getByTestId("project-tree").getByRole("button",{name:/Beta project/}).click(); await title("Beta project · Projects · Cyberdeck");
  await page.goBack(); await title("Alpha project · Projects · Cyberdeck");
  await go("projects?p=missing"); await title("Project not found · Cyberdeck"); await page.getByRole("alert").filter({hasText:"Project not found"}).waitFor();
});

test("Agents run/log/filter/handoff state survives fresh links and history", async () => {
  await go("agents?run=run-b&log=worker.log&q=hello&host=Test&tool=cx&handoff=1");
  await page.getByTestId("run-log").filter({hasText:"worker.log"}).waitFor(); await title("run-b · worker.log · Agents · Cyberdeck");
  expect(await page.getByTestId("session-search").inputValue()).toBe("hello"); await page.getByText("test notes",{exact:true}).waitFor();
  await page.getByRole("button",{name:"reviewer.log",exact:true}).click(); await page.getByTestId("run-log").filter({hasText:"reviewer.log"}).waitFor();
  await page.goBack(); await page.getByTestId("run-log").filter({hasText:"worker.log"}).waitFor();
  await page.reload(); await page.getByTestId("run-log").filter({hasText:"worker.log"}).waitFor();
  await go("agents?run=missing"); await title("Run not found · Agents · Cyberdeck");
});

test("late session searches cannot replace a newer search", async () => {
  await go("agents?tool=cx&q=slow"); while(!deferred.has("slow")) await new Promise(r=>setTimeout(r,10));
  await page.getByTestId("session-search").fill("fast"); await page.getByText("fast",{exact:true}).waitFor();
  deferred.get("slow")!(); deferred.delete("slow"); await settle();
  expect(await page.getByText("slow",{exact:true}).count()).toBe(0); expect(await param("q")).toBe("fast");
});

test("Data filters and cmux surfaces restore without sending terminal input", async () => {
  await go("data?root=%2Fother&q=repo"); await page.getByTestId("data-table").getByText("cache",{exact:true}).first().waitFor();
  expect(await page.getByPlaceholder("filter…").inputValue()).toBe("repo");
  expect(await page.getByTestId("data-table").getByText("media",{exact:true}).count()).toBe(0);
  await go("cmux?surface=s2&scrollback=1"); await page.getByText("screen s2 scrollback=1",{exact:true}).waitFor(); await title("Second shell · cmux · Cyberdeck");
  await page.getByTestId("cmux-surface").filter({hasText:"First shell"}).click(); await page.getByText("screen s1 scrollback=1",{exact:true}).waitFor();
  await page.goBack(); await page.getByText("screen s2 scrollback=1",{exact:true}).waitFor();
  await page.reload(); await page.getByText("screen s2 scrollback=1",{exact:true}).waitFor();
});

test("terminal cwd links are read-only; session selection uses replace for defaults and leaves processes alone", async () => {
  await go("term?cwd=%2Fhome%2Ftest"); await page.getByTestId("term-new-form").waitFor(); await title("New session · Cyberdeck");
  expect(await page.getByPlaceholder("working directory (default: home)").inputValue()).toBe("/home/test");
  await page.reload(); await page.getByTestId("term-new-form").waitFor();
  await go("term?session=one"); await title("Shell one · Sessions · Cyberdeck");
  await go("term?session=missing"); await title("Session not found · Cyberdeck");
  await page.getByText("No session missing",{exact:false}).waitFor();
});

test("search typing creates one undoable history step; file info is shareable content", async () => {
  await go("files?path=%2Fhome%2Ftest"); await page.getByTestId("files-table").waitFor();
  const before = await page.evaluate(()=>history.length);
  await page.getByTestId("files-filter").pressSequentially("alpha");
  expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.goBack(); await page.waitForFunction(()=>!new URLSearchParams(location.hash.split("?")[1]).has("q"));
  expect(await page.getByTestId("files-filter").inputValue()).toBe("");
  await page.getByTestId("row-alpha.txt").click({button:"right"});
  await page.getByTestId("context-menu").getByRole("button",{name:"Get info",exact:true}).click();
  await page.getByRole("heading",{name:"Info — alpha.txt",exact:true}).waitFor();
  expect(await param("info")).toBe("alpha.txt"); await title("alpha.txt · File info · Cyberdeck");
  await page.goBack(); await page.getByRole("heading",{name:"Info — alpha.txt",exact:true}).waitFor({state:"hidden"});
  await page.goForward(); await page.getByRole("heading",{name:"Info — alpha.txt",exact:true}).waitFor();
  await page.reload(); await page.getByRole("heading",{name:"Info — alpha.txt",exact:true}).waitFor();
});

test("Cloud archive links restore independent of filters and ignore late conversation responses", async () => {
  await go("cloud?profile=claude&conversation=conversation-b&provider=chatgpt&q=unrelated");
  await title("Conversation B · Cloud · Cyberdeck"); await page.getByText("Body for conversation-b",{exact:true}).waitFor();
  await page.reload(); await page.getByText("Body for conversation-b",{exact:true}).waitFor();
  await go("cloud?conversation=slow"); while(!deferred.has("cloud")) await new Promise(r=>setTimeout(r,10));
  await page.evaluate(()=>location.hash="#/cloud?conversation=conversation-b"); await title("Conversation B · Cloud · Cyberdeck");
  deferred.get("cloud")!(); deferred.delete("cloud"); await settle(); await title("Conversation B · Cloud · Cyberdeck");
  await go("cloud?conversation=missing"); await page.getByRole("alert").filter({hasText:"Conversation not found"}).waitFor(); await title("Conversation not found · Cloud · Cyberdeck");
});

test("Cloud browser URL/title restoration uses one acknowledged history owner", async () => {
  const one = "https://remote.example/one";
  const two = "https://remote.example/two";
  await go(`cloud?profile=chatgpt&url=${encodeURIComponent(one)}`);
  await title("Remote One · Cloud · Cyberdeck");
  expect(await param("url")).toBe(one);
  expect(await hash()).not.toContain("stale.example");
  await page.reload();
  await title("Remote One · Cloud · Cyberdeck");
  expect(await param("url")).toBe(one);

  const before = await page.evaluate(() => history.length);
  await page.getByPlaceholder("https://").fill(two);
  await page.getByPlaceholder("https://").press("Enter");
  await page.waitForFunction(url => new URLSearchParams(location.hash.split("?")[1]).get("url") === url, two);
  await title("Remote Two · Cloud · Cyberdeck");
  expect(await page.evaluate(() => history.length)).toBe(before + 1);

  await page.goBack();
  await page.waitForFunction(url => new URLSearchParams(location.hash.split("?")[1]).get("url") === url, one);
  await title("Remote One · Cloud · Cyberdeck");
  await page.goForward();
  await page.waitForFunction(url => new URLSearchParams(location.hash.split("?")[1]).get("url") === url, two);
  await title("Remote Two · Cloud · Cyberdeck");

  const beforePageNavigation = await page.evaluate(() => history.length);
  for (const ws of browserSockets) {
    ws.send(JSON.stringify({t:"state",url:"https://remote.example/intermediate",title:"Intermediate"}));
    ws.send(JSON.stringify({t:"state",url:"https://remote.example/final",title:"Remote Final"}));
  }
  await page.waitForFunction(() => new URLSearchParams(location.hash.split("?")[1]).get("url") === "https://remote.example/final");
  await title("Remote Final · Cloud · Cyberdeck");
  expect(await page.evaluate(() => history.length)).toBe(beforePageNavigation + 1);
  expect(await hash()).not.toContain("intermediate");
  expect(browserMessages.filter(m => m.t === "nav" && m.url === one).length).toBeGreaterThanOrEqual(2);
});

test("Cloud browser remains canonical while older daemons roll forward", async () => {
  const url = "https://remote.example/legacy";
  await go(`cloud?profile=claude&url=${encodeURIComponent(url)}`);
  for (let i=0;i<400 && !browserMessages.some(m=>m.t==="nav"&&m.url===url);i++) await new Promise(r=>setTimeout(r,25));
  expect(browserMessages.some(m=>m.t==="nav"&&m.url===url)).toBe(true);
  await title("Remote Legacy · Cloud · Cyberdeck");
  expect(await param("url")).toBe(url);
  expect(await hash()).not.toContain("stale.example");
});

test("unknown applications and locked deep links keep honest titles and recover the original URL", async () => {
  await go("applications?app=unknown"); await page.getByRole("heading",{name:"Application not found"}).waitFor(); await title("Application not found · Cyberdeck");
  locked=true;
  try {
    await go("files?path=%2Fhome%2Ftest&node=peer-a"); await page.getByRole("heading",{name:"Cyberdeck is locked"}).waitFor(); await title("Locked · Cyberdeck");
    const target=page.url(); await page.getByPlaceholder("access token").fill("fixture-token"); await page.getByRole("button",{name:"Unlock",exact:true}).click();
    await page.getByTestId("files-table").waitFor(); expect(page.url()).toBe(target);
  } finally { locked=false; }
  expect(mutations).toEqual([]); expect(errors).toEqual([]);
});


test("missing cmux surfaces and service links render matching errors without actions", async () => {
  await go("cmux?surface=missing"); await title("Surface not found · cmux · Cyberdeck");
  await page.getByRole("alert").filter({hasText:"Surface not found"}).waitFor();
  expect(requests.some(p => p.includes("/cmux/screen?surface=missing"))).toBe(false);
  await go("services?host=missing"); await title("Host not found · Services · Cyberdeck");
  await page.reload(); await title("Host not found · Services · Cyberdeck");
  await go("services?host=Test&svc=missing"); await title("Service not found · Services · Cyberdeck");
  await page.getByRole("alert").filter({hasText:"Service not found"}).waitFor();
});

test("Seed links keep node selection and reject invalid nested paths", async () => {
  await go("seed?node=peer-a&r=" + encodeURIComponent("agent/example?tab=memory&file=notes%2Ftoday.md"));
  await title("notes/today.md · example · Seed · Cyberdeck");
  await page.getByRole("alert").filter({hasText:"Seed agents unavailable"}).waitFor();
  expect(requests).toContain("/api/seed-agents/nodes/peer-a/session");
  await page.reload(); await title("notes/today.md · example · Seed · Cyberdeck");
  await page.getByTestId("nav-services").click(); await page.goBack();
  await title("notes/today.md · example · Seed · Cyberdeck");
  expect(await param("node")).toBe("peer-a");
  await go("seed?r=not-a-route"); await title("Page not found · Seed · Cyberdeck");
  await page.getByRole("heading",{name:"Page not found",exact:true}).waitFor();
  await go("seed?r=agent%2F%25ZZ"); await title("Page not found · Seed · Cyberdeck");
  expect(errors).toEqual([]); expect(mutations).toEqual([]);
});

test("late remote-browser events cannot navigate or retitle a different primary view", async () => {
  await page.addInitScript(() => {
    const Base = window.WebSocket;
    (window as any).navigationTestSockets = [];
    window.WebSocket = class extends Base {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).navigationTestSockets.push(this);
      }
    };
  });
  await go("cloud?profile=chatgpt&url=https%3A%2F%2Fremote.example%2Fone");
  await title("Remote One · Cloud · Cyberdeck");
  await page.getByTestId("nav-data").click(); await title("Data · Cyberdeck");
  const destination=page.url();
  await page.evaluate(() => {
    for(const socket of (window as any).navigationTestSockets as WebSocket[]) {
      if(socket.url.includes("/browser/")) socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({t:"state",url:"https://late.example/",title:"Late browser"})}));
    }
  });
  await page.waitForTimeout(350);
  expect(page.url()).toBe(destination); expect(await page.title()).toBe("Data · Cyberdeck");
  expect(errors).toEqual([]); expect(mutations).toEqual([]);
});


test("Desk tabs have canonical links and history without remounting the voice view", async () => {
  // A fresh context keeps this history-count assertion below Chromium’s entry cap.
  await page.close(); page = await browser.newPage({viewport:{width:1440,height:1000}}); page.setDefaultTimeout(15000); page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem("cyberdeck-desk-glance","agents"));
  await go("desk");await page.getByTestId("glance-fleet").waitFor();await title("Desk · Cyberdeck");
  await page.getByTestId("voice-transcript").evaluate(node=>node.setAttribute("data-session-proof","preserved"));
  const before=await page.evaluate(()=>history.length);
  await page.getByTestId("glance-tab-services").click();await title("Services · Desk · Cyberdeck");
  expect(await param("tab")).toBe("services");expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.getByTestId("glance-tab-services").click();expect(await page.evaluate(()=>history.length)).toBe(before+1);
  await page.getByTestId("glance-tab-agents").click();await page.getByTestId("glance-agents").waitFor();await title("Agents · Desk · Cyberdeck");
  await page.goBack();await page.getByTestId("glance-services").waitFor();await title("Services · Desk · Cyberdeck");
  await page.goForward();await page.getByTestId("glance-agents").waitFor();
  expect(await page.getByTestId("voice-transcript").getAttribute("data-session-proof")).toBe("preserved");
  await page.reload();await page.getByTestId("glance-agents").waitFor();await title("Agents · Desk · Cyberdeck");
  const other=await browser.newPage();await other.goto(page.url());await other.getByTestId("glance-agents").waitFor();expect(await other.title()).toBe("Agents · Desk · Cyberdeck");await other.close();
  await go("desk?tab=invalid");await page.getByTestId("glance-fleet").waitFor();expect(await param("tab")).toBeNull();await title("Desk · Cyberdeck");
  await go("desk?tab=fleet");await page.getByTestId("glance-fleet").waitFor();expect(await param("tab")).toBeNull();
  expect(mutations).toEqual([]);
});


test("Cloud invalid URLs, missing profiles and unavailable browsers have honest titles without opening a session", async () => {
  const before=browserConnections.length;
  await go("cloud?profile=missing");await page.getByRole("alert").filter({hasText:"Browser profile not found"}).waitFor();await title("Browser profile not found · Cloud · Cyberdeck");
  await page.reload();await title("Browser profile not found · Cloud · Cyberdeck");
  await go("cloud?profile=chatgpt&url=javascript%3Aalert%281%29");await title("Invalid browser URL · Cloud · Cyberdeck");
  await page.getByRole("alert").filter({hasText:"Invalid browser URL"}).waitFor();
  browserUnavailable=true;
  try {await go("cloud?profile=chatgpt");await page.getByRole("alert").filter({hasText:"Browser unavailable"}).waitFor();await title("Browser unavailable · Cloud · Cyberdeck");}
  finally {browserUnavailable=false;}
  expect(browserConnections.length).toBe(before);
  await go("files?path=%2Fhome%2Ftest");await title("/home/test · Files · Cyberdeck");expect(mutations).toEqual([]);
});


test("Agents missing tasks/logs have matching titles and never retain another log", async () => {
  await go("agents?task=missing");await page.getByRole("alert").filter({hasText:"Task not found"}).waitFor();await title("Task not found · Agents · Cyberdeck");
  await page.reload();await title("Task not found · Agents · Cyberdeck");
  await go("agents?run=run-a&log=invalid");await page.getByTestId("run-log").filter({hasText:"worker.log"}).waitFor();expect(await param("log")).toBeNull();
  missingLog=true;
  try {
    await page.getByRole("button",{name:"result.md",exact:true}).click();await page.getByRole("alert").filter({hasText:"Log not found"}).waitFor();await title("run-a · Log not found · Agents · Cyberdeck");
    expect(await page.getByTestId("run-log").count()).toBe(0);
    await page.reload();await page.getByRole("alert").filter({hasText:"Log not found"}).waitFor();await title("run-a · Log not found · Agents · Cyberdeck");
    await page.getByRole("button",{name:"worker.log",exact:true}).click();await page.getByTestId("run-log").filter({hasText:"worker.log"}).waitFor();await title("run-a · worker.log · Agents · Cyberdeck");
  } finally {missingLog=false;}
});

test("Agents late log responses cannot overwrite a newer run", async () => {
  holdLog=true;
  try {
    await go("agents?run=run-a");while(!deferred.has("log")) await new Promise(r=>setTimeout(r,10));
    await page.evaluate(()=>location.hash="#/agents?run=run-b&log=reviewer.log");
    await page.getByTestId("run-log").filter({hasText:"run-b/log reviewer.log"}).waitFor();
    deferred.get("log")!();deferred.delete("log");await settle();
    expect(await page.getByTestId("run-log").textContent()).toContain("run-b/log reviewer.log");await title("run-b · reviewer.log · Agents · Cyberdeck");
    expect(mutations).toEqual([]);
  } finally {holdLog=false;deferred.get("log")?.();deferred.delete("log");}
});
