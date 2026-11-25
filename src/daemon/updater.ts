import { transportFetch } from "./probe";
// Self-update + fleet convergence. Every node tracks its own git commit,
// periodically checks origin, and applies updates by pulling/rebuilding and
// then exiting - launchd/systemd (KeepAlive/Restart=always) brings it back on
// the new code. Nodes nudge peers whose commit differs, so an update pushed
// anywhere propagates across the fleet within minutes.
import { dirname, join } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import type { Database } from "bun:sqlite";
import { bus } from "./events";

export const SRC_ROOT = join(import.meta.dir, "../..");

async function run(cmd: string[], cwd = SRC_ROOT, env?: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
}

// Captured once at boot: this is the commit we are actually running, regardless of
// what the checkout's HEAD says later (another routine may have pulled ~/.cyberdeck/src
// out from under us). All "are we up to date?" math uses this as the base.
let bootShort: string | null = null;
let bootFull: string | null = null;
async function ensureBoot(): Promise<void> {
  if (bootShort && bootFull) return;
  const [s, f] = await Promise.all([
    run(["git", "rev-parse", "--short", "HEAD"]),
    run(["git", "rev-parse", "HEAD"]),
  ]);
  bootShort = s.code === 0 ? s.out : "unknown";
  bootFull = f.code === 0 ? f.out : "unknown";
}
export async function currentCommit(): Promise<string> {
  await ensureBoot();
  return bootShort ?? "unknown";
}

/** The outcome of the last `applyUpdate` call, kept in memory so the dashboard can show
 *  that the auto-updater has been failing silently (a diverged node retries every hour
 *  and quietly aborts; without this, the widget can only guess from the drift counts).
 *  `detail` is the trimmed error message or short success summary — safe to show.
 *  Also persisted to disk (see `setUpdatePersistPath`) so a daemon restart does not hide
 *  a chronic failure for up to an hour until the next auto-update cycle refills it. */
let lastAttempt: { at: number; ok: boolean; detail: string } | null = null;
export const getLastUpdateAttempt = () => lastAttempt;
/** Where `lastAttempt` is mirrored to disk; `null` (the default and the test mode) skips persistence entirely,
 *  so unit tests never touch the real ~/.cyberdeck. Main wires it to `~/.cyberdeck/last-update.json`. */
let persistPath: string | null = null;
export function setUpdatePersistPath(p: string | null): void {
  persistPath = p;
  if (!p) return;
  // Eager load: a restart's first dashboard read already sees the last recorded attempt,
  // closing the window where a chronic failure would be invisible between boot and the
  // next hourly auto-update cycle.
  try {
    if (!existsSync(p)) return;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (parsed && typeof parsed.at === "number" && typeof parsed.ok === "boolean" && typeof parsed.detail === "string") {
      lastAttempt = { at: parsed.at, ok: parsed.ok, detail: parsed.detail };
    }
  } catch (err) {
    console.error("updater: could not load persisted lastAttempt:", err);
  }
}
function persistLastAttempt(): void {
  if (!persistPath || !lastAttempt) return;
  try { writeFileSync(persistPath, JSON.stringify(lastAttempt)); }
  catch (err) { console.error("updater: could not persist lastAttempt:", err); }
}
/** Test-only: wipe the recorded attempt so an earlier run in the same process does not bleed in. */
export function resetLastUpdateAttempt(): void {
  lastAttempt = null;
  if (persistPath && existsSync(persistPath)) { try { unlinkSync(persistPath); } catch {} }
}

export async function checkForUpdate(): Promise<{ commit: string; behind: number; ahead: number; head?: string; error?: string }> {
  await ensureBoot();
  const commit = bootShort ?? "unknown";
  const fetch_ = await run(["git", "fetch", "--quiet", "origin"]);
  if (fetch_.code !== 0) return { commit, behind: 0, ahead: 0, error: `fetch failed: ${fetch_.err.slice(0, 200)}` };
  // Count from the commit we ACTUALLY run (boot) to origin/main. If something
  // else pulled the checkout, `HEAD..origin/main` would say 0 while we still
  // run pre-pull code; using the boot commit catches that case.
  const base = bootFull && bootFull !== "unknown" ? bootFull : "HEAD";
  const behindRes = await run(["git", "rev-list", "--count", `${base}..origin/main`]);
  // The reverse: commits the running daemon has that origin does not. A node
  // running local commits that were never pushed is drift too, and more urgent
  // than "behind origin" because no other machine has that code.
  const aheadRes = await run(["git", "rev-list", "--count", `origin/main..${base}`]);
  const headRes = await run(["git", "rev-parse", "--short", "HEAD"]);
  const head = headRes.code === 0 ? headRes.out : undefined;
  return {
    commit,
    behind: behindRes.code === 0 ? parseInt(behindRes.out, 10) || 0 : 0,
    ahead: aheadRes.code === 0 ? parseInt(aheadRes.out, 10) || 0 : 0,
    head,
  };
}

let updating = false;
export const isUpdating = () => updating;

/** Pull + rebuild; on success schedules process exit so the supervisor
 *  restarts us on the new code. Returns before the exit happens. */
