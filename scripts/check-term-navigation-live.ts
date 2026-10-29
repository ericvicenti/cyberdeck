/** Read-only browser verification of the installed Sessions routes.
 * CYBERDECK_TEST_ORIGIN=http://127.0.0.1:<private-tunnel>
 * CYBERDECK_TEST_TOKEN_HOST=<ssh-alias> (omit for local token file).
 * Separate Chromium context; no terminal attachment, process creation, kiosk attachment or write.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const origin = process.env.CYBERDECK_TEST_ORIGIN || "http://127.0.0.1:4777";
const host = process.env.CYBERDECK_TEST_TOKEN_HOST;
const token = host ? (() => {
  const child = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "cat ~/.cyberdeck/token"]);
  if (child.exitCode) throw new Error("Cannot read token on requested host");
  return child.stdout.toString().trim();
})() : readFileSync(join(homedir(), ".cyberdeck/token"), "utf8").trim();
if (!token) throw new Error("Empty credential file");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
await context.addInitScript(value => localStorage.setItem("cyberdeck-token", value), token);
const errors: string[] = [], mutations: string[] = [], passed: string[] = [];
await context.route("**/*", route => {
  const req = route.request(), url = new URL(req.url());
  if (url.origin !== new URL(origin).origin) return route.abort();
  if (url.pathname.startsWith("/api/") && req.method() !== "GET") { mutations.push(`${req.method()} ${url.pathname}`); return route.abort(); }
  return route.continue();
});
await context.routeWebSocket("**/*", socket => socket.close());
const page = await context.newPage();
page.setDefaultTimeout(25000);
page.on("pageerror", error => errors.push(error.message));
let stage = "New session form";
try {
  await page.goto(`${origin}/#/term?new=1&filter=self`);
  await page.getByTestId("term-new-node").waitFor();
  await page.waitForFunction(()=>document.title.startsWith("New session on ") && !document.title.includes("local ·"));
  const localTitle=await page.title();
  if(await page.getByTestId("term-new-node").inputValue()!=="")throw new Error("Unexpected local target");
  const options=await page.getByTestId("term-new-node").locator("option").evaluateAll(options=>options.map(o=>({value:(o as HTMLOptionElement).value,disabled:(o as HTMLOptionElement).disabled})).filter(o=>o.value&&!o.disabled));
  if(options.length){
    stage="Destination history";
    await page.getByTestId("term-new-node").selectOption(options[0].value);
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).has("target"));
    const url=page.url(),target=options[0].value;
    await page.goBack();await page.waitForFunction(title=>document.title===title,localTitle);
    await page.goForward();await page.waitForFunction(target=>new URLSearchParams(location.hash.split("?")[1]).get("target")===target,target);
    await page.reload();await page.getByTestId("term-new-node").waitFor();
    if(await page.getByTestId("term-new-node").inputValue()!==target)throw new Error("Reload lost destination");
    const tab=await context.newPage();try{await tab.goto(url);await tab.getByTestId("term-new-node").waitFor();if(await tab.getByTestId("term-new-node").inputValue()!==target)throw new Error("Fresh tab lost destination");}finally{await tab.close();}
    passed.push("target/history/reload/new-tab");
    await page.getByTestId("term-filter-node").selectOption(target);
    await page.waitForFunction(target=>new URLSearchParams(location.hash.split("?")[1]).get("filter")===target,target);
    await page.goBack();await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).get("filter")==="self");
    passed.push("machine filter history");
  }else passed.push("no online peer; local form restoration only");
  await page.reload();await page.getByTestId("term-new-form").waitFor();
  stage="Private draft retention";
  const cmd = page.getByPlaceholder("startup command (optional), e.g. claude --dangerously-skip-permissions");
  await cmd.fill("navigation fixture — never executed");
  const draftUrl = page.url();
  await page.getByTestId("nav-data").click();
  await page.goBack(); await page.getByTestId("term-new-form").waitFor();
  if(await cmd.inputValue()!=="navigation fixture — never executed")throw new Error("Leaving Sessions lost draft");
  if(page.url()!==draftUrl)throw new Error("Draft changed the shareable URL");
  await page.reload();await page.getByTestId("term-new-form").waitFor();
  if(await cmd.inputValue()!=="")throw new Error("Draft persisted through refresh");
  passed.push("draft navigation retention / refresh disposal / no URL leak");
  stage="Unknown filter";
  await page.evaluate(()=>location.hash="#/term?filter=__navigation_missing_machine");
  await page.waitForFunction(()=>document.title==="Machine not found · Sessions · Cyberdeck");
  await page.getByTestId("term-filter-error").waitFor();
  await page.reload(); await page.waitForFunction(()=>document.title==="Machine not found · Sessions · Cyberdeck");
  if(new URL(page.url()).hash.includes("session="))throw new Error("Unknown filter selected a session");
  passed.push("unknown filter/direct/reload/no fallback");
  stage="Read failure";
  // Only this fresh browser sees the synthetic failed list; the installed daemon
  // and real sessions are unchanged. Every fleet metadata request remains real.
  await page.route("**/api/sessions", route=>route.fulfill({status:503,json:{error:"Navigation fixture read failure"}}));
  await page.goto(`${origin}/?navigation-check=read-failure#/term?filter=self`);
  await page.getByTestId("term-unavailable").waitFor();
  await page.waitForFunction(()=>document.title.startsWith("Sessions unavailable · "));
  if(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).has("new"))throw new Error("Read failure became a New form");
  await page.reload();await page.getByTestId("term-unavailable").waitFor();
  await page.unroute("**/api/sessions");
  passed.push("synthetic list failure/title/reload/no false empty state");
  stage="Unknown machine";
  await page.evaluate(()=>location.hash="#/term?node=__navigation_missing_machine&session=__navigation_missing_session");
  await page.waitForFunction(()=>document.title==="Machine not found · Sessions · Cyberdeck");await page.getByTestId("term-unavailable").waitFor();
  await page.reload();await page.waitForFunction(()=>document.title==="Machine not found · Sessions · Cyberdeck");
  await page.getByTestId("nav-applications").click();await page.waitForFunction(()=>document.title==="Applications · Cyberdeck");
  passed.push("unknown machine/reload/title cleanup");
  if(errors.length||mutations.length)throw new Error(JSON.stringify({errors,mutations}));
  console.log(JSON.stringify({origin,passed,pageErrors:0,apiMutations:0}));
}catch(error){console.error(JSON.stringify({stage,passed,title:await page.title(),errors,mutations}));throw error;}
finally{await browser.close();}
