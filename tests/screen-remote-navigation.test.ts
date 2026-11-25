import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";

const frame = {
  t: "frame", w: 1, h: 1,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};
const owners = new Set<Bun.ServerWebSocket<undefined>>();
const commands: string[] = [], errors: string[] = [];
let connections = 0, behavior: "frame" | "denied" | "error" | "invalid" = "frame";
const server = Bun.serve({ hostname:"127.0.0.1", port:0,
  async fetch(req, transport) {
    const url=new URL(req.url), path=url.pathname;
    if(path==="/api/kiosk/stream" && transport.upgrade(req))return;
    if(req.method!=="GET"){commands.push(req.method+" "+path);return new Response(null,{status:405});}
    if(path==="/api/auth/whoami")return Response.json({method:"none"});
    if(path==="/api/fleet/nodes")return Response.json({self:{nodeId:"serving",name:"Test kiosk",urls:[]},nodes:[]});
    if(path==="/api/audio")return Response.json({available:true,volume:25,muted:false});
    if(path.startsWith("/api/"))return Response.json({error:"No fixture for this resource"},{status:404});
    const installed=process.env.CYBERDECK_TEST_ORIGIN;
    if(installed)return fetch(new URL(path,installed));
    const file=Bun.file(join(import.meta.dir,"../dist/ui",path==="/"? "index.html" : path));
    return await file.exists()?new Response(file):new Response(null,{status:404});
  },
  websocket:{
    open(ws) {
      connections++; owners.add(ws);
      if(behavior==="denied")ws.close(1008,"Unavailable");
      else if(behavior==="error")ws.send(JSON.stringify({t:"error",message:"Fixture screen offline"}));
      else ws.send(behavior==="invalid"?"unreadable":JSON.stringify(frame));
    },
    message(_ws,message){commands.push(String(message));},
    close(ws){owners.delete(ws);},
  },
});
let browser:Browser;
const url=(query="")=>server.url.href+"#/remote"+(query?"?"+query:"");
const title=(page:Page,expected:string)=>page.waitForFunction(expected=>document.title===expected,expected+" · Cyberdeck");
async function fresh(fn:(page:Page)=>Promise<void>) {
 const page=await browser.newPage();page.setDefaultTimeout(6000);page.on("pageerror",err=>errors.push(err.message));
 await page.route("**/*",route=>new URL(route.request().url()).origin===server.url.origin?route.continue():route.abort());
 try{await fn(page);}catch(error){throw new Error(JSON.stringify({hash:new URL(page.url()).hash,title:await page.title(),body:(await page.locator("body").innerText()).slice(0,650),errors,connections}),{cause:error});}finally{await page.close();}
}
beforeAll(async()=>{browser=await chromium.launch();});
afterAll(async()=>{await browser.close();server.stop(true);expect(commands).toEqual([]);expect(errors).toEqual([]);});
test("Screen remote mode restores fresh links and history without reconnecting or sending input",()=>fresh(async page=>{
 behavior="frame";await page.goto(url());await page.getByText("Connected",{exact:true}).waitFor();
 const canvas=page.getByLabel("Live screen on Test kiosk"),input=page.getByLabel("Type on Test kiosk"),start=connections;
 await canvas.evaluate(el=>(el as any).__original=true);await input.fill("unsent draft");
 const length=await page.evaluate(()=>history.length);
 await page.getByRole("button",{name:"Tap / drag mode"}).click();await title(page,"Scroll mode · Screen remote");
 expect(page.url()).toBe(url("mode=scroll"));expect(await page.evaluate(()=>history.length)).toBe(length+1);
 await page.goBack();await title(page,"Screen remote");await page.goForward();await title(page,"Scroll mode · Screen remote");
 expect(await input.inputValue()).toBe("unsent draft");expect(await canvas.evaluate(el=>(el as any).__original)).toBe(true);expect(connections).toBe(start);
 const link=page.url();await fresh(async tab=>{await tab.goto(link);await title(tab,"Scroll mode · Screen remote");await tab.getByText("Connected",{exact:true}).waitFor();expect(await tab.getByLabel("Type on Test kiosk").inputValue()).toBe("");});
 await page.reload();await title(page,"Scroll mode · Screen remote");expect(await input.inputValue()).toBe("");
}),30000);
test("Screen remote canonicalizes invalid modes, duplicate keys, local aliases and stray input",()=>fresh(async page=>{
 behavior="frame";for(const [query,canonical] of [["mode=tap&text=private&action=reload",""],["mode=scroll&mode=tap&node=self","mode=scroll"],["mode=wrong&node=serving",""]]){
  await page.goto(url(query));await page.getByText("Connected",{exact:true}).waitFor();await page.waitForURL(url(canonical));await title(page,canonical?"Scroll mode · Screen remote":"Screen remote");
 }
}),30000);
test("Screen remote foreign node links preserve the request and never open the serving kiosk",()=>fresh(async page=>{
 behavior="frame";const before=connections;await page.goto(url("mode=scroll&node=peer"));
 await title(page,"Screen belongs to another node · Screen remote");await page.getByRole("alert").waitFor();
 expect(connections).toBe(before);expect(await page.locator("canvas").count()).toBe(0);const link=page.url();
 await page.getByRole("link",{name:"Open this machine’s screen"}).click();await page.getByText("Connected",{exact:true}).waitFor();
 await title(page,"Scroll mode · Screen remote");await page.goBack();await title(page,"Screen belongs to another node · Screen remote");expect(page.url()).toBe(link);expect(connections).toBe(before+1);
}),30000);
for(const state of ["denied","error","invalid"] as const)test("Screen remote "+state+" stays on the selected mode and retries without adding history",()=>fresh(async page=>{
 behavior=state;await page.goto(url("mode=scroll"));await title(page,"Screen unavailable · Scroll mode · Screen remote");
 expect(await page.getByRole("button",{name:"Send text"}).isDisabled()).toBe(true);
 const before=await page.evaluate(()=>history.length);behavior="frame";await page.getByRole("button",{name:"Reconnect"}).click();
 await title(page,"Scroll mode · Screen remote");await page.getByText("Connected",{exact:true}).waitFor();
 expect(page.url()).toBe(url("mode=scroll"));expect(await page.evaluate(()=>history.length)).toBe(before);
}),30000);
test("Screen remote releases a previous stream and title when leaving the view",()=>fresh(async page=>{
 behavior="frame";await page.goto(url("mode=scroll"));await page.getByText("Connected",{exact:true}).waitFor();
 for(const ws of owners)ws.send(JSON.stringify({t:"error",message:"Reported screen failure"}));
 await title(page,"Screen unavailable · Scroll mode · Screen remote");
 await page.evaluate(()=>{location.hash="#/controls";});await title(page,"Controls");
 expect(await page.locator("canvas").count()).toBe(0);
 await page.goBack();await title(page,"Scroll mode · Screen remote");await page.getByText("Connected",{exact:true}).waitFor();
}),30000);

