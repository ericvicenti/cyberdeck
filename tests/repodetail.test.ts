// repos_detail (live git of one indexed repo) and sessions_search (resume hints): the pure pieces and a real repo.
import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { matchRepo, parseStatusV2, parseBranches, briefOf, repoDetail } from "../src/daemon/repodetail";
import { searchSessions, type DeckSession } from "../src/daemon/api/mcp";

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

describe("matchRepo", () => {
  const paths = ["/h/Code/Cyberdeck", "/h/Code/Cyberdeck-wt-vd", "/h/Code/Seed", "/h/Code/Seed-worktrees/agent-voice"];
  test("exact path, then folder name, then substring", () => {
    expect(matchRepo(paths, "/h/Code/Seed/")).toEqual({ path: "/h/Code/Seed" });
    expect(matchRepo(paths, "cyberdeck")).toEqual({ path: "/h/Code/Cyberdeck" });
    expect(matchRepo(paths, "agent-voice")).toEqual({ path: "/h/Code/Seed-worktrees/agent-voice" });
    expect(matchRepo(paths, "wt-vd")).toEqual({ path: "/h/Code/Cyberdeck-wt-vd" });
  });
  test("ambiguous or unknown names are refused with candidates", () => {
    const amb = matchRepo(paths, "seed");
    expect(amb).toEqual({ path: "/h/Code/Seed" }); // folder name wins over substring
    const sub = matchRepo(paths, "Code/Cy");
    expect("error" in sub && sub.candidates).toEqual(["/h/Code/Cyberdeck", "/h/Code/Cyberdeck-wt-vd"]);
    const none = matchRepo(paths, "nope");
    expect("error" in none && none.error).toContain("No indexed repo");
  });
});

describe("git parsing", () => {
  test("porcelain v2 with branch headers, renames, untracked and conflicts", () => {
    const out = [
      "# branch.oid abc", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 a a src/a b.ts",
      "1 A. N... 000000 100644 100644 0 b new.ts",
      "2 R. N... 100644 100644 100644 a a R100 moved.ts", "old.ts",
      "u UU N... 100644 100644 100644 100644 a b c clash.ts",
      "? notes.md", "",
    ].join("\0");
    const s = parseStatusV2(out);
    expect([s.branch, s.upstream, s.ahead, s.behind, s.detached]).toEqual(["main", "origin/main", 2, 1, false]);
    expect(s.files).toEqual([
      { status: "modified", path: "src/a b.ts" },
      { status: "added", path: "new.ts" },
      { status: "renamed", path: "moved.ts" },
      { status: "conflict", path: "clash.ts" },
      { status: "untracked", path: "notes.md" },
    ]);
    expect([s.staged, s.modified, s.untracked, s.conflicted]).toEqual([2, 1, 1, 1]);
    expect(parseStatusV2("# branch.head (detached)\0").detached).toBe(true);
  });
  test("branches: no upstream or ahead are unpushed, in sync is not", () => {
    expect(parseBranches("main\torigin/main\t\nwip\t\t\nfeat\torigin/feat\t[ahead 3, behind 1]\n")).toEqual([
      { branch: "wip", upstream: null, ahead: null },
      { branch: "feat", upstream: "origin/feat", ahead: 3 },
    ]);
  });
  test("brief is one sentence", () => {
    const base = { path: "/x/Demo", branch: "main", detached: false, upstream: "origin/main", ahead: 0, behind: 0, dirty: { total: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, files: [] }, stashes: 0, lastCommit: null, unpushedBranches: [], remotes: ["origin"] };
    expect(briefOf(base)).toBe("Demo is on main, clean and in sync with origin/main.");
    expect(briefOf({ ...base, ahead: 1, dirty: { ...base.dirty, total: 3 }, stashes: 2 })).toBe("Demo is on main with 3 uncommitted files, 1 commit not pushed, 2 stashes.");
    expect(briefOf({ ...base, upstream: null, remotes: [] })).toBe("Demo is on main with no remote at all.");
  });
});

