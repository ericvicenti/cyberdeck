// What is using the space on a machine, for the `disk_usage` MCP tool ("what is filling yacht's disk?").
//
// `disks` says a disk is nearly full; this says why. Two sources, both read-only:
//   - the indexer's repos table: every repo's size and its reclaimable build output (node_modules, target,
//     .next, ...), instant, so the roots (~/Code) are never walked again here;
//   - one `du -xk -d 1` per entry of the home directory (dot dirs included, the roots skipped), at
//     background priority in the indexer's shared du queue, so each entry also lists its biggest children
//     (~/Library -> Developer, Caches, Containers).
// A full walk of a big home takes minutes, so the report is measured in the background, kept in the
// `space_reports` table for SPACE_TTL_MS, and redone on its own when this node's disk is nearly full. A
// caller that finds it measuring gets the previous report (if any) and `state: "measuring"`. Nothing here
// deletes anything; the voice agent suggests, Eric decides.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { duTree } from "./indexer/du";
import { sizeWords } from "./disks";

/** How long a measured report stays good. */
export const SPACE_TTL_MS = 12 * 3600_000;
/** One home entry gets this long before it is reported as too slow to measure. */
const ENTRY_TIMEOUT_MS = 5 * 60_000;
/** Entries and children under this size are left out of the report. */
export const SPACE_MIN_BYTES = 1024 ** 3;

export type SpaceEntry = { path: string; bytes: number; children: { path: string; bytes: number }[]; /** A root, sized from the repos table (files outside repos not counted). */ inRepos?: boolean };
type RepoSize = { path: string; bytes: number; junkBytes: number };
export type RepoSpace = { count: number; bytes: number; junkBytes: number; /** Biggest repos. */ top: RepoSize[]; /** Most build output. */ topJunk: RepoSize[] };
export type SpaceReport = {
  /** When the home walk finished; null before the first one. */
  measuredAt: number | null;
  state: "ready" | "measuring";
  home: string;
  /** Home entries (and the roots, sized from the repos table) of at least SPACE_MIN_BYTES, biggest first. */
  entries: SpaceEntry[];
  /** Home entries du gave up on. */
  slow: string[];
  repos: RepoSpace;
};

/** The home directory to walk (tests point it at a scratch dir). */
export const spaceHome = () => process.env.CYBERDECK_SPACE_HOME || homedir();

/** `/Users/eric/Library/Caches` -> `~/Library/Caches`. */
export const tilde = (path: string, home = spaceHome()) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** Repos from the indexer, outermost only (a worktree inside another repo is counted once, by its parent). */
export function repoSpace(db: Database, top = 5): RepoSpace {
  const rows = (db.query("SELECT path, size_bytes AS bytes, junk_bytes AS junkBytes FROM repos ORDER BY path").all() as { path: string; bytes: number; junkBytes: number }[]);
  const outer: typeof rows = [];
  for (const r of rows) if (!outer.length || !(r.path === outer[outer.length - 1].path || r.path.startsWith(`${outer[outer.length - 1].path}/`))) outer.push(r);
  return {
    count: rows.length,
    bytes: outer.reduce((n, r) => n + r.bytes, 0),
    junkBytes: outer.reduce((n, r) => n + r.junkBytes, 0),
    top: [...outer].sort((a, b) => b.bytes - a.bytes).slice(0, top).map((r) => ({ ...r, path: tilde(r.path) })),
    topJunk: [...outer].sort((a, b) => b.junkBytes - a.junkBytes).slice(0, top).map((r) => ({ ...r, path: tilde(r.path) })),
  };
}

function ensure(db: Database) {
  db.run("CREATE TABLE IF NOT EXISTS space_reports (home TEXT PRIMARY KEY, at INTEGER NOT NULL, entries TEXT NOT NULL, slow TEXT NOT NULL)");
}

function stored(db: Database, home: string): { at: number; entries: SpaceEntry[]; slow: string[] } | null {
  ensure(db);
  const r = db.query("SELECT at, entries, slow FROM space_reports WHERE home = ?").get(home) as { at: number; entries: string; slow: string } | null;
  return r ? { at: r.at, entries: JSON.parse(r.entries), slow: JSON.parse(r.slow) } : null;
}

const running = new Map<string, Promise<void>>();

/** Walk the home directory once (skipping symlinks and the roots, which the repos table already sizes) and store the result. */
async function measure(db: Database, home: string, roots: string[]) {
  const skip = new Set(roots);
  const names = existsSync(home) ? readdirSync(home) : [];
  const entries: SpaceEntry[] = [];
  const slow: string[] = [];
  for (const name of names) {
    const path = join(home, name);
    if (skip.has(path)) continue;
    let st;
    try { st = lstatSync(path); } catch { continue; }
    if (!st.isDirectory()) continue;
    const t = await duTree(path, ENTRY_TIMEOUT_MS);
    if (!t) { slow.push(tilde(path, home)); continue; }
    if (t.bytes < SPACE_MIN_BYTES) continue;
    const children = [...t.children].filter(([, b]) => b >= SPACE_MIN_BYTES).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, b]) => ({ path: tilde(p, home), bytes: b }));
    entries.push({ path: tilde(path, home), bytes: t.bytes, children });
  }
  ensure(db);
  db.query("INSERT INTO space_reports (home, at, entries, slow) VALUES (?, ?, ?, ?) ON CONFLICT(home) DO UPDATE SET at = excluded.at, entries = excluded.entries, slow = excluded.slow")
    .run(home, Date.now(), JSON.stringify(entries), JSON.stringify(slow));
}

