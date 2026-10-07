// Live session routes: create/list/kill daemon-owned sessions and attach to one
// over a WebSocket (same wire format as /api/term: {t:"data"|"input"|"resize"|"exit"},
// plus {t:"hello", session} first and `replay:true` on the buffered backlog).
import type { Hono } from "hono";
import { SessionManager, detectCaps, type CreateOpts } from "../sessions";
import type { Runner, Tool } from "../../shared/harness";

const TOOLS = new Set<Tool>(["cc", "cx", "shell"]);
const RUNNERS = new Set<Runner>(["tmux", "pty"]);
const ID = /^[0-9a-f]{8}$/;

export function registerSessionRoutes(app: Hono, mgr: SessionManager, upgradeWebSocket: any, isAuthed: (c: any) => boolean) {
  app.get("/api/harness/caps", async (c) => c.json(await detectCaps(Boolean(c.req.query("refresh")))));

  app.get("/api/sessions", (c) => c.json({ sessions: mgr.list() }));
  app.get("/api/sessions/:id", (c) => {
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
    return mgr.rename(c.req.param("id"), String(b.title ?? "")) ? c.json({ ok: true }) : c.json({ error: "no such session" }, 404);
  });
  app.delete("/api/sessions/:id", async (c) => (await mgr.remove(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "no such session" }, 404)));

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
