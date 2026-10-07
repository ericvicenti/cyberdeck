// cmux remote control: read and drive the cmux terminal multiplexer on this node through its CLI.
// Every argument is validated and passed as argv (no shell), so nothing from the browser can be injected.
import { CYBERDECK_HOME } from "../config";
import { join } from "path";
import type { Hono } from "hono";
import { readFileSync, existsSync } from "fs";

const CANDIDATES = ["/Applications/cmux.app/Contents/Resources/bin/cmux", "/usr/local/bin/cmux", "/opt/homebrew/bin/cmux"];
let binCache: string | null | undefined;
// cmux's socket is "cmuxOnly" by default (only processes started inside cmux may connect).
// With socketControlMode "password" in ~/.config/cmux/cmux.json, the same secret stored at
// ~/.cyberdeck/cmux-password (mode 0600) lets the daemon drive it.
function cmuxPasswordEnv(): Record<string, string> {
  try { const f = join(CYBERDECK_HOME, "cmux-password"); if (existsSync(f)) return { CMUX_SOCKET_PASSWORD: readFileSync(f, "utf8").trim() }; } catch {}
  return {};
}
export function cmuxBin(): string | null {
  if (binCache !== undefined) return binCache;
  for (const p of CANDIDATES) if (existsSync(p)) return (binCache = p);
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(`${dir}/cmux`)) return (binCache = `${dir}/cmux`);
  return (binCache = null);
}

const REF = /^(window|workspace|pane|surface|tab):\d{1,6}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRef = (s: unknown): s is string => typeof s === "string" && REF.test(s);
const KEY = /^[a-z0-9+_-]{1,32}$/i;

export async function cmux(args: string[], timeoutMs = 10_000): Promise<{ code: number; out: string; err: string }> {
  const bin = cmuxBin();
  if (!bin) return { code: 127, out: "", err: "cmux not installed" };
  const p = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CMUX_QUIET: "1", ...cmuxPasswordEnv() } });
  const t = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(t);
  return { code: await p.exited, out, err };
}

export type CmuxNode = { kind: "window" | "workspace" | "pane" | "surface"; ref: string; uuid?: string; title?: string; type?: string; selected: boolean; focused: boolean; current: boolean; active: boolean; tty?: string; url?: string; children: CmuxNode[] };

/** Parse `cmux tree --all` (box-drawing indented lines) into a nested structure. */
export function parseTree(text: string): CmuxNode[] {
  const roots: CmuxNode[] = [];
  const stack: CmuxNode[] = [];
  const rank = { window: 0, workspace: 1, pane: 2, surface: 3 } as const;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[\s│├└─]+/u, "");
    const m = line.match(/^(window|workspace|pane|surface)\s+(\S+)(?:\s+([0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}))?(.*)$/);
    if (!m) continue;
    const rest = m[4];
    const title = rest.match(/"((?:[^"\\]|\\.)*)"/)?.[1];
    const node: CmuxNode = {
      kind: m[1] as CmuxNode["kind"], ref: m[2], uuid: m[3], title,
      type: rest.match(/\[(terminal|browser|simulator|agent-session)\]/)?.[1],
      selected: /\[selected\]/.test(rest), focused: /\[focused\]/.test(rest), current: /\[current\]/.test(rest), active: /◀ active/.test(rest),
      tty: rest.match(/tty=(\S+)/)?.[1], url: rest.match(/(?:^|\s)((?:https?|file):\/\/\S+)/)?.[1], children: [],
    };
    while (stack.length && rank[stack[stack.length - 1].kind] >= rank[node.kind]) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node); else roots.push(node);
    stack.push(node);
  }
  return roots;
}

export function registerCmuxRoutes(app: Hono) {
  const gone = (c: any) => c.json({ available: false, error: "cmux is not installed on this node" }, 200);

  app.get("/api/cmux/tree", async (c) => {
    if (!cmuxBin()) return gone(c);
    const r = await cmux(["tree", "--all", "--id-format", "both"]);
    if (r.code !== 0) return c.json({ available: true, running: false, error: (r.err || r.out).trim().split("\n")[0] || "cmux is not running", tree: [] });
    const cur = await cmux(["current-workspace"]);
    return c.json({ available: true, running: true, current: cur.out.trim() || null, tree: parseTree(r.out) });
  });

  app.get("/api/cmux/screen", async (c) => {
    const surface = c.req.query("surface"), workspace = c.req.query("workspace");
    const lines = Math.min(2000, Math.max(1, Number(c.req.query("lines") ?? 200) | 0));
    const args = ["read-screen", "--lines", String(lines)];
    if (surface) { if (!isRef(surface)) return c.json({ error: "bad surface ref" }, 400); args.push("--surface", surface); }
    else if (workspace) { if (!isRef(workspace)) return c.json({ error: "bad workspace ref" }, 400); args.push("--workspace", workspace); }
    if (c.req.query("scrollback")) args.push("--scrollback");
    const r = await cmux(args);
    if (r.code !== 0) return c.json({ error: (r.err || r.out).trim() || "read-screen failed" }, 502);
    return c.json({ text: r.out });
  });

  const target = (body: any) => (isRef(body?.surface) ? ["--surface", body.surface] : isRef(body?.workspace) ? ["--workspace", body.workspace] : null);
  const run = async (c: any, args: string[]) => {
    const r = await cmux(args);
    return r.code === 0 ? c.json({ ok: true, output: r.out.trim() }) : c.json({ ok: false, error: (r.err || r.out).trim() || `exit ${r.code}` }, 502);
  };

  app.post("/api/cmux/send", async (c) => {
    const body = await c.req.json();
    const t = target(body);
    if (!t) return c.json({ error: "surface or workspace ref required" }, 400);
    const text = String(body.text ?? "");
    if (text.length > 20_000) return c.json({ error: "text too long" }, 400);
    if (text) { const r = await cmux(["send", ...t, text]); if (r.code !== 0) return c.json({ ok: false, error: (r.err || r.out).trim() }, 502); }
    if (body.enter) return run(c, ["send-key", ...t, "Enter"]);
    return c.json({ ok: true });
  });
  app.post("/api/cmux/key", async (c) => {
    const body = await c.req.json();
    const t = target(body);
    if (!t) return c.json({ error: "surface or workspace ref required" }, 400);
    if (!KEY.test(String(body.key ?? ""))) return c.json({ error: "bad key" }, 400);
    return run(c, ["send-key", ...t, String(body.key)]);
  });
  app.post("/api/cmux/select", async (c) => {
    const body = await c.req.json();
    if (!isRef(body.workspace)) return c.json({ error: "bad workspace ref" }, 400);
    return run(c, ["select-workspace", "--workspace", body.workspace]);
  });
  app.post("/api/cmux/workspace", async (c) => {
    const body = await c.req.json();
    const args = ["new-workspace", "--focus", body.focus ? "true" : "false"];
    if (body.name) args.push("--name", String(body.name).slice(0, 120));
    if (body.cwd) { if (!/^\/[^\0]{0,1024}$/.test(String(body.cwd))) return c.json({ error: "bad cwd" }, 400); args.push("--cwd", String(body.cwd)); }
    if (body.command) args.push("--command", String(body.command).slice(0, 4000));
    return run(c, args);
  });
  app.post("/api/cmux/close", async (c) => {
    const body = await c.req.json();
    if (!isRef(body.workspace)) return c.json({ error: "bad workspace ref" }, 400);
    return run(c, ["close-workspace", "--workspace", body.workspace]);
  });
}
