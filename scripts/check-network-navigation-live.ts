/** Read-only browser verification of the installed Network Map.
 * CYBERDECK_TEST_ORIGIN=http://127.0.0.1:<private-tunnel>
 * CYBERDECK_TEST_TOKEN_HOST=<ssh-alias> (omit for local token file).
 * Separate Chromium context; no kiosk attachment, benchmark, playback or write.
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
const page = await context.newPage();
page.setDefaultTimeout(25000);
page.on("pageerror", error => errors.push(error.message));
let stage = "Home";
try {
  await page.goto(`${origin}/#/fleet`);
  await page.getByLabel("Network source", {exact:true}).waitFor();
  await page.waitForFunction(() => document.title === "Home · Cyberdeck");
  const source = await page.getByLabel("Network source",{exact:true}).inputValue();
  const targets = await page.getByLabel("Network target",{exact:true}).locator("option").evaluateAll(options => options.map(o=>(o as HTMLOptionElement).value).filter(Boolean));
  if (!targets.length) throw new Error("No network target available for live check");
  const target = targets[0];
  stage = "Explicit selection";
  await page.getByLabel("Network target",{exact:true}).selectOption(target);
  const title = `${source} → ${target} · Network · Cyberdeck`;
  await page.waitForFunction(title=>document.title===title,title);
  const url = page.url();
  const params = new URLSearchParams(new URL(url).hash.split("?")[1]);
  if (params.get("networkFrom")!==source || params.get("networkTo")!==target) throw new Error("Selection missing from URL");
  passed.push("actual telemetry endpoint selection/title");
  stage = "Back/Forward";
  await page.goBack(); await page.waitForFunction(()=>location.hash==="#/fleet" && document.title==="Home · Cyberdeck");
  await page.goForward(); await page.waitForFunction(title=>document.title===title,title);
  stage = "Reload";
  await page.reload(); await page.getByLabel("Network source",{exact:true}).waitFor();
  await page.waitForFunction(title=>document.title===title,title);
  if (await page.getByLabel("Network target",{exact:true}).inputValue()!==target) throw new Error("Reload changed endpoint");
  passed.push("history and reload");
  stage = "Fresh tab";
  const tab = await context.newPage(); tab.setDefaultTimeout(25000); tab.on("pageerror", e=>errors.push(e.message));
  await tab.goto(url); await tab.getByLabel("Network source",{exact:true}).waitFor();
  await tab.waitForFunction(title=>document.title===title,title);
  if (await tab.getByLabel("Network source",{exact:true}).inputValue()!==source || await tab.getByLabel("Network target",{exact:true}).inputValue()!==target) throw new Error("Fresh tab changed endpoint");
  await tab.close(); passed.push("fresh-tab restoration");
  stage = "Invalid endpoint";
  await page.evaluate(()=>location.hash="#/fleet?networkFrom=__navigation_missing_host_20261022&networkTo=__navigation_missing_target_20261022");
  await page.waitForFunction(()=>document.title.startsWith("Network host not found:"));
  if (await page.getByRole("button",{name:"Test connection ↗",exact:true}).isEnabled()) throw new Error("Invalid pair offers benchmark");
  await page.reload(); await page.waitForFunction(()=>document.title.startsWith("Network host not found:"));
  await page.getByRole("button",{name:"Clear selection",exact:true}).click();
  await page.waitForFunction(()=>document.title==="Home · Cyberdeck" && location.hash==="#/fleet");
  passed.push("missing hosts/reload/clear/title cleanup");
  stage = "Leaving Home";
  await page.getByTestId("nav-applications").click(); await page.waitForFunction(()=>document.title==="Applications · Cyberdeck");
  if(errors.length || mutations.length) throw new Error(JSON.stringify({errors,mutations}));
  console.log(JSON.stringify({origin,passed,pageErrors:0,apiMutations:0}));
} catch (error) {
  console.error(JSON.stringify({stage,passed,title:await page.title(),errors,mutations}));
  throw error;
} finally { await browser.close(); }
