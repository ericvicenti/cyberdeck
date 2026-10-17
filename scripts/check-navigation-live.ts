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
  if (errors.length || mutations.length) throw new Error(JSON.stringify({errors,mutations}));
  console.log(JSON.stringify({origin,peer,checks:"deep link, reload, filters, Back/Forward, missing application, not-found title",additionalChecks:"Desk tabs/title/reload/history/voice subtree, invalid Cloud URL without socket, signed-out Spotify links/title/reload/player persistence",nodeChecks:peer ? "new tab and Back/Forward passed" : "skipped: no online peer",steamDetails,pageErrors:errors,mutations}));
} finally { await browser.close(); }
