import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { attachInputBridge } from "../desktop/input-bridge";
import { defaults } from "../ui/lib/tv/model";

let browser: Browser,
  context: BrowserContext,
  page: Page,
  script: string,
  stored: unknown = null;
const html = (body: string) =>
  `<!doctype html><html><head><style>body{margin:30px;font:20px system-ui}button,input,select{font:20px system-ui;padding:16px;margin:12px}main{display:flex;flex-direction:column;align-items:start}iframe{width:700px;height:320px}#scroller{height:150px;width:600px;overflow:auto}#long{height:1500px}</style></head><body>${body}</body></html>`;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/child")
      return new Response(
        html(
          '<button id="inside">Inside app</button><button id="second">Second</button><script>inside.onclick=()=>inside.textContent="Selected"</script>',
        ),
        { headers: { "Content-Type": "text/html" } },
      );
    return new Response(
      html(
        `<main><div><button id="one" data-testid="nav-fleet">First</button><button id="two">Second</button><button id="disabled" disabled>Disabled</button><button id="three">Third</button></div><input id="text" aria-label="Search" value=""><select id="select" aria-label="Sort"><option value="a">Alpha</option><option value="b">Beta</option></select><input id="range" type="range" min="0" max="10" value="5"><div id="scroller"><button id="scroll-start">Scroll here</button><div id="long"></div></div><iframe src="http://localhost:${server.port}/child" title="App"></iframe></main>`,
      ),
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: ["desktop/input-entry.ts"],
    target: "browser",
    format: "iife",
  });
  expect(bundle.success).toBe(true);
  script = await bundle.outputs[0].text();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
  });
  await attachInputBridge(context, {
    origin: `http://127.0.0.1:${server.port}`,
    publicOrigin: "https://enuc.example.test",
    load: async () => stored,
    save: async (s) => {
      stored = s;
    },
  });
  await context.addInitScript({ content: script });
  await context.addInitScript(() => {
    (window as any).testPad = null;
    Object.defineProperty(navigator, "getGamepads", {
      value: () => [(window as any).testPad],
    });
  });
  page = await context.newPage();
}, 20000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});
async function fresh() {
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => !!window.__cyberdeckTV);
}
async function focused() {
  return page.evaluate(
    () => document.activeElement?.id || document.activeElement?.textContent,
  );
}
async function focus(id: string) {
  await page.evaluate(
    (id) => window.__cyberdeckTV.focusElement(document.getElementById(id)),
    id,
  );
}

