// Live sessions: daemon-owned PTYs that outlive the browser tab. A session is a
// shell (optionally with a startup command, e.g. an agent launch) that keeps
// running while nobody is attached; any number of WebSocket clients can attach,
// get the recent output replayed, and type into it.
//
// Runners:
//   pty   the daemon holds the PTY directly; the session dies with the daemon.
//   tmux  the shell lives in a tmux session (cd-<id>) and the daemon's PTY is a
//         tmux client. The session survives a daemon restart (self-update); on
//         boot we re-attach to every tmux session we still have a row for.
import { spawn as ptySpawn, type IPty } from "bun-pty";
import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { bus } from "./events";
import type { Caps, Runner, Tool } from "../shared/harness";

export type SessionState = "running" | "exited" | "lost";
export type SessionInfo = {
  id: string; title: string; cwd: string; cmd: string | null; tool: Tool; prompt: string | null; runner: Runner;
  state: SessionState; createdAt: number; exitedAt: number | null; exitCode: number | null;
  /** Live stats (not persisted). */
  clients: number; lastOutputAt: number | null; bells: number; busy: boolean;
};
export type CreateOpts = { cwd?: string; cmd?: string; title?: string; tool?: Tool; prompt?: string; runner?: Runner; cols?: number; rows?: number };
type Client = { send: (s: string) => void };
type Live = { info: SessionInfo; pty: IPty | null; clients: Set<Client>; buf: string[]; bufBytes: number; cols: number; rows: number };

const BUF_LIMIT = 256 * 1024;
const BUSY_MS = 3000;
const TMUX_PREFIX = "cd-";

export function expandHome(p: string | undefined | null): string {
  const home = homedir();
  if (!p) return home;
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

function loginShell(): string {
  return process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

async function sh(cmd: string[], timeoutMs = 8000): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const t = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    clearTimeout(t);
    return { code: await p.exited, out, err };
  } catch (e) {
    return { code: 127, out: "", err: String(e) };
  }
}

// ---- capabilities: what the user's login shell can see on this node ----
let capsCache: { at: number; caps: Caps } | null = null;
export async function detectCaps(force = false): Promise<Caps> {
  if (!force && capsCache && Date.now() - capsCache.at < 10 * 60_000) return capsCache.caps;
  const r = await sh([loginShell(), "-ilc", "for b in claude codex tmux; do if command -v $b >/dev/null 2>&1; then echo yes; else echo no; fi; done"], 15_000);
  const [cc, cx, tmuxFound] = r.out.trim().split("\n").map((l) => l.trim() === "yes");
  // CYBERDECK_SESSIONS_TMUX=0 forces the pty runner (tests, or a node where tmux should stay untouched).
  const tmux = tmuxFound && process.env.CYBERDECK_SESSIONS_TMUX !== "0";
  const cmux = ["/Applications/cmux.app/Contents/Resources/bin/cmux", "/usr/local/bin/cmux", "/opt/homebrew/bin/cmux"].some((p) => existsSync(p));
  const caps: Caps = { cc: !!cc, cx: !!cx, tmux: !!tmux, cmux };
  capsCache = { at: Date.now(), caps };
  return caps;
}

export class SessionManager {
  private live = new Map<string, Live>();
  private tmuxBin: string | null | undefined;

