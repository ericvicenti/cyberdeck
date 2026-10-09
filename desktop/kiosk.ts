// The visible browser belongs to its own service, so daemon restarts don't close it.
import { chromium } from "playwright";
import { homedir } from "os";
import { join } from "path";
const url = process.env.CYBERDECK_KIOSK_URL;
if (!url || !/^https?:\/\//.test(url)) throw new Error("Set CYBERDECK_KIOSK_URL to this node's trusted Cyberdeck address");
for (;;) {
  try { const r = await fetch(`${url}/api/auth/whoami`, { signal: AbortSignal.timeout(5000) }); if (r.ok && (await r.json()).method !== "none") break; } catch {}
  await Bun.sleep(3000);
}
const context = await chromium.launchPersistentContext(join(homedir(), '.cyberdeck', 'kiosk-profile'), {
  headless: false, viewport: null, channel: "chromium", chromiumSandbox: true,
  ignoreDefaultArgs: ["--enable-automation"],
  args: ['--force-device-scale-factor=2', '--kiosk', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223', '--autoplay-policy=no-user-gesture-required'],
});
const page = context.pages()[0] ?? await context.newPage();
await page.goto(`${url}/#/fleet`, { waitUntil: 'domcontentloaded', timeout: 60000 });
context.on('page', async popup => { if (popup !== page) { await page.goto(popup.url()).catch(() => {}); await popup.close(); } });
context.on('close', () => process.exit(0));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => { await context.close(); process.exit(0); });