describe("repoDetail on a real repo", () => {
  let repo: string;
  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "cd-repodetail-"));
    const origin = join(root, "origin.git");
    repo = join(root, "Demo");
    sh(root, "init", "-q", "--bare", origin);
    sh(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "a.txt"), "1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "first");
    sh(repo, "remote", "add", "origin", origin);
    sh(repo, "push", "-qu", "origin", "main");
    writeFileSync(join(repo, "a.txt"), "2\n");
    sh(repo, "commit", "-qam", "second, not pushed");
    sh(repo, "branch", "wip");
    writeFileSync(join(repo, "a.txt"), "3\n");
    sh(repo, "stash", "-q");
    writeFileSync(join(repo, "a.txt"), "4\n");
    writeFileSync(join(repo, "new.txt"), "x\n");
  }, 60_000);
  test("reads branch, ahead, dirty files, stash and unpushed branches", async () => {
    const d = await repoDetail(repo);
    expect([d.branch, d.upstream, d.ahead, d.behind]).toEqual(["main", "origin/main", 1, 0]);
    expect(d.dirty.files).toEqual([{ status: "modified", path: "a.txt" }, { status: "untracked", path: "new.txt" }]);
    expect(d.stashes).toBe(1);
    expect(d.lastCommit?.subject).toBe("second, not pushed");
    expect(d.unpushedBranches).toEqual([{ branch: "main", upstream: "origin/main", ahead: 1 }, { branch: "wip", upstream: null, ahead: null }]);
    expect(d.brief).toBe("Demo is on main with 2 uncommitted files, 1 commit not pushed, 1 other branch with unpushed work, 1 stash.");
  }, 30_000);
});

describe("searchSessions", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const s = (o: Partial<DeckSession>): DeckSession => ({ host: "yacht", tool: "cc", id: "id", title: "t", cwd: "/h/Code/X", started: "2026-10-01T00:00:00Z", updated: "2026-10-12T10:00:00Z", file: "/f", ...o });
  const all = [
    s({ id: "a1", title: "Fix voice latency", cwd: "/h/Code/Seed", updated: "2026-10-12T09:00:00Z", project: "casework-desk" }),
    s({ id: "b2", host: "starlight", tool: "cx", title: "Voice worker TTS", cwd: "/h/My Code/Seed", updated: "2026-10-12T11:30:00Z" }),
    s({ id: "c3", title: "Steam client", branch: "steam" }),
  ];
  const ctx = { here: "Yacht", hosts: [{ name: "starlight", ssh: "starlight" }], now };
  test("all words must match across title, folder, project and branch; newest first", () => {
    const r = searchSessions(all, { query: "voice seed", limit: 8 }, ctx);
    expect(r.items.map((i) => i.id)).toEqual(["b2", "a1"]);
    expect(r.total).toBe(2);
    expect(searchSessions(all, { query: "casework", limit: 8 }, ctx).items.map((i) => i.id)).toEqual(["a1"]);
    expect(searchSessions(all, { query: "steam", tool: "cx", limit: 8 }, ctx).total).toBe(0);
  });
  test("resume hints: local command, ssh and pull for other hosts", () => {
    const r = searchSessions(all, { query: "voice", limit: 8 }, ctx);
    const [remote, local] = r.items;
    expect(local.resume).toEqual({ host: "yacht", command: "cd /h/Code/Seed && claude --resume a1" });
    expect(remote.resume.command).toBe("cd '/h/My Code/Seed' && codex resume b2");
    expect(remote.resume.ssh).toBe(`ssh -t starlight 'cd '\\''/h/My Code/Seed'\\'' && codex resume b2'`);
    expect(remote.resume.pull).toBe("deck sessions pull b2");
    expect(r.brief).toBe("2 sessions match; the newest is Codex on starlight, 30 minutes ago: Voice worker TTS.");
    expect(local.spoken).toBe("Claude Code on yacht, 3 hours ago, project casework-desk: Fix voice latency");
  });
  test("limit and an empty answer", () => {
    expect(searchSessions(all, { limit: 1 }, ctx).items.length).toBe(1);
    expect(searchSessions(all, { query: "zzz", host: "enuc", limit: 8 }, ctx).brief).toBe('No cc or cx sessions match "zzz" on enuc.');
  });
});
