// Control module: the fleet dashboard. Projects, handoff, agent sessions, service
// probes, and the autonomous cc/cx collaboration loop, all sourced from the private
// Fleet repo through its `fleet` CLI (`<fleetDir>/bin/fleet.ts ... --json`). Steward
// owns scheduling, caching, log serving and events; the CLI owns the data format.
import type { Hono } from "hono";
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { StewardConfig } from "../config";
import { saveConfigPatch } from "../config";
import { bus } from "../events";

const FLEET_HOME = process.env.FLEET_HOME ?? join(homedir(), ".fleet");
const RUNS_DIR = join(FLEET_HOME, "runs");
const CACHE_MS = 20_000;
const CLI_TIMEOUT_MS = 60_000;
const PROBE_INTERVAL_MS = 5 * 60_000;
const RUN_POLL_MS = 15_000;
const LOG_FILES = new Set(["worker.log", "reviewer.log", "result.md"]);

type CliResult = { code: number; out: string; err: string };
export type ServiceProbe = { probedAt: string; rows: { host: string; service: string; type: string; state: string; ok: boolean | null; error?: string }[] };
export type CollabRun = { id: string; task: string; title: string; host: string; startedAt: string; finishedAt: string | null; status: string; step: string; verdict: string | null; dir: string };

function cliEnv(): Record<string, string> {
  const home = homedir();
  return { ...process.env, PATH: [join(home, ".bun", "bin"), join(home, ".local", "bin"), process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":") } as Record<string, string>;
}

/** Run the fleet CLI to completion. Uses the daemon's own bun so the service PATH is irrelevant. */
export async function fleetCli(fleetDir: string, args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
  const cli = join(fleetDir, "bin", "fleet.ts");
  const p = Bun.spawn([process.execPath, cli, ...args], { cwd: fleetDir, env: cliEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code: await p.exited, out, err };
}

/** Run a long CLI command detached; its output goes to a spawn log under ~/.fleet/runs. */
function fleetCliDetached(fleetDir: string, args: string[]): { log: string } {
  mkdirSync(RUNS_DIR, { recursive: true });
  const log = join(RUNS_DIR, `spawn-${Date.now()}.log`);
  const fd = openSync(log, "a");
  const p = Bun.spawn([process.execPath, join(fleetDir, "bin", "fleet.ts"), ...args], { cwd: fleetDir, env: cliEnv(), stdin: "ignore", stdout: fd, stderr: fd });
  p.unref();
  return { log };
}

function parseJson<T>(r: CliResult, fallback: T): T {
  // The CLI may print warnings before the JSON; take the last line that parses
  // AND has the shape we expect (array vs object), so a stray word never
  // masquerades as a status object.
  const wantArray = Array.isArray(fallback);
  const ok = (v: unknown) => (wantArray ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v));
  const candidates = [r.out.trim(), ...r.out.trim().split("\n").reverse()];
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (ok(v)) return v as T; } catch {}
  }
  return fallback;
}

function readTail(file: string, tail: number): { text: string; size: number } {
  const size = statSync(file).size;
  const start = Math.max(0, size - tail);
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(size - start);
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  return { text: buf.toString("utf8"), size };
}

function readRunMetas(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(RUNS_DIR)) return out;
  for (const d of readdirSync(RUNS_DIR)) {
    const meta = join(RUNS_DIR, d, "meta.json");
    if (!existsSync(meta)) continue;
    try { out[d] = String(JSON.parse(readFileSync(meta, "utf8")).status ?? ""); } catch {}
  }
  return out;
}

