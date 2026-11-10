// Freeing space by voice, for the `free_space` MCP tool ("make room on yacht"): the step after `disks` (it is
// nearly full) and `disk_usage` (this is what fills it). Only one kind of thing is ever deleted: rebuildable
// build output (the config's junkDirs: node_modules, target, .next, ...) at a repo's root or one level down,
// and only when all of these hold:
//   - the repo is idle: no commit and no change to the directory itself for `idleDays` (default 14);
//   - git ignores the directory (`git check-ignore`), so nothing tracked or unsaved can be in it;
//   - no running process works in the repo or names a path inside it (cwd from lsof, argv from ps), so a
//     service started from an old checkout (the Seed voice worktree) keeps its node_modules;
//   - it is a real directory, not a symlink, and not under ~/.cyberdeck.
// Two steps: `planCleanup` measures and keeps the plan PLAN_TTL_MS under a short id; `applyCleanup` re-checks
// every rule for every directory and removes it at background priority, one audit line per repo. The voice
// agent reads the plan to Eric and applies it only after he says yes. A rebuild is `bun install` / `cargo build`.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync } from "fs";
import { join, relative } from "path";
import { lowPriority } from "./indexer/du";
import { audit } from "./servicectl";
import { sizeWords } from "./disks";
import { tilde } from "./space";
import { CYBERDECK_HOME } from "./config";

export const PLAN_TTL_MS = 15 * 60_000;
export const DEFAULT_IDLE_DAYS = 14;
/** Repos with less build output than this are not worth a line. */
const MIN_REPO_BYTES = 100 * 1024 ** 2;
/** At most this many repos are measured for one plan (the biggest by the indexer's junk size). */
const MAX_REPOS = 60;

export type CleanupItem = { repo: string; dirs: string[]; bytes: number; idleDays: number };
export type CleanupPlan = {
  id: string;
  createdAt: number;
  expiresAt: number;
  idleDays: number;
  bytes: number;
  items: CleanupItem[];
  /** Repos with build output that the rules kept (counts by reason). */
  kept: { busy: number; recent: number; tracked: number };
};
export type CleanupResult = { id: string; freedBytes: number; removed: { repo: string; dirs: string[]; bytes: number }[]; skipped: { dir: string; why: string }[] };

const DAY = 86_400_000;
const plans = new Map<string, CleanupPlan & { abs: { repo: string; dirs: string[]; sizes: number[] }[] }>();

