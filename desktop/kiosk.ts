import { watchPads } from "../src/daemon/api/games";
// The visible browser belongs to its own service, so daemon restarts don't close it.
import { chromium } from "playwright";
import { homedir } from "os";
import { join } from "path";
import { readFile, rename, writeFile } from "fs/promises";
import { attachInputBridge } from "./input-bridge";

// Loopback is a secure browser context (required for Gamepad API). Authenticate
// only this exact origin, inside the browser, without a token URL or command line.
const configured = new URL(
  process.env.CYBERDECK_KIOSK_URL || "http://127.0.0.1:4777",
);
if (configured.protocol !== "http:" && configured.protocol !== "https:")
  throw new Error("Invalid kiosk URL");
const origin = `http://127.0.0.1:${configured.port || "4777"}`;
const dir = join(homedir(), ".cyberdeck");
const token = (await readFile(join(dir, "token"), "utf8")).trim();
if (!token) throw new Error("Cyberdeck token is missing");
for (;;) {
  try {
    const r = await fetch(`${origin}/api/auth/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok && (await r.json()).method !== "none") break;
  } catch {}
  await Bun.sleep(3000);
}
const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "input-entry.ts")],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!bundle.success)
  throw new Error(`Could not build kiosk input: ${bundle.logs.join("\n")}`);
const context = await chromium.launchPersistentContext(
  join(dir, "kiosk-profile"),
  {
    headless: false,
    viewport: null,
    channel: "chromium",
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--force-device-scale-factor=2",
      "--kiosk",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9223",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
);
const settingsFile = join(dir, "input.json");
await attachInputBridge(context, {
  origin,
  publicOrigin: configured.origin,
  load: async () => {
    try {
      return JSON.parse(await readFile(settingsFile, "utf8"));
    } catch {
      return null;
    }
  },
  save: async (settings) => {
    const temp = `${settingsFile}.tmp`;
    await writeFile(temp, JSON.stringify(settings, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temp, settingsFile);
  },
});
await context.addInitScript(
  ({ origin, token }) => {
    if (location.origin === origin)
      localStorage.setItem("cyberdeck-token", token);
  },
  { origin, token },
);
await context.addInitScript({ content: await bundle.outputs[0].text() });
const page = context.pages()[0] ?? (await context.newPage());
// Respect native Steam desktop focus instead of Playwright focus emulation.
const nativeFocus = await context.newCDPSession(page);
await page.goto(`${origin}/#/fleet`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await nativeFocus.send("Emulation.setFocusEmulationEnabled", { enabled: false });
// Read the physical controller outside Chromium so Steam/game input capture cannot trap the player.
let returningToVault = false;
let lastFinishedSteam = "";
const returnToVault = async () => {
  if (returningToVault) return;
  returningToVault = true;
  try {
    const response = await fetch(`${origin}/api/steam/return`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) console.warn("Steam window handoff failed; bringing Cyberdeck forward anyway");
    await page.evaluate(() => { location.hash = "#/applications?app=vimm&tab=steam"; });
    await page.bringToFront();
    await nativeFocus.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  } catch (e) { console.warn("Return to Vault failed:", String(e)); }
  finally { returningToVault = false; }
};
let stopSteamPadWatch: (() => void) | undefined;
let padRearm: ReturnType<typeof setTimeout> | undefined;
const armSteamReturn = () => {
  stopSteamPadWatch = watchPads(() => {
    stopSteamPadWatch?.();
    // Let Steam consume/release its Guide event before taking the screen back.
    padRearm = setTimeout(async () => {
      try { if (await page.evaluate(() => !document.hasFocus() && !document.documentElement.hasAttribute("data-tv-suspend"))) await returnToVault(); } catch {}
      armSteamReturn();
    }, 350);
  });
};
if (process.platform === "linux") armSteamReturn();
const steamExitPoll = setInterval(async () => {
  try {
    const response = await fetch(`${origin}/api/steam/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) return;
    const { session } = await response.json();
    if (session && ["ended", "error", "attention"].includes(session.phase) && lastFinishedSteam !== session.id + session.phase) {
      lastFinishedSteam = session.id + session.phase;
      await returnToVault();
    } else if (session && !["ended", "error", "attention"].includes(session.phase)) lastFinishedSteam = "";
  } catch {}
}, 2000);
context.on("page", async (popup) => {
  if (popup !== page) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    const url = popup.url();
    if (/^https?:\/\//.test(url)) await page.goto(url).catch(() => {});
    await popup.close().catch(() => {});
  }
});
context.on("close", () => process.exit(0));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    stopSteamPadWatch?.();
    clearTimeout(padRearm);
    clearInterval(steamExitPoll);
    await context.close();
    process.exit(0);
  });
