// Live session routes: create/list/kill daemon-owned sessions and attach to one
// over a WebSocket (same wire format as /api/term: {t:"data"|"input"|"resize"|"exit"},
// plus {t:"hello", session} first and `replay:true` on the buffered backlog).
import { SeedBridge } from "../seed";
import { hostname, platform } from "os";
import type { Hono } from "hono";
import { SessionManager, detectCaps, type CreateOpts } from "../sessions";
import type { Runner, Tool } from "../../shared/harness";

const TOOLS = new Set<Tool>(["seed", "cc", "cx", "shell"]);
const RUNNERS = new Set<Runner>(["agent", "tmux", "pty"]);
const ID = /^[0-9a-f]{8}$/;

/** The last JSON value a CLI printed (it may log lines before it), or null. */
export function parseLastJson(out: string): any {
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  try { return JSON.parse(out); } catch { return null; }
}

export type SessionContextDeps = {
  nodeName?: string;
  /** The Deck project owning a directory (`deck projects --for`), or null. */
  project?: (dir: string) => Promise<{ slug?: string; name?: string; status?: string } | null>;
};

const expandHome = (p: string) => (p === "~" ? process.env.HOME ?? p : p.startsWith("~/") ? `${process.env.HOME ?? "~"}${p.slice(1)}` : p);
async function gitLine(dir: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", "-C", expandHome(dir), "status", "--porcelain=v2", "--branch"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 3000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    if ((await p.exited) !== 0) return null;
    const head = out.match(/^# branch\.head (.+)$/m)?.[1];
    const ab = out.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
    const dirty = out.split("\n").filter((l) => /^[12u?] /.test(l)).length;
    return `Git: ${head ?? "detached"}${dirty ? `, ${dirty} uncommitted` : ", clean"}${ab ? `${Number(ab[1]) ? `, ${ab[1]} ahead` : ""}${Number(ab[2]) ? `, ${ab[2]} behind` : ""}` : ", no upstream"}`;
  } catch { return null; }
}

/**
 * The context lines a prompt-bar turn carries to the Seed agent (api/sessions message): the machine
 * the user chose, the directory, its project and git state, and the time. Cheap (one git status).
 */
export async function turnContext(cwd: string, nodeName: string | undefined, deps: SessionContextDeps): Promise<string[]> {
  const here = deps.nodeName ?? hostname();
  const local = !nodeName || nodeName === "local" || nodeName.toLowerCase() === here.toLowerCase();
  const lines = [`Fleet machine: ${local ? `${here} (this node; hostname ${hostname()}, ${platform()})` : `${nodeName} (another fleet host: use the shell tool with host "${nodeName}")`}`, `Working directory: ${cwd.slice(0, 1024)}`];
  if (local) {
    const [project, git] = await Promise.all([deps.project?.(expandHome(cwd)).catch(() => null) ?? null, gitLine(cwd)]);
    if (project?.slug || project?.name) lines.push(`Project: ${project.name ?? project.slug}${project.slug ? ` (${project.slug})` : ""}${project.status ? `, ${project.status}` : ""}`);
    if (git) lines.push(git);
  }
  lines.push(`Time: ${new Date().toISOString()}`);
  return lines;
}