/** Start a walk unless one is running or the stored one is fresh (or `fresh` asks for a new one). */
export function startSpaceMeasure(db: Database, roots: string[], fresh = false, home = spaceHome()): Promise<void> {
  const busy = running.get(home);
  if (busy) return busy;
  const last = stored(db, home);
  if (last && !fresh && Date.now() - last.at < SPACE_TTL_MS) return Promise.resolve();
  const job = measure(db, home, roots).finally(() => running.delete(home));
  running.set(home, job);
  return job;
}

/** This node's report: waits up to `waitMs` for a walk that is due, then answers with what is stored. */
export async function spaceReport(db: Database, roots: string[], opts: { waitMs?: number; fresh?: boolean } = {}): Promise<SpaceReport> {
  const home = spaceHome();
  const job = startSpaceMeasure(db, roots, opts.fresh, home);
  await Promise.race([job.catch(() => {}), new Promise((r) => setTimeout(r, opts.waitMs ?? 0))]);
  const last = stored(db, home);
  const repos = repoSpace(db);
  const entries = [...(last?.entries ?? [])];
  const outerIn = (root: string) => repoSpace(db, Infinity).top.filter((r) => { const p = r.path.replace(/^~/, home); return p === root || p.startsWith(`${root}/`); }).reduce((n, r) => n + r.bytes, 0);
  for (const root of roots.filter((r) => r === home || r.startsWith(`${home}/`))) {
    if (root !== home && outerIn(root) >= SPACE_MIN_BYTES) entries.push({ path: tilde(root, home), bytes: outerIn(root), children: [], inRepos: true });
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  return { measuredAt: last?.at ?? null, state: running.has(home) ? "measuring" : "ready", home: "~", entries, slow: last?.slow ?? [], repos };
}

/**
 * One spoken sentence: the biggest places first (with their biggest child), then how much of the repos is
 * reclaimable build output and where most of it is. "yacht: ~/Code 310 GB in repos, ~/Library 120 GB (most in
 * ~/Library/Developer, 40 GB), ~/.deck 50 GB; 85 GB of the repos is rebuildable build output (most in ~/Code/Seed-worktrees, 6 GB)."
 */
export function spaceSentence(host: string, r: SpaceReport): string {
  const places = r.entries.slice(0, 4).map((e) => {
    const c = e.children[0];
    return `${e.path} ${sizeWords(e.bytes)}${e.inRepos ? " in repos" : c ? ` (most in ${c.path}, ${sizeWords(c.bytes)})` : ""}`;
  });
  const parts: string[] = [];
  if (places.length) parts.push(`${host}: the biggest are ${places.join(", ")}`);
  else parts.push(r.measuredAt === null ? `${host}: the home folder has not been measured yet` : `${host}: nothing over ${sizeWords(SPACE_MIN_BYTES)} in the home folder`);
  if (r.repos.junkBytes >= SPACE_MIN_BYTES) {
    const worst = r.repos.topJunk[0];
    parts.push(`${sizeWords(r.repos.junkBytes)} of the ${r.repos.count} repos is rebuildable build output${worst && worst.junkBytes >= SPACE_MIN_BYTES ? ` (most in ${worst.path}, ${sizeWords(worst.junkBytes)})` : ""}`);
  }
  if (r.state === "measuring") parts.push(r.measuredAt === null ? "measuring the home folder now, ask again in a few minutes" : `still re-measuring; these numbers are from ${Math.max(1, Math.round((Date.now() - r.measuredAt) / 3600_000))} h ago`);
  if (r.slow.length) parts.push(`${r.slow.slice(0, 2).join(", ")} took too long to measure`);
  return `${parts.join("; ")}.`;
}

/** The command run on a host without a Cyberdeck node (agentic): one bounded, read-only, low-priority walk of the root filesystem, two levels deep. */
export const REMOTE_DU = "if sudo -n true 2>/dev/null; then S='sudo -n'; else S=''; fi; $S nice -n 19 timeout 50 du -xk -d 2 / 2>/dev/null | sort -rn | head -40";

/** `du -xk -d 2 /` output (biggest first) -> a report: the top-level directories with their biggest children. */
export function remoteSpace(out: string, now = Date.now()): SpaceReport {
  const rows = out.split("\n").map((l) => l.match(/^(\d+)\s+(\/.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ path: m[2], bytes: parseInt(m[1], 10) * 1024 }));
  const depth = (p: string) => p.split("/").filter(Boolean).length;
  const entries: SpaceEntry[] = rows.filter((r) => depth(r.path) === 1 && r.bytes >= SPACE_MIN_BYTES).map((r) => ({
    path: r.path,
    bytes: r.bytes,
    children: rows.filter((c) => depth(c.path) === 2 && c.path.startsWith(`${r.path}/`) && c.bytes >= SPACE_MIN_BYTES).slice(0, 5),
  })).sort((a, b) => b.bytes - a.bytes);
  return { measuredAt: now, state: "ready", home: "/", entries, slow: [], repos: { count: 0, bytes: 0, junkBytes: 0, top: [], topJunk: [] } };
}
