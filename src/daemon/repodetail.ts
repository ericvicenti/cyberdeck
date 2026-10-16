// Live detail of one indexed git repo (branch, upstream, ahead/behind, dirty files, stashes, branches no
// remote has), read with git at call time rather than from the last scan. Backs the MCP `repos_detail`
// tool and GET /api/repos/detail (which a peer's MCP server calls). Only paths the indexer already knows
// are ever handed to git, so neither route can be pointed at an arbitrary directory.
import { basename } from "node:path";

export type RepoDetail = {
  path: string;
  /** One spoken sentence: the answer a voice agent reads first. */
  brief: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: { total: number; staged: number; modified: number; untracked: number; conflicted: number; files: { status: string; path: string }[] };
  stashes: number;
  lastCommit: { sha: string; subject: string; date: string } | null;
  /** Local branches with commits their upstream lacks, or with no upstream at all. */
  unpushedBranches: { branch: string; upstream: string | null; ahead: number | null }[];
  remotes: string[];
};

/** Files listed per answer; the totals still count every one. */
export const DIRTY_FILES_MAX = 30;

/** Picks the indexed repo `query` names: exact path, then folder name, then path substring. */
export function matchRepo(paths: string[], query: string): { path: string } | { error: string; candidates: string[] } {
  const q = query.trim().replace(/\/+$/, "");
  const lower = q.toLowerCase();
  const exact = paths.find((p) => p === q);
  if (exact) return { path: exact };
  const byName = paths.filter((p) => basename(p).toLowerCase() === lower);
  if (byName.length === 1) return { path: byName[0] };
  const pool = byName.length ? byName : paths.filter((p) => p.toLowerCase().includes(lower));
  if (pool.length === 1) return { path: pool[0] };
  if (!pool.length) return { error: `No indexed repo matches "${query}".`, candidates: [] };
  return { error: `"${query}" matches ${pool.length} repos; name one by its path.`, candidates: pool.slice(0, 20) };
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string) {
  let branch: string | null = null, upstream: string | null = null, ahead = 0, behind = 0, detached = false;
  const files: { status: string; path: string }[] = [];
  let staged = 0, modified = 0, untracked = 0, conflicted = 0;
  const recs = out.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    if (rec.startsWith("# branch.head ")) {
      const h = rec.slice(14);
      detached = h === "(detached)";
      branch = detached ? null : h;
    } else if (rec.startsWith("# branch.upstream ")) upstream = rec.slice(18);
    else if (rec.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(rec);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (rec.startsWith("? ")) { untracked++; files.push({ status: "untracked", path: rec.slice(2) }); }
    else if (rec.startsWith("u ")) { conflicted++; files.push({ status: "conflict", path: rec.split(" ").slice(10).join(" ") }); }
    else if (rec.startsWith("1 ") || rec.startsWith("2 ")) {
      const parts = rec.split(" ");
      const xy = parts[1];
      const path = parts.slice(rec.startsWith("1 ") ? 8 : 9).join(" ");
      if (rec.startsWith("2 ")) i++; // the rename's original path is the next NUL record
      if (xy[0] !== ".") staged++;
      if (xy[1] !== ".") modified++;
      const status = xy[0] === "A" ? "added" : xy.includes("D") ? "deleted" : xy.includes("R") ? "renamed" : "modified";
      files.push({ status, path });
    }
  }
  return { branch, upstream, ahead, behind, detached, staged, modified, untracked, conflicted, files };
}

/** Parses `git for-each-ref refs/heads --format=%(refname:short)%09%(upstream:short)%09%(upstream:track)`. */
export function parseBranches(out: string): RepoDetail["unpushedBranches"] {
  const res: RepoDetail["unpushedBranches"] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [branch, up, track] = line.split("\t");
    if (!up) { res.push({ branch, upstream: null, ahead: null }); continue; }
    const m = /ahead (\d+)/.exec(track ?? "");
    if (m) res.push({ branch, upstream: up, ahead: Number(m[1]) });
  }
  return res;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : /(s|sh|ch)$/.test(w) ? "es" : "s"}`;

/** One sentence a voice agent can say as-is. */
export function briefOf(d: Omit<RepoDetail, "brief">): string {
  const name = basename(d.path);
  const on = d.detached ? "a detached HEAD" : d.branch ?? "an unknown branch";
  const bits: string[] = [];
  if (d.dirty.total) bits.push(`${plural(d.dirty.total, "uncommitted file")}`);
  if (!d.remotes.length) bits.push("no remote at all");
  else if (!d.upstream && !d.detached) bits.push("no upstream for this branch");
  if (d.ahead) bits.push(`${plural(d.ahead, "commit")} not pushed`);
  if (d.behind) bits.push(`${d.behind} behind ${d.upstream}`);
  const others = d.unpushedBranches.filter((b) => b.branch !== d.branch);
  if (others.length) bits.push(`${plural(others.length, "other branch")} with unpushed work`);
  if (d.stashes) bits.push(plural(d.stashes, "stash"));
  return bits.length ? `${name} is on ${on} with ${bits.join(", ")}.` : `${name} is on ${on}, clean and in sync${d.upstream ? ` with ${d.upstream}` : ""}.`;
}

async function git(path: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => p.kill(), 15_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`git ${args[0]}: ${err.trim() || `exit ${code}`}`);
  return out;
}

/** Reads the repo now. `path` must be one the indexer knows (callers check). */
export async function repoDetail(path: string): Promise<RepoDetail> {
  const [status, branches, stash, last, remotes] = await Promise.all([
    git(path, ["status", "--porcelain=v2", "--branch", "-z"]),
    git(path, ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)"]),
    git(path, ["stash", "list"]).catch(() => ""),
    git(path, ["log", "-1", "--format=%h%x09%cI%x09%s"]).catch(() => ""),
    git(path, ["remote"]).catch(() => ""),
  ]);
  const s = parseStatusV2(status);
  const [sha, date, ...subj] = last.trim().split("\t");
  const d: Omit<RepoDetail, "brief"> = {
    path,
    branch: s.branch,
    detached: s.detached,
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    dirty: { total: s.files.length, staged: s.staged, modified: s.modified, untracked: s.untracked, conflicted: s.conflicted, files: s.files.slice(0, DIRTY_FILES_MAX) },
    stashes: stash.split("\n").filter(Boolean).length,
    lastCommit: sha ? { sha, date, subject: subj.join("\t") } : null,
    unpushedBranches: parseBranches(branches),
    remotes: remotes.split("\n").filter(Boolean),
  };
  return { brief: briefOf(d), ...d };
}