export function registerControlRoutes(app: Hono, cfg: StewardConfig) {
  const fleetDir = () => (cfg.fleetDir && existsSync(join(cfg.fleetDir, "bin", "fleet.ts")) ? cfg.fleetDir : null);

  // ---- cached CLI reads ----
  const cache = new Map<string, { at: number; value: unknown }>();
  const cached = async <T,>(key: string, args: string[], fallback: T): Promise<T> => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const dir = fleetDir();
    if (!dir) return fallback;
    const value = parseJson<T>(await fleetCli(dir, args), fallback);
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  const invalidate = (...keys: string[]) => keys.forEach((k) => cache.delete(k));

  // ---- service probes ----
  let lastProbe: ServiceProbe | null = null;
  let probing: Promise<ServiceProbe | null> | null = null;
  const probe = (): Promise<ServiceProbe | null> => {
    if (probing) return probing;
    const dir = fleetDir();
    if (!dir) return Promise.resolve(null);
    probing = (async () => {
      try {
        const r = parseJson<ServiceProbe | null>(await fleetCli(dir, ["services", "--json"], 90_000), null);
        if (r && Array.isArray(r.rows)) {
          lastProbe = r;
          bus.emit({ kind: "services", probedAt: r.probedAt, down: r.rows.filter((x) => x.ok === false).length });
        }
        return lastProbe;
      } finally {
        probing = null;
      }
    })();
    return probing;
  };

  // ---- collab scheduling + run watching ----
  const runs = () => cached<CollabRun[]>("collab.runs", ["collab", "runs", "--json"], []);
  const tasks = () => cached<unknown[]>("collab.tasks", ["collab", "list", "--json"], []);
  const startCollab = (args: string[], runId?: string) => {
    const dir = fleetDir();
    if (!dir) return null;
    const { log } = fleetCliDetached(dir, args);
    invalidate("collab.runs", "collab.tasks");
    bus.emit({ kind: "collab", runId: runId ?? null, status: "started", log });
    return { started: true, log };
  };
  const tick = async () => {
    invalidate("collab.runs");
    const active = (await runs()).some((r) => r.status === "running");
    if (active) return { started: false, reason: "a run is in progress" };
    return startCollab(["collab", "tick"]) ?? { started: false, reason: "no fleet dir" };
  };

  let autoTimer: ReturnType<typeof setInterval> | null = null;
  const applyAuto = () => {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    const c = cfg.collab ?? { auto: false, intervalMinutes: 30 };
    if (c.auto && fleetDir()) {
      autoTimer = setInterval(() => tick().catch((err) => console.error("collab tick failed:", err)), Math.max(1, c.intervalMinutes) * 60_000);
    }
  };

  if (fleetDir() && process.env.NODE_ENV !== "test") {
    setTimeout(() => probe().catch(() => {}), 10_000);
    setInterval(() => probe().catch(() => {}), PROBE_INTERVAL_MS);
    let seen = readRunMetas();
    setInterval(() => {
      const now = readRunMetas();
      for (const [id, status] of Object.entries(now)) {
        if (seen[id] !== status) {
          invalidate("collab.runs", "collab.tasks");
          bus.emit({ kind: "collab", runId: id, status });
        }
      }
      seen = now;
    }, RUN_POLL_MS);
    applyAuto();
  }

  // ---- routes ----
  const guard = (c: any) => (fleetDir() ? null : c.json({ error: "no fleet dir" }, 404));

  app.get("/api/control/overview", async (c) => {
    const g = guard(c); if (g) return g;
    const [status, projects, todo, handoff, taskList, runList] = await Promise.all([
      cached("status", ["status", "--json"], null),
      cached("projects", ["projects", "--json"], []),
      cached("todo", ["todo", "--json"], { sections: [] }),
      cached("handoff", ["handoff", "--json"], []),
      tasks(),
      runs(),
    ]);
    return c.json({ fleetDir: fleetDir(), status, projects, todo, handoff, collab: { tasks: taskList, runs: runList, auto: cfg.collab?.auto ?? false }, services: lastProbe });
  });

  app.get("/api/control/sessions", async (c) => {
    const g = guard(c); if (g) return g;
    const args = ["sessions", "--json"];
    const host = c.req.query("host"), tool = c.req.query("tool"), q = c.req.query("q");
    if (host) args.push("--host", host);
    if (tool) args.push("--tool", tool);
    if (q) args.push(q);
    return c.json(parseJson<unknown[]>(await fleetCli(fleetDir()!, args), []));
  });

  app.post("/api/control/sessions/pull", async (c) => {
    const g = guard(c); if (g) return g;
    const body = await c.req.json();
    const id = String(body.id ?? "").trim();
    if (!/^[\w-]+$/.test(id)) return c.json({ error: "bad session id" }, 400);
    const r = await fleetCli(fleetDir()!, ["sessions", "pull", id], 120_000);
    return c.json({ ok: r.code === 0, output: (r.out + r.err).trim() });
  });

  app.get("/api/control/services", (c) => {
    const g = guard(c); if (g) return g;
    return c.json(lastProbe ?? { probedAt: null, rows: [] });
  });
  app.post("/api/control/services/probe", async (c) => {
    const g = guard(c); if (g) return g;
    const r = await Promise.race([probe(), new Promise<null>((res) => setTimeout(() => res(null), 60_000))]);
    return c.json(r ?? lastProbe ?? { probedAt: null, rows: [], error: "probe did not finish in time" });
  });

  app.get("/api/control/collab", async (c) => {
    const g = guard(c); if (g) return g;
    const [t, r] = await Promise.all([tasks(), runs()]);
    return c.json({ tasks: t, runs: r, auto: cfg.collab?.auto ?? false, intervalMinutes: cfg.collab?.intervalMinutes ?? 30 });
  });
  app.post("/api/control/collab/tick", async (c) => {
    const g = guard(c); if (g) return g;
    return c.json(await tick());
  });
  app.post("/api/control/collab/run", async (c) => {
    const g = guard(c); if (g) return g;
    const body = await c.req.json();
    const id = String(body.id ?? "").trim();
    if (!/^[\w.-]+$/.test(id)) return c.json({ error: "bad task id" }, 400);
    return c.json(startCollab(["collab", "run", id], id) ?? { started: false });
  });
  app.post("/api/control/collab/add", async (c) => {
    const g = guard(c); if (g) return g;
    const b = await c.req.json();
    if (!b.title) return c.json({ error: "title required" }, 400);
    const args = ["collab", "add", "--title", String(b.title)];
    if (b.project) args.push("--project", String(b.project));
    if (b.host) args.push("--host", String(b.host));
    if (b.worker) args.push("--worker", String(b.worker));
    if (b.body) args.push("--body", String(b.body));
    const r = await fleetCli(fleetDir()!, args);
    invalidate("collab.tasks");
    return c.json({ ok: r.code === 0, id: r.out.trim().split("\n").pop() ?? "", output: (r.out + r.err).trim() });
  });
  app.post("/api/control/collab/auto", async (c) => {
    const g = guard(c); if (g) return g;
    const b = await c.req.json();
    const collab = { auto: Boolean(b.auto), intervalMinutes: Number(b.intervalMinutes ?? cfg.collab?.intervalMinutes ?? 30) || 30 };
    cfg.collab = collab;
    try { saveConfigPatch({ collab }); } catch (err) { return c.json({ error: `could not save config: ${err instanceof Error ? err.message : err}` }, 500); }
    applyAuto();
    return c.json({ ok: true, ...collab });
  });
  app.get("/api/control/collab/runs/:id/log", (c) => {
    const g = guard(c); if (g) return g;
    const id = c.req.param("id");
    const file = c.req.query("file") ?? "worker.log";
    if (!/^[\w.-]+$/.test(id) || !LOG_FILES.has(file)) return c.json({ error: "bad run or file" }, 400);
    const path = join(RUNS_DIR, id, file);
    if (!existsSync(path)) return c.json({ text: "", size: 0 });
    const tail = Math.min(2_000_000, Math.max(1000, Number(c.req.query("tail") ?? 20_000) || 20_000));
    return c.json(readTail(path, tail));
  });

  app.post("/api/control/sync", async (c) => {
    const g = guard(c); if (g) return g;
    const r = await fleetCli(fleetDir()!, ["sync"], 120_000);
    cache.clear();
    return c.json({ ok: r.code === 0, output: (r.out + r.err).trim() });
  });
}