export async function applyUpdate(): Promise<{ ok: boolean; detail: string }> {
  if (updating) return { ok: false, detail: "update already in progress" };
  updating = true;
  bus.emit({ kind: "update:start" });
  try {
    // `bun install` rewrites bun.lock in place on some bun versions, and a dirty lockfile makes
    // `git pull` refuse; the lockfile is regenerated right after the pull anyway.
    await run(["git", "checkout", "--", "bun.lock"]);
    const pull = await run(["git", "pull", "--ff-only", "--quiet", "origin", "main"]);
    if (pull.code !== 0) throw new Error(`git pull failed: ${pull.err.slice(0, 300)}`);
    // The service's PATH (launchd/systemd) may not include bun; we ARE bun. Package scripts that call
    // `bun` themselves (`bun run prepare:… && vite build`) need it on PATH too.
    const bun = process.execPath;
    const env = { ...process.env, PATH: `${dirname(bun)}:${process.env.PATH ?? "/usr/bin:/bin"}` };
    const install = await run([bun, "install"], SRC_ROOT, env);
    if (install.code !== 0) throw new Error(`bun install failed: ${install.err.slice(0, 300)}`);
    const build = await run([bun, "run", "build"], SRC_ROOT, env);
    if (build.code !== 0) throw new Error(`build failed: ${build.err.slice(0, 300)}`);
    const target = await run(["git", "rev-parse", "--short", "HEAD"]);
    bus.emit({ kind: "update:restarting", commit: target.out });
    console.log(`updated to ${target.out}; restarting`);
    const detail = `updated to ${target.out}, restarting`;
    lastAttempt = { at: Date.now(), ok: true, detail };
    persistLastAttempt();
    // Give the HTTP response time to flush, then let the supervisor restart us.
    setTimeout(() => process.exit(0), 750);
    return { ok: true, detail };
  } catch (err) {
    const detail = String(err instanceof Error ? err.message : err);
    bus.emit({ kind: "update:failed", error: detail });
    console.error("self-update failed:", detail);
    lastAttempt = { at: Date.now(), ok: false, detail };
    persistLastAttempt();
    updating = false;
    return { ok: false, detail };
  }
}

// ---- fleet nudges: tell peers whose commit differs to check for updates ----
const lastNudge = new Map<string, number>();
const NUDGE_INTERVAL_MS = 10 * 60 * 1000;

export function nudgePeer(node: { id: string; url: string; token: string; probe_device?: string | null }): void {
  const last = lastNudge.get(node.id) ?? 0;
  if (Date.now() - last < NUDGE_INTERVAL_MS) return;
  lastNudge.set(node.id, Date.now());
  transportFetch(node, "/api/system/update", {
    method: "POST",
    headers: { authorization: `Bearer ${node.token}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

let lastSelfCheck = 0;
let guard: () => string | null = () => null;
/** Register a veto for automatic updates (e.g. live sessions that would die). Manual updates ignore it. */
export function setUpdateGuard(fn: () => string | null): void { guard = fn; }
export function maybeSelfUpdate(reason: string): void {
  if (updating || Date.now() - lastSelfCheck < NUDGE_INTERVAL_MS) return;
  lastSelfCheck = Date.now();
  checkForUpdate()
    .then((r) => {
      if (r.behind > 0) {
        const veto = guard();
        if (veto) { console.log(`auto-update (${reason}) deferred: ${veto}`); lastSelfCheck = 0; return; }
        console.log(`auto-update (${reason}): ${r.behind} commit(s) behind origin`);
        return applyUpdate();
      }
    })
    .catch((err) => console.error("auto-update check failed:", err));
}

/** Hourly origin check, plus a peer sweep so fleets converge even when no
 *  browser is open anywhere (UI fleet probes also nudge, faster). */
export function startAutoUpdater(db: Database): () => void {
  const tick = () => maybeSelfUpdate("periodic");
  const sweep = async () => {
    const mine = await currentCommit();
    const rows = db.query("SELECT id, name, url, token, probe_device FROM nodes").all() as {
      id: string; name: string; url: string; token: string;
    }[];
    for (const node of rows) {
      try {
        const res = await Promise.race([
          transportFetch(node, "/api/status", {
            headers: { authorization: `Bearer ${node.token}` },
            signal: AbortSignal.timeout(4000),
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500)),
        ]);
        if (!res.ok) continue;
        db.query("UPDATE nodes SET last_seen = ? WHERE id = ?").run(Date.now(), node.id);
        const status = await res.json();
        if (status.commit && status.commit !== mine) {
          console.log(`peer ${node.name} on ${status.commit} (we are ${mine}); nudging both`);
          nudgePeer(node);
          maybeSelfUpdate(`peer ${node.name} differs`);
        }
      } catch {}
    }
  };
  const iv = setInterval(tick, 60 * 60 * 1000);
  const sweepIv = setInterval(sweep, 15 * 60 * 1000);
  setTimeout(tick, 90 * 1000); // shortly after boot, off the critical path
  setTimeout(sweep, 3 * 60 * 1000);
  return () => {
    clearInterval(iv);
    clearInterval(sweepIv);
  };
}
