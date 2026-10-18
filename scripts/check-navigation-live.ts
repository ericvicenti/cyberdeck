// Read-only smoke check in a separate headless browser. Never attach to the kiosk.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
const origin = process.env.CYBERDECK_TEST_ORIGIN || "http://127.0.0.1:4777";
let access = "";
if (process.env.CYBERDECK_TEST_TOKEN_HOST) {
  // Capture the token inside this process only; never log it or pass it as argv.
  const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", process.env.CYBERDECK_TEST_TOKEN_HOST, "cat ~/.cyberdeck/token"], {stdout:"pipe",stderr:"pipe"});
  access = (await new Response(child.stdout).text()).trim();
  if (await child.exited || !access) throw new Error("Could not read remote Cyberdeck authentication token");
} else if (origin === "http://127.0.0.1:4777") access = readFileSync(homedir()+"/.cyberdeck/token","utf8").trim();
const browser = await chromium.launch();
const errors: string[] = [], mutations: string[] = [];
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route(origin+"/api/**", route => {
    if (route.request().method() !== "GET") { mutations.push(route.request().method()+" "+new URL(route.request().url()).pathname); return route.abort(); }
    return access ? route.continue({headers:{...route.request().headers(),authorization:"Bearer "+access}}) : route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000); page.on("pageerror",e=>errors.push(e.message));
  await page.goto(origin+"/#/files?path=~&hidden=1&q=cyberdeck-navigation-proof&sort=size&order=desc");
  await page.getByTestId("files-table").waitFor();
  if (await page.getByTestId("files-filter").inputValue() !== "cyberdeck-navigation-proof") throw new Error("Filter was not restored");
  if (!await page.getByTestId("toggle-hidden").isChecked()) throw new Error("Hidden-file state was not restored");
  await page.reload(); await page.getByTestId("files-table").waitFor();
  await page.getByTestId("toggle-hidden").uncheck();
  await page.goBack(); await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).get("hidden")==="1");
  const nodes = await page.evaluate(async () => { const response = await fetch("/api/fleet/nodes"); if (!response.ok) throw new Error("Fleet query failed"); const fleet = await response.json(); return fleet.nodes.filter((n: { online: boolean }) => n.online).map((n: { id: string }) => n.id) as string[]; });
  let peer = "";
  if (nodes.length) {
    peer=nodes[0]; await page.getByTestId("node-switcher").locator(`option[value="${peer}"]`).waitFor({state:"attached"}); await page.getByTestId("node-switcher").selectOption(peer);
    await page.waitForFunction(id=>new URLSearchParams(location.hash.split("?")[1]).get("node")===id,peer);
    await page.getByTestId("files-table").waitFor();
    const other = await context.newPage(); await other.goto(page.url()); await other.getByTestId("files-table").waitFor();
    if (await other.getByTestId("node-switcher").inputValue() !== peer) throw new Error("New tab lost node");
    await other.close();
    await page.goBack(); await page.waitForFunction(()=>!new URLSearchParams(location.hash.split("?")[1]).has("node"));
    await page.goForward(); await page.waitForFunction(id=>new URLSearchParams(location.hash.split("?")[1]).get("node")===id,peer);
  }
  await page.getByTestId("nav-applications").click();
  await page.getByRole("heading",{name:"Applications",exact:true}).waitFor();
  await page.evaluate(()=>location.hash="#/applications?app=navigation-test-missing");
  await page.getByRole("heading",{name:"Application not found"}).waitFor();
  await page.waitForFunction(()=>document.title==="Application not found · Cyberdeck");
  await page.evaluate(()=>location.hash="#/navigation-test-missing");
  await page.getByRole("heading",{name:"Page not found"}).waitFor();
  await page.waitForFunction(()=>document.title==="Page not found · Cyberdeck");
  await page.goto(origin+"/#/desk?tab=services");
  await page.getByTestId("glance-services").waitFor();
  await page.waitForFunction(()=>document.title==="Services · Desk · Cyberdeck");
  await page.getByTestId("voice-transcript").evaluate(node=>node.setAttribute("data-navigation-proof","preserved"));
  await page.getByTestId("glance-tab-agents").click();await page.getByTestId("glance-agents").waitFor();
  await page.goBack();await page.getByTestId("glance-services").waitFor();
  if (await page.getByTestId("voice-transcript").getAttribute("data-navigation-proof")!=="preserved") throw new Error("Desk tab remounted voice");
  await page.getByTestId("nav-files").click();await page.getByTestId("files-table").waitFor();
  if (peer) {
    await page.getByTestId("node-switcher").selectOption(peer);
    await page.getByTestId("files-table").waitFor();
    await page.goBack();
  }
  await page.goBack();await page.getByTestId("glance-services").waitFor();
  if (await page.getByTestId("voice-transcript").getAttribute("data-navigation-proof")!=="preserved") throw new Error("Leaving Desk remounted voice");
  await page.reload();await page.getByTestId("glance-services").waitFor();
  const browserSockets: string[]=[];
  page.on("websocket",ws=>{if(ws.url().includes("/api/browser/")) browserSockets.push(ws.url());});
  await page.goto(origin+"/#/cloud?profile=chatgpt&url=javascript%3Aalert%281%29");
  await page.getByRole("alert").filter({hasText:"Invalid browser URL"}).waitFor();
  await page.waitForFunction(()=>document.title==="Invalid browser URL · Cloud · Cyberdeck");
  if(browserSockets.length) throw new Error("Invalid Cloud link opened a browser socket");
  const rich=process.env.CYBERDECK_TEST_RICH_SPOTIFY==="1";
  const music="#/spotify?q=navigation-proof"+(rich?"&shelf=search":"&playlists=2");
  await page.goto(origin+"/"+music);await page.getByTestId("spotify-app").waitFor();
  await page.waitForFunction(()=>document.title.includes("navigation-proof")&&document.title.endsWith("Spotify · Cyberdeck"));
  await page.getByTestId("spotify-app").evaluate(node=>node.setAttribute("data-navigation-proof","preserved"));
  await page.getByTestId("nav-files").click();await page.getByTestId("files-table").waitFor();
  await page.goBack();await page.getByTestId("spotify-app").waitFor();
  if(await page.getByTestId("spotify-app").getAttribute("data-navigation-proof")!=="preserved") throw new Error("Spotify route remounted player");
  await page.reload();await page.waitForFunction(()=>document.title.includes("navigation-proof")&&document.title.endsWith("Spotify · Cyberdeck"));
  if (rich && process.env.CYBERDECK_TEST_RECORDINGS === "1") {
    await page.goto(origin+"/#/spotify?recording=navigation-proof-missing&shelf=history");
    await page.getByRole("heading",{name:"Recording unavailable",exact:true}).waitFor();
    await page.waitForFunction(()=>document.title==="Recording unavailable · Saved audio · Spotify · Cyberdeck");
    await page.reload();await page.getByRole("heading",{name:"Recording unavailable",exact:true}).waitFor();
    await page.getByTestId("nav-files").click();await page.getByTestId("files-table").waitFor();
    await page.goBack();await page.waitForFunction(()=>document.title==="Recording unavailable · Saved audio · Spotify · Cyberdeck");
  }
  await page.goto(origin+"/#/agents?run=navigation-proof-missing&log=invalid");
  await page.waitForFunction(()=>["Run not found · Agents · Cyberdeck","Agents unavailable · Cyberdeck"].includes(document.title));
  if(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).has("log")) throw new Error("Invalid log was not canonicalized");
  await page.reload();await page.waitForFunction(()=>["Run not found · Agents · Cyberdeck","Agents unavailable · Cyberdeck"].includes(document.title));
  await page.goto(origin+"/#/agents?task=navigation-proof-missing");
  await page.waitForFunction(()=>["Task not found · Agents · Cyberdeck","Agents unavailable · Cyberdeck"].includes(document.title));
  mkdirSync("/tmp/cyberdeck-navigation",{recursive:true});
  await page.screenshot({path:"/tmp/cyberdeck-navigation/live-"+new URL(origin).hostname+".png"});
  let steamDetails = "not requested";
  if (process.env.CYBERDECK_TEST_STEAM === "1") {
    const library = await page.evaluate(async () => { const r=await fetch("/api/steam"); return r.ok ? r.json() : null; });
    const game = library?.games?.find((g: { compatible?: boolean }) => g.compatible !== false);
    if (game) {
      await page.goto(origin+"/#/applications?"+new URLSearchParams({app:"vimm",tab:"steam",steam:game.id}));
      await page.getByRole("dialog").getByRole("heading",{name:game.name,exact:true}).waitFor();
      await page.waitForFunction(name=>document.title===`${name} · The Vault · Cyberdeck`,game.name);
      await page.reload(); await page.getByRole("dialog").getByRole("heading",{name:game.name,exact:true}).waitFor();
      await page.getByRole("button",{name:"Close",exact:true}).click();
      await page.goBack(); await page.getByRole("dialog").getByRole("heading",{name:game.name,exact:true}).waitFor();
      steamDetails = "direct link, reload, close and Back passed without Play";
    } else steamDetails = "skipped: no available Steam library";
  }
  // Exercise this host's served bridge with an isolated cooperative child. No real
  // Afterglow playback, saved state, account or media endpoint is touched.
  await page.route("**/api/applications", route => route.fulfill({json:{applications:[{id:"afterglow",name:"Afterglow",url:origin+"/navigation-fixture",description:"Local test fixture"}]}}));
  await page.route("**/navigation-fixture*", route => route.fulfill({contentType:"text/html",body:`<!doctype html><title>Fixture</title><button id="next">Next fixture route</button><h1 id="route"></h1><script>
    const parentOrigin=new URLSearchParams(location.search).get('cyberdeck');
    function show(route){history.replaceState(null,'','#'+route);document.querySelector('h1').textContent=route;parent.postMessage({type:'afterglow:title',route,title:route+' · Afterglow'},parentOrigin);}
    addEventListener('message',event=>{if(event.source!==parent||event.origin!==parentOrigin)return;if(event.data.type==='cyberdeck:navigate')show(event.data.route);if(event.data.type==='cyberdeck:reload')location.reload();});
    document.querySelector('button').onclick=()=>{show('series');parent.postMessage({type:'afterglow:navigation',route:'series',title:'series · Afterglow'},parentOrigin);};
    show(location.hash.slice(1));parent.postMessage({type:'afterglow:ready',route:location.hash.slice(1)},parentOrigin);
  </script>`}));
  await page.goto(origin+"/#/applications?app=afterglow&route=discover");await page.reload();
  const embedded=page.frameLocator('[data-testid="afterglow-frame"]');
  await embedded.getByRole("heading",{name:"discover",exact:true}).waitFor();
  const frame=page.frames().find(frame=>frame.url().includes("/navigation-fixture"))!;
  await frame.evaluate(()=>(window as any).navigationProof="same-document");
  await embedded.getByRole("button",{name:"Next fixture route"}).click();
  await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).get("route")==="series");
  await page.getByTestId("nav-files").click();await page.getByTestId("files-table").waitFor();
  await frame.evaluate(()=>parent.postMessage({type:"afterglow:navigation",route:"hidden",title:"Hidden"},location.origin));
  if (!new URL(page.url()).hash.startsWith("#/files")) throw new Error("Hidden embed navigated the parent");
  await page.goBack();await embedded.getByRole("heading",{name:"series",exact:true}).waitFor();
  await page.waitForFunction(()=>document.title==="series · Afterglow · Cyberdeck");
  if(await frame.evaluate(()=>(window as any).navigationProof)!=="same-document")throw new Error("Leaving Applications destroyed the embed");
  await page.goBack();await embedded.getByRole("heading",{name:"discover",exact:true}).waitFor();
  if (errors.length || mutations.length) throw new Error(JSON.stringify({errors,mutations}));
  console.log(JSON.stringify({origin,peer,checks:"deep link, reload, filters, Back/Forward, missing application, not-found title",additionalChecks:"Desk tabs/title/reload/history/voice across primary/node changes, served Afterglow bridge lifecycle fixture, invalid Cloud URL without socket, signed-out Spotify links/title/reload/player persistence, Agents invalid selection/log canonicalization",nodeChecks:peer ? "new tab and Back/Forward passed" : "skipped: no online peer",steamDetails,recordingChecks:process.env.CYBERDECK_TEST_RECORDINGS==="1"?"unavailable account link, reload, title cleanup and Back passed without audio":"not requested",pageErrors:errors,mutations}));
} finally { await browser.close(); }