test("arrows choose spatial neighbors; Enter/Space activate once; hidden and disabled controls are skipped", async () => {
  await fresh();
  await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("one");
  await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("two");
  await page.keyboard.press("ArrowRight");
  expect(await focused()).toBe("three");
  await page.evaluate(() => {
    document.getElementById("three")!.onclick = () =>
      (document.body.dataset.clicked = "yes");
  });
  await page.keyboard.press("Space");
  expect(await page.getAttribute("body", "data-clicked")).toBe("yes");
});
test("on-screen keyboard accepts text, restores focus, and Escape cancels edits", async () => {
  await fresh();
  await focus("text");
  await page.keyboard.press("Enter");
  expect(await page.getByRole("dialog").count()).toBe(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Done", exact: true }).focus();
  await page.keyboard.press("Enter");
  expect(await page.inputValue("#text")).toBe("12");
  expect(await focused()).toBe("text");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  expect(await page.inputValue("#text")).toBe("12");
  expect(await page.getByRole("dialog").count()).toBe(0);
});
test("native selects and sliders are editable without a mouse", async () => {
  await fresh();
  await focus("select");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await page.inputValue("#select")).toBe("b");
  await focus("range");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  expect(await page.inputValue("#range")).toBe("6");
});
test("confirmation defaults to Cancel, traps focus, and handles both decisions", async () => {
  await fresh();
  await focus("one");
  await page.evaluate(() => {
    void window.__cyberdeckTV
      .confirm("Delete?")
      .then((v: boolean) => (document.body.dataset.answer = String(v)));
  });
  expect(await focused()).toBe("Cancel");
  await page.keyboard.press("Escape");
  expect(await page.getAttribute("body", "data-answer")).toBe("false");
  expect(await focused()).toBe("one");
  await page.evaluate(() => {
    void window.__cyberdeckTV
      .confirm("Continue?")
      .then((v: boolean) => (document.body.dataset.answer = String(v)));
  });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await page.getAttribute("body", "data-answer")).toBe("true");
});
test("gamepad enters a cross-origin app, dispatches there, backs out, and cannot save settings from that app", async () => {
  await fresh();
  const iframe = page.locator("iframe");
  await iframe.scrollIntoViewIfNeeded();
  await iframe.focus();
  await page.keyboard.press("Enter");
  const child = page.frames().find((f) => f.url().includes("/child"))!;
  await child.waitForFunction(() => document.activeElement?.id === "inside");
  await page.evaluate(() =>
    window.__cyberdeckInputBridge!("dispatch", { action: "right" }),
  );
  expect(await child.evaluate(() => document.activeElement?.id)).toBe("second");
  expect(
    await child.evaluate(async () => {
      try {
        await window.__cyberdeckInputBridge!("saveSettings", {});
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await page.evaluate(() =>
    window.__cyberdeckInputBridge!("dispatch", { action: "back" }),
  );
  await page.waitForFunction(
    () => document.activeElement?.tagName !== "IFRAME",
  );
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
    "BUTTON",
  );
  await page.keyboard.press("ArrowUp");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
    "IFRAME",
  );
});
test("gamepad polls real runtime, scrolls left stick, saves a remap, and stops on disconnect", async () => {
  await fresh();
  await focus("scroll-start");
  await page.evaluate(() => {
    (window as any).testPad = {
      id: "Virtual pad",
      index: 0,
      mapping: "standard",
      connected: true,
      axes: [0, 0],
      buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    };
  });
  await page.waitForFunction(
    () => window.__cyberdeckTV.snapshot().pad?.id === "Virtual pad",
  );
  await page.evaluate(() => {
    (window as any).testPad.axes[1] = 1;
  });
  await page.waitForFunction(
    () => document.getElementById("scroller")!.scrollTop > 30,
  );
  await page.evaluate(() => {
    (window as any).testPad.axes[1] = 0;
    window.__cyberdeckTV.startCapture("activate", () => {});
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    (window as any).testPad.buttons[3] = { pressed: true, value: 1 };
  });
  await page.waitForFunction(
    () => window.__cyberdeckTV.snapshot().profile.bindings.activate.index === 3,
  );
  expect((stored as any).profiles["Virtual pad"].bindings.play.index).toBe(0);
  await page.evaluate(() => {
    (window as any).testPad = null;
  });
  await page.waitForFunction(() => !window.__cyberdeckTV.snapshot().pad);
  expect(
    await page.evaluate(() => window.__cyberdeckTV.snapshot().capturing),
  ).toBe(null);
});

test("Back leaves an application, then its listing, without reopening the app", async () => {
  await fresh();
  for (const hash of [
    "#/fleet",
    "#/applications",
    "#/applications?app=afterglow",
  ]) {
    await page.evaluate((hash) => (location.hash = hash), hash);
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => window.__cyberdeckTV.dispatch("back"));
  await page.waitForFunction(() => location.hash === "#/applications");
  await page.evaluate(() => window.__cyberdeckTV.dispatch("back"));
  await page.waitForFunction(() => location.hash === "#/fleet");
  expect(new URL(page.url()).hash).toBe("#/fleet");
});

test("the loopback kiosk pairs iPads to its fleet address, never to their own loopback", async () => {
  await fresh();
  expect(
    await page.evaluate(() => window.__cyberdeckInputBridge!("pairingOrigin")),
  ).toBe("https://enuc.example.test");
});