export function registerSessionRoutes(app: Hono, mgr: SessionManager, upgradeWebSocket: any, isAuthed: (c: any) => boolean, seed: SeedBridge, ctx: SessionContextDeps = {}) {
  app.get("/api/harness/caps", async (c) => {
    const [caps, ready] = await Promise.all([detectCaps(Boolean(c.req.query("refresh"))), seed.queryReady()]);
    return c.json({ ...caps, seed: ready, seedUrl: seed.config.agentsUrl });
  });


  app.get("/api/sessions", async (c) => {
    let seedError: string | undefined;
    const queries = await seed.querySessions().catch((e) => { seedError = e.message; return []; });
    return c.json({ sessions: [...mgr.list(), ...queries], seedError });
  });
  app.get("/api/sessions/:id/transcript", async (c) => {
    const id = c.req.param("id");
    if (!id.startsWith("seed-")) return c.json({ error: "not a Seed query" }, 400);
    const before = c.req.query("beforeSeq");
    if (before && (!Number.isSafeInteger(Number(before)) || Number(before) < 1)) return c.json({ error: "bad beforeSeq" }, 400);
    return c.json(await seed.getQuery(id.slice(5), before ? Number(before) : undefined));
  });
  app.post("/api/sessions/:id/message", async (c) => {
    const id = c.req.param("id");
    const b = await c.req.json().catch(() => ({}));
    if (!id.startsWith("seed-") || typeof b.text !== "string" || !b.text.trim() || b.text.length > 8000) return c.json({ error: "Seed query and text (1–8000 characters) required" }, 400);
    const context = typeof b.cwd === "string" ? await turnContext(b.cwd, typeof b.nodeName === "string" ? b.nodeName : undefined, ctx) : undefined;
    await seed.messageQuery(id.slice(5), b.text.trim(), context, typeof b.clientMessageId === "string" ? b.clientMessageId : undefined);
    return c.json({ ok: true });
  });
  app.post("/api/sessions/:id/stop", async (c) => {
    const id = c.req.param("id");
    if (!id.startsWith("seed-")) return c.json({ error: "not a Seed query" }, 400);
    await seed.getQuery(id.slice(5));
    await seed.action({ _: "StopSession", sessionId: id.slice(5) });
    return c.json({ ok: true });
  });
  app.get("/api/sessions/:id", async (c) => {
    if (c.req.param("id").startsWith("seed-")) return c.json(seed.queryInfo((await seed.getQuery(c.req.param("id").slice(5))).session));
    const s = mgr.get(c.req.param("id"));
    return s ? c.json(s) : c.json({ error: "no such session" }, 404);
  });
  app.post("/api/sessions", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const opts: CreateOpts = {};
    if (b.cwd != null) { if (typeof b.cwd !== "string" || b.cwd.length > 1024 || b.cwd.includes("\0")) return c.json({ error: "bad cwd" }, 400); opts.cwd = b.cwd; }
    if (b.cmd != null) { if (typeof b.cmd !== "string" || b.cmd.length > 8000) return c.json({ error: "bad cmd" }, 400); opts.cmd = b.cmd; }
    if (b.title != null) opts.title = String(b.title).slice(0, 120);
    if (b.prompt != null) opts.prompt = String(b.prompt).slice(0, 8000);
    if (b.tool != null) { if (!TOOLS.has(b.tool as Tool)) return c.json({ error: "bad tool" }, 400); opts.tool = b.tool as Tool; }
    if (b.runner != null) { if (!RUNNERS.has(b.runner as Runner)) return c.json({ error: "bad runner" }, 400); opts.runner = b.runner as Runner; }
    if (typeof b.cols === "number" && typeof b.rows === "number") { opts.cols = b.cols; opts.rows = b.rows; }
    if (opts.tool === "seed") {
      try { return c.json(await seed.createQuery(opts.title || "Seed query"), 201); }
      catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 503); }
    }
    if (opts.runner === "agent") return c.json({ error: "agent runner requires Seed" }, 400);
    return c.json(await mgr.create(opts), 201);
  });
  app.post("/api/sessions/:id/input", async (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json({ error: "bad id" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { data?: unknown; enter?: unknown };
    const data = typeof b.data === "string" ? b.data : "";
    if (data.length > 20_000) return c.json({ error: "too long" }, 400);
    const ok = mgr.write(id, data + (b.enter ? "\r" : ""));
    return ok ? c.json({ ok: true }) : c.json({ error: "session is not running" }, 409);
  });
  app.post("/api/sessions/:id/rename", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    if (c.req.param("id").startsWith("seed-")) {
      const sessionId = c.req.param("id").slice(5);
      await seed.getQuery(sessionId);
      await seed.action({ _: "UpdateSession", sessionId, title: String(b.title ?? "").trim().slice(0, 120) });
      return c.json({ ok: true });
    }
    return mgr.rename(c.req.param("id"), String(b.title ?? "")) ? c.json({ ok: true }) : c.json({ error: "no such session" }, 404);
  });
  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (id.startsWith("seed-")) {
      await seed.getQuery(id.slice(5));
      await seed.action({ _: "DeleteSession", sessionId: id.slice(5) });
      return c.json({ ok: true });
    }
    return await mgr.remove(id) ? c.json({ ok: true }) : c.json({ error: "no such session" }, 404);
  });

  app.get(
    "/api/sessions/:id/attach",
    upgradeWebSocket((c: any) => {
      if (!isAuthed(c)) return {};
      const id = c.req.param("id") as string;
      const cols = Number(c.req.query("cols")) || 0, rows = Number(c.req.query("rows")) || 0;
      let detach = () => {};
      return {
        onOpen(_ev: unknown, ws: { send: (s: string) => void; close: () => void }) {
          const r = mgr.attach(id, ws, cols && rows ? { cols, rows } : undefined);
          if (!r.ok) { ws.send(JSON.stringify({ t: "data", data: `\r\n${r.error}\r\n` })); ws.send(JSON.stringify({ t: "exit", code: -1 })); ws.close(); return; }
          detach = r.detach;
          // An exited session still replays its final screen, then the socket closes.
          if (!r.running) { detach(); ws.close(); }
        },
        onMessage(ev: { data: unknown }) {
          try {
            const m = JSON.parse(String(ev.data));
            if (m.t === "input" && typeof m.data === "string") mgr.write(id, m.data);
            else if (m.t === "resize") mgr.resize(id, m.cols, m.rows);
          } catch {}
        },
        onClose() { detach(); },
      };
    })
  );
}
