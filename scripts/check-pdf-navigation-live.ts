/** Installed PDF smoke check. Supply CYBERDECK_TEST_PDF with the path of the
 * original navigation fixture created for this run (never a user's document).
 * CYBERDECK_TEST_ORIGIN and optional CYBERDECK_TEST_TOKEN_HOST use existing private
 * SSH/loopback access. Only reads; no terminal, kiosk, media or application actions. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const origin = new URL(process.env.CYBERDECK_TEST_ORIGIN || "http://127.0.0.1:4777").origin;
const file = process.env.CYBERDECK_TEST_PDF;
if (!file || !file.includes("/cyberdeck-navigation-") || !file.endsWith("/navigation.pdf")) throw new Error("Supply this run's original navigation.pdf fixture path");
const host = process.env.CYBERDECK_TEST_TOKEN_HOST;
const token = host ? (() => {
  const child = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "cat ~/.cyberdeck/token"]);
  if (child.exitCode) throw new Error("Cannot read requested host credential");
  return child.stdout.toString().trim();
})() : readFileSync(join(homedir(), ".cyberdeck/token"), "utf8").trim();
if (!token) throw new Error("Empty credential file");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
await context.addInitScript(({ origin, token }) => { if (location.origin === origin) localStorage.setItem("cyberdeck-token", token); }, { origin, token });
const errors: string[] = [], mutations: string[] = [], passed: string[] = [];
let reads = 0;
await context.route("**/*", route => {
  const req = route.request(), url = new URL(req.url());
  if (url.origin !== origin) return route.abort();
  if (url.pathname.startsWith("/api/") && req.method() !== "GET") { mutations.push(`${req.method()} ${url.pathname}`); return route.abort(); }
  if (url.pathname.endsWith("/fs/read")) {
    if (url.searchParams.get("path") !== file) return route.abort();
    if (url.searchParams.has("token")) throw new Error("PDF renderer put credential in URL");
    reads++;
  }
  return route.continue();
});
await context.routeWebSocket("**/*", socket => socket.close());
const page = await context.newPage(); page.setDefaultTimeout(20000);
page.on("pageerror", error => errors.push(error.name));
const rendered = (n: number) => page.locator(`[data-testid=pdf-page][data-page="${n}"]`).waitFor({ state: "visible" });
const param = (key: string) => page.evaluate(key => new URLSearchParams(location.hash.split("?")[1]).get(key), key);
let stage = "direct link";
try {
  await page.goto(`${origin}/#/edit?${new URLSearchParams({ path: file, page: "2", zoom: "100" })}`); await rendered(2);
  await page.waitForFunction(() => document.title === "navigation.pdf · Page 2 of 3 · PDF · Cyberdeck");
  if (!(await page.getByTestId("pdf-page").textContent())?.includes("Navigation fixture page 2")) throw new Error("Wrong fixture content");
  passed.push(stage); stage = "one-entry history and retained document";
  const length = await page.evaluate(() => history.length), initialReads = reads;
  await page.getByRole("button", { name: "Next page", exact: true }).click(); await rendered(3);
  if (await page.evaluate(() => history.length) !== length + 1) throw new Error("History entry count differs");
  await page.goBack(); await rendered(2); await page.goForward(); await rendered(3);
  await page.getByTestId("nav-services").click(); await page.waitForFunction(() => document.title === "Services · Cyberdeck");
  await page.goBack(); await rendered(3);
  if (reads !== initialReads) throw new Error("Returning to retained PDF fetched again");
  passed.push(stage); stage = "reload and fresh tab";
  const shared = page.url(); await page.reload(); await rendered(3);
  const fresh = await context.newPage(); await fresh.goto(shared); await fresh.locator('[data-testid=pdf-page][data-page="3"]').waitFor();
  if (await fresh.title() !== "navigation.pdf · Page 3 of 3 · PDF · Cyberdeck") throw new Error("Fresh title differs");
  await fresh.close(); passed.push(stage); stage = "missing page";
  await page.getByLabel("PDF page", { exact: true }).fill("999"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.waitForFunction(() => document.title === "navigation.pdf · PDF page not found · Cyberdeck");
  if (await param("page") !== "999") throw new Error("Missing selection was lost");
  await page.goBack(); await rendered(3); passed.push(stage); stage = "missing file through actual daemon metadata";
  const missing = `${file}.missing.pdf`;
  await page.goto(`${origin}/#/edit?${new URLSearchParams({ path: missing, page: "2" })}`);
  await page.waitForFunction(() => document.title.includes("PDF not found"));
  if (await param("path") !== missing) throw new Error("Missing file route was lost");
  await page.reload(); await page.waitForFunction(() => document.title.includes("PDF not found"));
  passed.push(stage);
  if (mutations.length || errors.length) throw new Error("Browser errors or writes observed");
  console.log(JSON.stringify({ origin, passed, reads, pageErrors: errors.length, writes: mutations.length }));
} catch {
  // Playwright exceptions can contain authenticated request details. Report only
  // the stage; credentials and headers never enter logs or the report.
  console.error(JSON.stringify({ origin, failedStage: stage, passed, pageErrors: errors.length, writes: mutations.length }));
  process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
