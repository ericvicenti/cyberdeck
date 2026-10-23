// Tailscale serve/funnel parsing: what `cyberdeck serve mcp` publishes and what `cyberdeck mcp` reports.
import { describe, expect, test } from "bun:test";
import { Tailscale, parseFunnel, MCP_FUNNEL_PORT, MCP_PATH } from "../src/daemon/tailscale";

const HOST = "yacht.tail0bb35a.ts.net";
const status = (web: Record<string, Record<string, string>>, allow: Record<string, boolean> = {}) =>
  JSON.stringify({
    TCP: Object.fromEntries(Object.keys(web).map((hp) => [hp.split(":")[1], { HTTPS: true }])),
    Web: Object.fromEntries(Object.entries(web).map(([hp, handlers]) => [hp, { Handlers: Object.fromEntries(Object.entries(handlers).map(([p, proxy]) => [p, { Proxy: proxy }])) }])),
    ...(Object.keys(allow).length ? { AllowFunnel: allow } : {}),
  });

describe("tailscale funnel parsing", () => {
  test("tailnet-only serve publishes nothing", () => {
    const out = status({ [`${HOST}:443`]: { "/": "http://127.0.0.1:4777" } });
    expect(parseFunnel(out, 4777)).toEqual({ mcpUrl: null, rootPublic: null });
  });

  test("the MCP path on its own port is the public route", () => {
    const out = status(
      { [`${HOST}:443`]: { "/": "http://127.0.0.1:4777" }, [`${HOST}:${MCP_FUNNEL_PORT}`]: { [MCP_PATH]: `http://127.0.0.1:4777${MCP_PATH}` } },
      { [`${HOST}:${MCP_FUNNEL_PORT}`]: true },
    );
    expect(parseFunnel(out, 4777)).toEqual({ mcpUrl: `https://${HOST}:${MCP_FUNNEL_PORT}${MCP_PATH}`, rootPublic: null });
  });

  test("a funnel on another daemon's port is not ours", () => {
    const out = status({ [`${HOST}:10000`]: { "/": "http://127.0.0.1:18999" } }, { [`${HOST}:10000`]: true });
    expect(parseFunnel(out, 4777)).toEqual({ mcpUrl: null, rootPublic: null });
  });

  test("the whole UI funneled on 443 is flagged, not reported as the MCP route", () => {
    const out = status({ [`${HOST}:443`]: { "/": "http://127.0.0.1:4777", [MCP_PATH]: `http://127.0.0.1:4777${MCP_PATH}` } }, { [`${HOST}:443`]: true });
    expect(parseFunnel(out, 4777)).toEqual({ mcpUrl: null, rootPublic: `https://${HOST}` });
  });

  test("a port that carries more than the MCP path is not the scoped route", () => {
    const out = status({ [`${HOST}:8443`]: { [MCP_PATH]: `http://127.0.0.1:4777${MCP_PATH}`, "/other": "http://127.0.0.1:4777/other" } }, { [`${HOST}:8443`]: true });
    expect(parseFunnel(out, 4777)).toEqual({ mcpUrl: null, rootPublic: null });
  });

  test("AllowFunnel false, missing tailscale and garbage are all 'not public'", () => {
    const out = status({ [`${HOST}:8443`]: { [MCP_PATH]: `http://127.0.0.1:4777${MCP_PATH}` } }, { [`${HOST}:8443`]: false });
    expect(parseFunnel(out, 4777).mcpUrl).toBeNull();
    expect(parseFunnel(null, 4777)).toEqual({ mcpUrl: null, rootPublic: null });
    expect(parseFunnel("not json", 4777)).toEqual({ mcpUrl: null, rootPublic: null });
  });

  test("Tailscale.funnel runs `serve status --json` once per minute", async () => {
    const calls: string[][] = [];
    const ts = new Tailscale(async (args) => { calls.push(args); return status({ [`${HOST}:8443`]: { [MCP_PATH]: `http://127.0.0.1:4777${MCP_PATH}` } }, { [`${HOST}:8443`]: true }); });
    expect((await ts.funnel(4777)).mcpUrl).toBe(`https://${HOST}:8443${MCP_PATH}`);
    expect((await ts.funnel(4777)).mcpUrl).toBe(`https://${HOST}:8443${MCP_PATH}`);
    expect(calls).toEqual([["serve", "status", "--json"]]);
    expect((await ts.serveOrigin(4777))).toBeNull(); // 443 is not served in this fixture
  });
});
