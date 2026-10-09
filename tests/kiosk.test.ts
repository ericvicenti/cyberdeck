import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createBrowserStreamHandlers } from "../src/daemon/browser";
import { registerKioskRoutes } from "../src/daemon/api/kiosk";
import { caseworkAllows, compileExperience } from "../src/daemon/api/casework";
import { testConfig } from "./helpers";

test("a Casework key can control the kiosk but cannot access other browser profiles", () => {
  expect(caseworkAllows("GET", "/api/kiosk/stream")).toBe(true);
  expect(caseworkAllows("POST", "/api/kiosk/stream")).toBe(false);
  expect(caseworkAllows("GET", "/api/browser/default/stream")).toBe(false);
  expect(caseworkAllows("GET", "/api/fs/list")).toBe(false);
});
test("kiosk is opt-in and requires authentication at the websocket boundary", async () => {
  for (const enabled of [true, false]) for (const authed of [true, false]) {
    const app = new Hono(); let handlers: any;
    const upgrade = (factory: any) => (c: any) => { handlers = factory(c); return c.text("ok"); };
    registerKioskRoutes(app, testConfig({ kiosk: { enabled } }), upgrade, () => authed);
    await app.request('/api/kiosk/stream');
    if (!enabled || !authed) { let code; handlers.onOpen(null, { close: (c: number) => code = c }); expect(code).toBe(1008); }
    else expect(typeof handlers.onMessage).toBe("function");
  }
});
test("physical screen keeps its viewport, validates input, and detaches without closing the kiosk", async () => {
  const commands: [string, any][] = []; let detached = false, contextClosed = false;
  const cdp = { on() {}, async send(name: string, args?: any) { commands.push([name, args]); }, async detach() { detached = true; } };
  const page = { viewportSize: () => null, evaluate: async () => ({width: 1920, height: 1080}), on() {}, off() {}, title: async () => "Cyberdeck", url: () => "http://enuc/#/fleet", setViewportSize() { throw new Error("must not resize TV"); } };
  const manager = { get: async () => ({ page, context: { newCDPSession: async () => cdp, close() { contextClosed = true; } } }) } as any;
  const messages: any[] = [];
  const h = createBrowserStreamHandlers(manager, "kiosk", { fixedViewport: true });
  await h.onOpen(null, { send: s => messages.push(JSON.parse(s)), close() {} });
  await h.onMessage({ data: JSON.stringify({ t: "resize", w: 600, h: 800 }) });
  await h.onMessage({ data: JSON.stringify({ t: "mouse", type: "mousePressed", x: 42, y: 31 }) });
  await h.onMessage({ data: JSON.stringify({ t: "mouse", type: "mousePressed", x: -2, y: 31 }) });
  expect(commands.filter(([name]) => name === "Input.dispatchMouseEvent")).toHaveLength(1);
  expect(messages.some(m => m.message === "rejected input")).toBe(true);
  await h.onClose(); expect(detached).toBe(true); expect(contextClosed).toBe(false);
});
test("remote screen compiles against the native modules shipped in Casework", async () => {
  const compiled = await compileExperience("screen-remote");
  expect(compiled.source).toContain("react-native-webview");
  expect(compiled.source).toContain("/#/remote");
});
