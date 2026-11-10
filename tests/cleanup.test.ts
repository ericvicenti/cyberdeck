// free_space: only ignored build output in idle, unused repos is planned, and apply re-checks before removing.
import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

const SCRATCH = mkdtempSync(join(tmpdir(), "cd-cleanup-"));
process.env.CYBERDECK_AUDIT_LOG = join(SCRATCH, "audit.log");
const { applyCleanup, applySentence, planCleanup, planSentence } = await import("../src/daemon/cleanup");

const DAY = 86_400_000;
const NOW = Date.now();
const OLD = (NOW - 30 * DAY) / 1000;
const JUNK = ["node_modules", "build", "target"];
const G = 1024 ** 3;

function repo(name: string, files: Record<string, string>, ignore = "node_modules/\ntarget/\n"): string {
  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ignore);
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), body); }
  Bun.spawnSync(["git", "init", "-q", dir]);
  for (const j of JUNK) if (existsSync(join(dir, j))) utimesSync(join(dir, j), OLD, OLD);
  return dir;
}

let db: Database;
let idle: string, busy: string, recent: string, tracked: string, mono: string;
beforeAll(() => {
  idle = repo("idle", { "node_modules/a/index.js": "x", "src/main.ts": "y" });
  busy = repo("busy", { "node_modules/a/index.js": "x" });
  recent = repo("recent", { "node_modules/a/index.js": "x" });
  tracked = repo("tracked", { "build/out.js": "x" }); // build/ is not ignored here: it may hold real work
  mono = repo("mono", { "packages/web/node_modules/b.js": "x", "target/x": "y" });
  utimesSync(join(mono, "packages/web/node_modules"), OLD, OLD);
  db = new Database(":memory:");
  db.run("CREATE TABLE repos (path TEXT, junk_bytes INTEGER, last_commit_at INTEGER)");
  for (const [p, last] of [[idle, NOW - 40 * DAY], [busy, NOW - 40 * DAY], [recent, NOW - 2 * DAY], [tracked, NOW - 40 * DAY], [mono, NOW - 20 * DAY]] as const)
    db.query("INSERT INTO repos VALUES (?, ?, ?)").run(p, 5 * G, last);
});

const measure = async (paths: string[]) => new Map(paths.map((p) => [p, p.includes("mono") ? 1 * G : 3 * G]));

describe("free_space", () => {
  test("plans ignored build output in idle repos only, and says what it kept", async () => {
    const plan = await planCleanup(db, JUNK, { now: NOW, busy: [join(busy, "src")], measure });
    expect(plan.items.map((i) => [i.repo.split("/").pop(), i.dirs.sort(), i.bytes / G])).toEqual([
      ["idle", ["node_modules"], 3],
      ["mono", ["packages/web/node_modules", "target"], 2],
    ]);
    expect(plan.kept).toEqual({ busy: 1, recent: 1, tracked: 1 });
    expect(planSentence("yacht", plan)).toMatch(/^yacht: I can free 5 GB of rebuildable build output \(node_modules, target\) from 2 repos idle for 14\+ days, most from .*idle \(3 GB\) and .*mono \(2 GB\)\. I left out repos 1 in use by a running process and 1 worked on recently\. Nothing is deleted until you say yes\.$/);
    expect(existsSync(join(idle, "node_modules"))).toBe(true);
  });

  test("apply removes the planned folders, keeps the code, audits, and a plan works once", async () => {
    const plan = await planCleanup(db, JUNK, { now: NOW, busy: [busy], measure });
    // Between the plan and the yes, someone touched mono's target: it is left alone.
    utimesSync(join(mono, "target"), NOW / 1000, NOW / 1000);
    const r = await applyCleanup(db, plan.id, { now: NOW, busy: [busy], reason: "test" });
    if ("error" in r) throw new Error(r.error);
    expect(existsSync(join(idle, "node_modules"))).toBe(false);
    expect(existsSync(join(idle, "src/main.ts"))).toBe(true);
    expect(existsSync(join(mono, "packages/web/node_modules"))).toBe(false);
    expect(existsSync(join(mono, "target"))).toBe(true);
    expect(existsSync(join(tracked, "build/out.js"))).toBe(true);
    expect(r.skipped.map((s) => s.why)).toEqual(["it changed since the plan"]);
    expect(applySentence("yacht", r)).toBe("yacht: freed 4 GB from 2 repos; left 1 folder that changed since the plan. They rebuild with an install.");
    expect(readFileSync(process.env.CYBERDECK_AUDIT_LOG!, "utf8")).toContain('"action":"free_space"');
    expect((db.query("SELECT junk_bytes FROM repos WHERE path = ?").get(idle) as { junk_bytes: number }).junk_bytes).toBe(2 * G);
    expect(await applyCleanup(db, plan.id, { now: NOW, busy: [] })).toMatchObject({ error: expect.stringContaining("No cleanup plan") });
  });

  test("an expired plan and a repo that became busy are refused", async () => {
    const r2 = repo("again", { "node_modules/a.js": "x" });
    db.query("INSERT INTO repos VALUES (?, ?, ?)").run(r2, 5 * G, NOW - 40 * DAY);
    const p1 = await planCleanup(db, JUNK, { now: NOW, busy: [busy], measure });
    expect(await applyCleanup(db, p1.id, { now: NOW + 16 * 60_000, busy: [] })).toMatchObject({ error: expect.stringContaining("expired") });
    const p2 = await planCleanup(db, JUNK, { now: NOW, busy: [busy], measure });
    expect(p2.items.map((i) => i.repo)).toEqual([r2]);
    const r = await applyCleanup(db, p2.id, { now: NOW, busy: [busy, r2] });
    if ("error" in r) throw new Error(r.error);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(r2, "node_modules"))).toBe(true);
  });
});