test("Screen remote unavailable fleet identity retries only the owner lookup",()=>fresh(async page=>{
 behavior="frame";const start=connections;
 await page.addInitScript(()=>document.addEventListener("click",event=>{
  if((event.target as HTMLElement)?.textContent==="Retry screen owner")(window as any).__retriedOwner=true;
 },true));
 await page.route("**/api/fleet/nodes",async route=>{
  if(await page.evaluate(()=>Boolean((window as any).__retriedOwner)))return route.continue();
  return route.fulfill({status:503,json:{error:"Owner lookup unavailable"}});
 });
 await page.goto(url("mode=scroll&node=serving"));await title(page,"Screen owner unavailable · Screen remote");
 expect(connections).toBe(start);const before=await page.evaluate(()=>history.length);
 await page.getByRole("button",{name:"Retry screen owner"}).click();await page.getByText("Connected",{exact:true}).waitFor();
 await page.waitForURL(url("mode=scroll"));await title(page,"Scroll mode · Screen remote");
 expect(connections).toBe(start+1);expect(await page.evaluate(()=>history.length)).toBe(before);
}),30000);

test("Screen remote signed-out node links keep the requested URL at the token gate",()=>fresh(async page=>{
 const start=connections;
 await page.route("**/api/fleet/nodes",route=>route.fulfill({status:401,json:{error:"Authentication required"}}));
 const link=url("mode=scroll&node=unpaired");await page.goto(link);await title(page,"Locked");
 expect(page.url()).toBe(link);expect(connections).toBe(start);
 expect(await page.locator("canvas").count()).toBe(0);
 await page.reload();await title(page,"Locked");expect(page.url()).toBe(link);
}),30000);