  constructor(private db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, cmd TEXT, tool TEXT NOT NULL DEFAULT 'shell',
      prompt TEXT, runner TEXT NOT NULL DEFAULT 'pty', state TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL, exited_at INTEGER, exit_code INTEGER)`);
  }

  /** Called once at boot: pty sessions from the previous process are gone; tmux ones may still be alive. */
  async recover(): Promise<void> {
    const rows = this.db.query("SELECT * FROM sessions WHERE state = 'running'").all() as any[];
    for (const r of rows) {
      if (r.runner === "tmux" && (await this.tmux(["has-session", "-t", TMUX_PREFIX + r.id])).code === 0) {
        const info = this.rowToInfo(r);
        this.live.set(r.id, { info, pty: null, clients: new Set(), buf: [], bufBytes: 0, cols: 120, rows: 32 });
        this.attachTmuxClient(this.live.get(r.id)!);
        console.log(`sessions: re-attached tmux session ${r.id} (${r.title})`);
      } else {
        this.db.query("UPDATE sessions SET state = 'lost', exited_at = $at WHERE id = $id").run({ $at: Date.now(), $id: r.id });
      }
    }
    // Rows that exited long ago are noise; keep a day of history.
    this.db.query("DELETE FROM sessions WHERE state != 'running' AND COALESCE(exited_at, created_at) < $cut").run({ $cut: Date.now() - 24 * 3600_000 });
  }

  private async tmux(args: string[], timeoutMs = 8000) {
    if (this.tmuxBin === undefined) {
      if (process.env.CYBERDECK_SESSIONS_TMUX === "0") return { code: 127, out: "", err: "tmux disabled" };
      const r = await sh([loginShell(), "-ilc", "command -v tmux"], 10_000);
      this.tmuxBin = r.code === 0 && r.out.trim() ? r.out.trim().split("\n").pop()! : null;
    }
    if (!this.tmuxBin) return { code: 127, out: "", err: "tmux not installed" };
    return sh([this.tmuxBin, ...args], timeoutMs);
  }

  private rowToInfo(r: any): SessionInfo {
    return { id: r.id, title: r.title, cwd: r.cwd, cmd: r.cmd ?? null, tool: r.tool, prompt: r.prompt ?? null, runner: r.runner, state: r.state, createdAt: r.created_at, exitedAt: r.exited_at ?? null, exitCode: r.exit_code ?? null, clients: 0, lastOutputAt: null, bells: 0, busy: false };
  }

  list(): SessionInfo[] {
    const rows = this.db.query("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 100").all() as any[];
    return rows.map((r) => this.snapshot(this.live.get(r.id)?.info ?? this.rowToInfo(r)));
  }
  get(id: string): SessionInfo | null {
    const l = this.live.get(id);
    if (l) return this.snapshot(l.info);
    const r = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    return r ? this.rowToInfo(r) : null;
  }
  private snapshot(info: SessionInfo): SessionInfo {
    const l = this.live.get(info.id);
    return { ...info, clients: l ? l.clients.size : 0, busy: info.state === "running" && !!info.lastOutputAt && Date.now() - info.lastOutputAt < BUSY_MS };
  }
  /** Running sessions that would die with this process (used to defer self-updates). */
  fragileCount(): number {
    let n = 0;
    for (const l of this.live.values()) if (l.info.state === "running" && l.info.runner === "pty") n++;
    return n;
  }

  async create(opts: CreateOpts): Promise<SessionInfo> {
    const id = randomBytes(4).toString("hex");
    let cwd = expandHome(opts.cwd);
    if (!existsSync(cwd)) cwd = homedir();
    const cmd = (opts.cmd ?? "").trim() || null;
    const tool: Tool = opts.tool ?? (cmd ? "shell" : "shell");
    let runner: Runner = opts.runner ?? "pty";
    const title = (opts.title ?? "").trim() || (cmd ? cmd.split(" ")[0] : cwd.split("/").pop() || "~");
    const info: SessionInfo = { id, title, cwd, cmd, tool, prompt: opts.prompt ?? null, runner, state: "running", createdAt: Date.now(), exitedAt: null, exitCode: null, clients: 0, lastOutputAt: null, bells: 0, busy: false };
    const live: Live = { info, pty: null, clients: new Set(), buf: [], bufBytes: 0, cols: opts.cols ?? 120, rows: opts.rows ?? 32 };

    if (runner === "tmux") {
      const name = TMUX_PREFIX + id;
      const r = await this.tmux(["new-session", "-d", "-s", name, "-c", cwd, "-x", String(live.cols), "-y", String(live.rows)]);
      if (r.code !== 0) { runner = info.runner = "pty"; info.title = title; console.warn(`sessions: tmux unavailable (${(r.err || r.out).trim().split("\n")[0]}); falling back to pty`); }
      else {
        await this.tmux(["set-option", "-t", name, "status", "off"]);
        if (cmd) await this.tmux(["send-keys", "-t", name, cmd, "Enter"]);
      }
    }
    this.db.query("INSERT INTO sessions (id, title, cwd, cmd, tool, prompt, runner, state, created_at) VALUES ($id, $title, $cwd, $cmd, $tool, $prompt, $runner, 'running', $at)")
      .run({ $id: id, $title: info.title, $cwd: cwd, $cmd: cmd, $tool: tool, $prompt: info.prompt, $runner: runner, $at: info.createdAt });
    this.live.set(id, live);
    if (runner === "tmux") this.attachTmuxClient(live);
    else this.spawnShell(live, cmd);
    bus.emit({ kind: "sessions", id, state: "running" });
    return this.snapshot(info);
  }

  private ptyEnv() {
    return { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG ?? "en_US.UTF-8", CYBERDECK_SESSION: "1" } as any;
  }
  private spawnShell(live: Live, cmd: string | null) {
    try {
      live.pty = ptySpawn(loginShell(), ["-il"], { name: "xterm-256color", cols: live.cols, rows: live.rows, cwd: live.info.cwd, env: this.ptyEnv() });
    } catch (err) {
      this.broadcast(live, `\r\nfailed to start shell: ${err}\r\n`);
      this.markExited(live, 127);
      return;
    }
    this.wire(live);
    if (cmd) live.pty.write(`${cmd}\n`);
  }
  private attachTmuxClient(live: Live) {
    try {
      live.pty = ptySpawn(this.tmuxBin!, ["attach-session", "-t", TMUX_PREFIX + live.info.id], { name: "xterm-256color", cols: live.cols, rows: live.rows, cwd: live.info.cwd, env: this.ptyEnv() });
    } catch (err) {
      this.broadcast(live, `\r\nfailed to attach tmux: ${err}\r\n`);
      this.markExited(live, 127);
      return;
    }
    this.wire(live);
  }
  private wire(live: Live) {
    const pty = live.pty!;
    pty.onData((data: string) => {
      live.info.lastOutputAt = Date.now();
      if (data.includes("\x07")) { live.info.bells += data.split("\x07").length - 1; bus.emit({ kind: "sessions", id: live.info.id, bell: true }); }
      live.buf.push(data);
      live.bufBytes += data.length;
      while (live.bufBytes > BUF_LIMIT && live.buf.length > 1) live.bufBytes -= live.buf.shift()!.length;
      const msg = JSON.stringify({ t: "data", data });
      for (const c of live.clients) try { c.send(msg); } catch {}
    });
    pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (live.pty !== pty) return;
      live.pty = null;
      this.markExited(live, exitCode);
    });
  }
  private broadcast(live: Live, text: string) {
    const msg = JSON.stringify({ t: "data", data: text });
    for (const c of live.clients) try { c.send(msg); } catch {}
  }
  private markExited(live: Live, code: number) {
    if (live.info.state !== "running") return;
    live.info.state = "exited";
    live.info.exitedAt = Date.now();
    live.info.exitCode = code;
    this.db.query("UPDATE sessions SET state = 'exited', exited_at = $at, exit_code = $code WHERE id = $id").run({ $at: live.info.exitedAt, $code: code, $id: live.info.id });
    const msg = JSON.stringify({ t: "exit", code });
    for (const c of live.clients) try { c.send(msg); } catch {}
    bus.emit({ kind: "sessions", id: live.info.id, state: "exited", code });
  }

  /** Attach a client: replay the buffer, then stream. Returns a detach function. */
  attach(id: string, client: Client, size?: { cols: number; rows: number }): { ok: true; running: boolean; detach: () => void } | { ok: false; error: string } {
    const live = this.live.get(id);
    if (!live) { const row = this.get(id); return { ok: false, error: row ? `session ${row.state}` : "no such session" }; }
    client.send(JSON.stringify({ t: "hello", session: this.snapshot(live.info) }));
    if (live.buf.length) client.send(JSON.stringify({ t: "data", data: live.buf.join(""), replay: true }));
    if (live.info.state !== "running") client.send(JSON.stringify({ t: "exit", code: live.info.exitCode ?? 0 }));
    live.clients.add(client);
    if (size) this.resize(id, size.cols, size.rows);
    return { ok: true, running: live.info.state === "running", detach: () => { live.clients.delete(client); } };
  }
  write(id: string, data: string): boolean {
    const live = this.live.get(id);
    if (!live?.pty) return false;
    live.pty.write(data);
    return true;
  }
  resize(id: string, cols: number, rows: number): void {
    const live = this.live.get(id);
    if (!live || !(cols > 0 && rows > 0)) return;
    live.cols = Math.min(500, cols | 0); live.rows = Math.min(200, rows | 0);
    try { live.pty?.resize(live.cols, live.rows); } catch {}
  }
  /** Kill the process (and its tmux session) and forget the row. */
  async remove(id: string): Promise<boolean> {
    const live = this.live.get(id);
    const row = this.get(id);
    if (!live && !row) return false;
    if (live) {
      try { live.pty?.kill(); } catch {}
      if (live.info.runner === "tmux") await this.tmux(["kill-session", "-t", TMUX_PREFIX + id]);
      for (const c of live.clients) try { c.send(JSON.stringify({ t: "exit", code: -1 })); } catch {}
      this.live.delete(id);
    }
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
    bus.emit({ kind: "sessions", id, state: "removed" });
    return true;
  }
  rename(id: string, title: string): boolean {
    const t = title.trim().slice(0, 120);
    if (!t) return false;
    const live = this.live.get(id);
    if (live) live.info.title = t;
    return this.db.query("UPDATE sessions SET title = ? WHERE id = ?").run(t, id).changes > 0;
  }
  /** Shut down daemon-held PTYs (tmux sessions keep running). */
  close(): void {
    for (const l of this.live.values()) { try { l.pty?.kill(); } catch {} }
    this.live.clear();
  }
}