/** Paths running processes work in or name: every process's cwd (lsof) and every absolute path in an argv (ps). */
export async function busyPaths(): Promise<string[]> {
  const run = async (argv: string[]) => {
    try {
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const t = setTimeout(() => p.kill(), 15_000);
      const out = await new Response(p.stdout).text();
      await p.exited; clearTimeout(t);
      return out;
    } catch { return ""; }
  };
  const [cwds, cmds] = await Promise.all([run([existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof", "-nP", "-w", "-d", "cwd", "-Fn"]), run(["ps", "-axww", "-o", "command="])]);
  const out = new Set<string>();
  for (const l of cwds.split("\n")) if (l.startsWith("n/")) out.add(l.slice(1));
  for (const m of cmds.matchAll(/(?:^|[\s="'])(\/[^\s"':]+)/g)) out.add(m[1]);
  return [...out];
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** Junk dirs at the repo root and one package level down (packages/*, apps/*), as scan.ts sizes them. */
export function junkTargets(repo: string, junkDirs: string[]): string[] {
  const out: string[] = [];
  const add = (dir: string) => { for (const j of junkDirs) { const p = join(dir, j); if (existsSync(p)) out.push(p); } };
  add(repo);
  for (const sub of ["packages", "apps"]) {
    const d = join(repo, sub);
    if (!existsSync(d)) continue;
    try { for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) add(join(d, e.name)); } catch {}
  }
  return out;
}

/** Ignored by git (so derivable), a real directory, and untouched for `idleMs`. */
async function removable(repo: string, dir: string, idleMs: number, now: number): Promise<"ok" | "tracked" | "recent" | "gone"> {
  let st;
  try { st = lstatSync(dir); } catch { return "gone"; }
  if (!st.isDirectory() || st.isSymbolicLink()) return "gone";
  if (now - st.mtimeMs < idleMs) return "recent";
  const p = Bun.spawn(["git", "-C", repo, "check-ignore", "-q", relative(repo, dir)], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  return (await p.exited) === 0 ? "ok" : "tracked";
}

const MEASURE_BUDGET_MS = 20_000;

/** `du -sk` per directory at background priority until `budgetMs` runs out; the rest are left unmeasured. */
async function duWithin(paths: string[], budgetMs: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const end = Date.now() + budgetMs;
  for (const p of paths) {
    const left = end - Date.now();
    if (left <= 0) break;
    const proc = Bun.spawn([...lowPriority(), "du", "-sk", p], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const t = setTimeout(() => proc.kill(), left);
    const m = (await new Response(proc.stdout).text()).match(/^(\d+)\s/);
    await proc.exited; clearTimeout(t);
    if (m && !proc.signalCode) out.set(p, parseInt(m[1], 10) * 1024);
  }
  return out;
}

const newId = () => Math.random().toString(36).slice(2, 8);

export async function planCleanup(
  db: Database,
  junkDirs: string[],
  opts: { idleDays?: number; now?: number; busy?: string[]; measure?: (paths: string[]) => Promise<Map<string, number>> } = {},
): Promise<CleanupPlan> {
  const now = opts.now ?? Date.now();
  const idleDays = Math.max(3, Math.round(opts.idleDays ?? DEFAULT_IDLE_DAYS));
  const idleMs = idleDays * DAY;
  const busy = opts.busy ?? (await busyPaths());
  const rows = db.query("SELECT path, junk_bytes AS junk, last_commit_at AS last FROM repos WHERE junk_bytes >= ? ORDER BY junk_bytes DESC LIMIT ?").all(MIN_REPO_BYTES, MAX_REPOS) as { path: string; junk: number; last: number | null }[];
  const kept = { busy: 0, recent: 0, tracked: 0 };
  const chosen: { repo: string; dirs: string[]; last: number; junk: number; all: boolean }[] = [];
  for (const r of rows) {
    if (inside(r.path, CYBERDECK_HOME) || !existsSync(r.path)) continue;
    if (r.last === null || now - r.last < idleMs) { kept.recent++; continue; }
    if (busy.some((b) => inside(b, r.path))) { kept.busy++; continue; }
    const dirs: string[] = [];
    let tracked = false;
    const targets = junkTargets(r.path, junkDirs);
    for (const d of targets) {
      const why = await removable(r.path, d, idleMs, now);
      if (why === "ok") dirs.push(d);
      else if (why === "tracked") tracked = true;
    }
    if (dirs.length) chosen.push({ repo: r.path, dirs, last: r.last, junk: r.junk, all: dirs.length === targets.length });
    else if (tracked) kept.tracked++;
    else kept.recent++;
  }
  // A repo whose every junk dir goes is already sized by the indexer (du over a hundred node_modules takes
  // minutes on a loaded disk); only the partial ones are measured, within MEASURE_BUDGET_MS, and a dir du did
  // not reach in time gets its share of the repo's indexed size.
  const partial = chosen.filter((c) => !c.all || opts.measure).flatMap((c) => c.dirs);
  const sizes = await (opts.measure ?? ((p: string[]) => duWithin(p, MEASURE_BUDGET_MS)))(partial);
  const share = (c: (typeof chosen)[number]) => Math.round(c.junk / Math.max(1, junkTargets(c.repo, junkDirs).length));
  const sized = (c: (typeof chosen)[number]) => (c.all && !opts.measure ? c.dirs.map((_, i) => (i === 0 ? c.junk : 0)) : c.dirs.map((d) => sizes.get(d) ?? share(c)));
  const abs = chosen.map((c) => ({ repo: c.repo, dirs: c.dirs, sizes: sized(c), last: c.last }))
    .filter((c) => c.sizes.reduce((n, b) => n + b, 0) > 0)
    .sort((a, b) => b.sizes.reduce((n, x) => n + x, 0) - a.sizes.reduce((n, x) => n + x, 0));
  const items: CleanupItem[] = abs.map((c) => ({
    repo: tilde(c.repo),
    dirs: c.dirs.map((d) => relative(c.repo, d)),
    bytes: c.sizes.reduce((n, b) => n + b, 0),
    idleDays: Math.floor((now - c.last) / DAY),
  }));
  const plan: CleanupPlan = { id: newId(), createdAt: now, expiresAt: now + PLAN_TTL_MS, idleDays, bytes: items.reduce((n, i) => n + i.bytes, 0), items, kept };
  for (const [k, p] of plans) if (p.expiresAt < now) plans.delete(k);
  plans.set(plan.id, { ...plan, abs });
  return plan;
}

/** `rm -rf` at background priority (a big node_modules takes a while; the daemon keeps answering). */
async function remove(dir: string): Promise<boolean> {
  const p = Bun.spawn([...lowPriority(), "rm", "-rf", "--", dir], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  await p.exited;
  return !existsSync(dir);
}

export async function applyCleanup(
  db: Database,
  id: string,
  opts: { now?: number; busy?: string[]; reason?: string } = {},
): Promise<CleanupResult | { error: string }> {
  const now = opts.now ?? Date.now();
  const plan = plans.get(id);
  if (!plan) return { error: `No cleanup plan "${id}" on this node; make a new one.` };
  if (plan.expiresAt < now) { plans.delete(id); return { error: `Cleanup plan "${id}" expired; make a new one (it is only good for ${PLAN_TTL_MS / 60_000} minutes).` }; }
  plans.delete(id);
  const busy = opts.busy ?? (await busyPaths());
  const result: CleanupResult = { id, freedBytes: 0, removed: [], skipped: [] };
  for (const item of plan.abs) {
    if (busy.some((b) => inside(b, item.repo))) { result.skipped.push(...item.dirs.map((d) => ({ dir: tilde(d), why: "a process is using the repo now" }))); continue; }
    const done: string[] = [];
    let bytes = 0;
    for (const [i, d] of item.dirs.entries()) {
      const why = await removable(item.repo, d, plan.idleDays * DAY, now);
      if (why !== "ok") { result.skipped.push({ dir: tilde(d), why: why === "gone" ? "already gone" : why === "tracked" ? "git no longer ignores it" : "it changed since the plan" }); continue; }
      if (await remove(d)) { done.push(relative(item.repo, d)); bytes += item.sizes[i]; }
      else result.skipped.push({ dir: tilde(d), why: "rm did not remove it all" });
    }
    if (!done.length) continue;
    result.removed.push({ repo: tilde(item.repo), dirs: done, bytes });
    result.freedBytes += bytes;
    db.query("UPDATE repos SET junk_bytes = MAX(0, junk_bytes - ?) WHERE path = ?").run(bytes, item.repo);
    audit({ at: new Date(now).toISOString(), action: "free_space", repo: item.repo, removed: done, bytes, plan: id, reason: opts.reason ?? null });
  }
  return result;
}

/** "yacht: I can free 42 GB of rebuildable build output from 12 repos idle for 2+ weeks, most from ~/Code/a (6 GB) and ~/Code/b (4 GB). Nothing is deleted until you say so." */
export function planSentence(host: string, p: CleanupPlan): string {
  const keptWords = [p.kept.busy && `${p.kept.busy} in use by a running process`, p.kept.recent && `${p.kept.recent} worked on recently`].filter(Boolean) as string[];
  const keptPart = keptWords.length ? ` I left out repos ${keptWords.join(" and ")}.` : "";
  if (!p.items.length) return `${host}: nothing to free safely; no repo idle for ${p.idleDays}+ days has rebuildable build output over ${sizeWords(MIN_REPO_BYTES)}.${keptPart}`;
  const top = p.items.slice(0, 2).map((i) => `${i.repo} (${sizeWords(i.bytes)})`).join(" and ");
  return `${host}: I can free ${sizeWords(p.bytes)} of rebuildable build output (${[...new Set(p.items.flatMap((i) => i.dirs.map((d) => d.split("/").pop())))].slice(0, 3).join(", ")}) from ${p.items.length} repo${p.items.length === 1 ? "" : "s"} idle for ${p.idleDays}+ days, most from ${top}.${keptPart} Nothing is deleted until you say yes.`;
}

export function applySentence(host: string, r: CleanupResult): string {
  if (!r.removed.length) return `${host}: nothing was removed${r.skipped.length ? `; ${r.skipped[0].dir}: ${r.skipped[0].why}` : ""}.`;
  return `${host}: freed ${sizeWords(r.freedBytes)} from ${r.removed.length} repo${r.removed.length === 1 ? "" : "s"}${r.skipped.length ? `; left ${r.skipped.length} folder${r.skipped.length === 1 ? "" : "s"} that changed since the plan` : ""}. They rebuild with an install.`;
}
