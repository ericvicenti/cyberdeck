// Home dashboard: usage normalizers, the Codex transcript fallback, df parsing,
// activity counting, and the /api/dashboard shape (no keychain, no network).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { startTestServer, testConfig, tmpHomeDir, type TestServer } from "./helpers";
import { normalizeClaudeUsage, normalizeCodexUsage, codexUsageFromSessions, parseDf, mergeVolumes, activityByDay, backupStatus, claudeResetOffer } from "../src/daemon/api/dashboard";
import { normalizeCodexResets } from "../src/daemon/codexrpc";
import { readFileSync, existsSync } from "fs";

const { dir, cleanup } = tmpHomeDir("dashboard");
const claudeHome = join(dir, "claude");
const codexHome = join(dir, "codex");
const DAY = 86400000;
const now = Date.UTC(2026, 9, 7, 12, 0, 0); // 2026-10-07T12:00Z

beforeAll(() => {
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(codexHome, "sessions", "2026", "10", "06"), { recursive: true });
  mkdirSync(join(codexHome, "sessions", "2026", "10", "07"), { recursive: true });
  // one prompt today, two yesterday, one 20 days ago (outside the window)
  writeFileSync(join(claudeHome, "history.jsonl"), [
    JSON.stringify({ display: "a", timestamp: now - 60_000, project: "/x" }),
    JSON.stringify({ display: "b", timestamp: now - DAY, project: "/x" }),
    JSON.stringify({ display: "c", timestamp: now - DAY - 1000, project: "/x" }),
    JSON.stringify({ display: "old", timestamp: now - 20 * DAY, project: "/x" }),
  ].join("\n") + "\n");
  writeFileSync(join(codexHome, "history.jsonl"), [
    JSON.stringify({ session_id: "s1", ts: Math.floor((now - 30_000) / 1000), text: "hi" }),
    JSON.stringify({ session_id: "s2", ts: Math.floor((now - 3 * DAY) / 1000), text: "hi" }),
    "not json",
  ].join("\n") + "\n");
  // an older transcript with limits, and a newer one whose limits must win
  writeFileSync(join(codexHome, "sessions", "2026", "10", "06", "rollout-a.jsonl"), [
    JSON.stringify({ timestamp: "2026-10-06T10:00:00.000Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 10, window_minutes: 10080, resets_at: 1791580849 }, secondary: null, plan_type: "pro" } } }),
  ].join("\n") + "\n");
  writeFileSync(join(codexHome, "sessions", "2026", "10", "07", "rollout-b.jsonl"), [
    JSON.stringify({ timestamp: "2026-10-07T01:00:00.000Z", type: "session_meta", payload: {} }),
    JSON.stringify({ timestamp: "2026-10-07T01:58:20.106Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 57, window_minutes: 10080, resets_at: 1791580849 }, secondary: { used_percent: 3, window_minutes: 300, resets_at: 1791400000 }, credits: { has_credits: true, unlimited: false, balance: "62500" }, plan_type: "pro" } } }),
  ].join("\n") + "\n");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
});
afterAll(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  cleanup();
});

describe("claude usage", () => {
  test("new `limits` shape: session, weekly, scoped weekly with the active flag", () => {
    const u = normalizeClaudeUsage(
      {
        five_hour: { utilization: 29, resets_at: "2026-10-07T03:30:00Z" },
        seven_day: { utilization: 34, resets_at: "2026-10-12T09:00:00Z" },
        limits: [
          { kind: "session", group: "session", percent: 29, resets_at: "2026-10-07T03:30:00Z", scope: null, is_active: false },
          { kind: "weekly_all", group: "weekly", percent: 34, resets_at: "2026-10-12T09:00:00Z", scope: null, is_active: false },
          { kind: "weekly_scoped", group: "weekly", percent: 68, resets_at: "2026-10-12T09:00:00Z", scope: { model: { id: null, display_name: "Fable" } }, is_active: true },
        ],
      },
      "default_claude_max_20x",
      123
    );
    expect(u.available).toBe(true);
    expect(u.plan).toBe("default_claude_max_20x");
    expect(u.limits.map((l) => [l.label, l.percent, l.active])).toEqual([["session", 29, false], ["weekly", 34, false], ["weekly · Fable", 68, true]]);
    expect(u.limits[0].windowMinutes).toBe(300);
    expect(u.fetchedAt).toBe(123);
  });
  test("legacy shape without `limits`", () => {
    const u = normalizeClaudeUsage({ five_hour: { utilization: 12.4, resets_at: "x" }, seven_day: { utilization: 99.6, resets_at: "y" }, seven_day_opus: null }, null);
    expect(u.limits.map((l) => [l.label, l.percent])).toEqual([["session", 12], ["weekly", 100]]);
  });
  test("nothing usable → unavailable", () => {
    expect(normalizeClaudeUsage({}, null).available).toBe(false);
  });
});

describe("codex usage", () => {
  test("wham/usage shape: windows become labelled limits, fullest is active, credits parsed", () => {
    const u = normalizeCodexUsage({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 57, limit_window_seconds: 604800, reset_at: 1791580849 }, secondary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1791400000 } },
      credits: { has_credits: true, unlimited: false, balance: "62500" },
    });
    expect(u.plan).toBe("pro");
    expect(u.limits.map((l) => [l.label, l.percent, l.active])).toEqual([["weekly", 57, true], ["5-hour", 4, false]]);
    expect(u.limits[0].resetsAt).toBe(new Date(1791580849 * 1000).toISOString());
    expect(u.credits).toEqual({ balance: 62500, unlimited: false });
  });
  test("transcript fallback reads the newest session's rate_limits", () => {
    const u = codexUsageFromSessions(codexHome)!;
    expect(u.source).toBe("sessions");
    expect(u.limits.map((l) => [l.label, l.percent])).toEqual([["weekly", 57], ["5-hour", 3]]);
    expect(u.fetchedAt).toBe(Date.parse("2026-10-07T01:58:20.106Z"));
    expect(u.credits?.balance).toBe(62500);
    expect(u.plan).toBe("pro");
  });
  test("transcript fallback is null without a sessions dir", () => {
    expect(codexUsageFromSessions(join(dir, "nope"))).toBeNull();
  });
});

describe("local metrics", () => {
  test("parseDf handles POSIX output and mount points with spaces", () => {
    const rows = parseDf(
      "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
        "/dev/disk3s1s1 971350180 12360588 1461248 90% /\n" +
        "//srv/share 1000 250 750 25% /Volumes/My Share\n"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].mount).toBe("/");
    expect(rows[0].totalBytes).toBe(971350180 * 1024);
    expect(rows[0].percent).toBe(89); // used / (used + available), like df's Capacity
    expect(rows[1].mount).toBe("/Volumes/My Share");
    expect(rows[1].percent).toBe(25);
  });
  test("mergeVolumes folds an APFS container's system + data volumes into one pool", () => {
    const total = 971350180 * 1024, free = 1461248 * 1024;
    const v = mergeVolumes([
      { filesystem: "/dev/disk3s1s1", mount: "/", totalBytes: total, usedBytes: 12360588 * 1024, freeBytes: free, percent: 90, paths: ["/"] },
      { filesystem: "/dev/disk3s5", mount: "/System/Volumes/Data", totalBytes: total, usedBytes: 940000000 * 1024, freeBytes: free, percent: 100, paths: ["/Users/x/Code"] },
      { filesystem: "/dev/disk3s5", mount: "/System/Volumes/Data", totalBytes: total, usedBytes: 940000000 * 1024, freeBytes: free, percent: 100, paths: ["/Users/x/Downloads"] },
      { filesystem: "/dev/disk9", mount: "/Volumes/Backup", totalBytes: 4e12, usedBytes: 1e12, freeBytes: 3e12, percent: 25, paths: ["/Volumes/Backup"] },
    ]);
    expect(v.map((x) => x.mount)).toEqual(["/", "/Volumes/Backup"]);
    expect(v[0].percent).toBe(100); // 1.4 GB free of 926 GB is full, whatever df says about the sealed system volume
    expect(v[0].usedBytes).toBe(total - free);
    expect(v[0].paths).toEqual(["/", "/Users/x/Code", "/Users/x/Downloads"]);
  });
  test("activityByDay counts prompts per day over the window", () => {
    const days = activityByDay(claudeHome, codexHome, 14, now);
    expect(days).toHaveLength(14);
    expect(days[13]).toEqual({ date: "2026-10-07", cc: 1, cx: 1 });
    expect(days[12]).toEqual({ date: "2026-10-06", cc: 2, cx: 0 });
    expect(days[10]).toEqual({ date: "2026-10-04", cc: 0, cx: 1 });
    expect(days.reduce((n, d) => n + d.cc, 0)).toBe(3); // the 20-day-old prompt is outside the window
  });
  test("backupStatus reflects configuration honestly", () => {
    expect(backupStatus(testConfig()).configured).toBe(false);
    const b = backupStatus(testConfig({ backup: { targets: ["enuc"] } }));
    expect(b.configured).toBe(true);
    expect(b.targets).toEqual([{ node: "enuc", lastSnapshotAt: null, ok: null }]);
    expect(b.lastSnapshotAt).toBeNull();
  });
});

describe("GET /api/dashboard", () => {
  let srv: TestServer;
  beforeAll(() => {
    srv = startTestServer(testConfig({ roots: [dir] }));
    srv.db.exec(`INSERT INTO repos (path, name, dirty_files, untracked_files, ahead, remotes, size_bytes, junk_bytes, risk, scanned_at) VALUES
      ('/a', 'a', 0, 0, 0, '[{"name":"origin"}]', 1000, 100, 'safe', 1),
      ('/b', 'b', 2, 0, 0, '[{"name":"origin"}]', 5000, 1000, 'attention', 2),
      ('/c', 'c', 0, 1, 3, '[]', 3000, 0, 'at-risk', 3)`);
  });
  afterAll(() => srv.stop());

  test("returns every widget's data without touching the network", async () => {
    const res = await srv.api("/api/dashboard");
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.usage.claude.available).toBe(false);
    expect(d.usage.claude.source).toBe("none");
    // Codex falls back to the transcripts under CODEX_HOME
    expect(d.usage.codex.source).toBe("sessions");
    expect(d.usage.codex.limits[0].percent).toBe(57);
    expect(d.disks.length).toBeGreaterThan(0);
    expect(d.disks[0].mount).toBe("/");
    expect(d.disks[0].totalBytes).toBeGreaterThan(0);
    expect(d.system.cpus).toBeGreaterThan(0);
    expect(d.activity).toHaveLength(14);
    expect(d.redundancy).toMatchObject({ repos: 3, safe: 1, attention: 1, atRisk: 1, remoteless: 1, dirty: 2, unpushed: 1, exposedBytes: 7000, lastScanAt: 3 });
    expect(d.backup.configured).toBe(false);
    expect(d.backup.note).toContain("no backup system yet");
  });
  test("requires auth", async () => {
    expect((await fetch(`${srv.base}/api/dashboard`)).status).toBe(401);
  });
});

describe("limit resets", () => {
  test("codex usage carries the reset credits; none when the account has none", () => {
    const base = { plan_type: "pro", rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1791948812 } } };
    expect(normalizeCodexUsage({ ...base, rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 } }).resets).toEqual({ via: "api", available: 3, applicable: 0 });
    expect(normalizeCodexUsage({ ...base, rate_limit_reset_credits: { available_count: 2 } }).resets).toEqual({ via: "api", available: 2, applicable: null });
    expect(normalizeCodexUsage({ ...base, rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 } }).resets).toBeNull();
    expect(normalizeCodexUsage(base).resets).toBeNull();
  });

  test("claude offers /limit-reset only when Claude Code's cached flags enable it", () => {
    const file = join(dir, "claude-flags.json");
    expect(claudeResetOffer(join(dir, "missing.json"))).toBeNull();
    writeFileSync(file, JSON.stringify({ cachedGrowthBookFeatures: { tengu_nifty_lemur: { enabled: true } } }));
    expect(claudeResetOffer(file)).toEqual({ via: "cli", command: "/limit-reset", kind: "session" });
    writeFileSync(file, JSON.stringify({ cachedGrowthBookFeatures: { tengu_nifty_lemur: { enabled: true }, tengu_cedar_ember: { enabled: true } } }));
    expect(claudeResetOffer(file)).toEqual({ via: "cli", command: "/limit-reset", kind: "limits" });
    writeFileSync(file, JSON.stringify({ cachedGrowthBookFeatures: { tengu_nifty_lemur: { enabled: false } } }));
    expect(claudeResetOffer(file)).toBeNull();
    writeFileSync(file, "not json");
    expect(claudeResetOffer(file)).toBeNull();
  });

  test("reset credits: only available ones, soonest expiry first", () => {
    const r = normalizeCodexResets({ rateLimitResetCredits: { availableCount: 2, credits: [
      { id: "b", status: "available", expiresAt: 200, title: "Full reset" },
      { id: "a", status: "available", expiresAt: 100, title: "" },
      { id: "c", status: "redeemed", expiresAt: 50 },
    ] } });
    expect(r.available).toBe(2);
    expect(r.credits.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.credits[0]).toMatchObject({ title: "Rate limit reset", expiresAt: 100_000 });
    expect(normalizeCodexResets({})).toEqual({ available: 0, credits: [] });
  });

  describe("routes, through a stub codex app-server", () => {
    let srv: TestServer;
    const log = join(dir, "codex-consumes.jsonl");
    beforeAll(() => {
      process.env.CYBERDECK_CODEX_APP_SERVER = JSON.stringify(["bun", join(import.meta.dir, "fixtures", "codex", "app-server.ts")]);
      process.env.CODEX_STUB_LOG = log;
      srv = startTestServer(testConfig());
    });
    afterAll(() => { srv.stop(); delete process.env.CYBERDECK_CODEX_APP_SERVER; delete process.env.CODEX_STUB_LOG; });
    const postJson = (path: string, body: unknown) => srv.api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    test("GET lists the spendable credits", async () => {
      const res = await srv.api("/api/usage/codex/resets");
      expect(res.status).toBe(200);
      const r = await res.json();
      expect(r.available).toBe(2);
      expect(r.credits.map((c: any) => c.id)).toEqual(["RateLimitResetCredit_soon", "RateLimitResetCredit_late"]);
    });

    test("POST spends exactly the named credit with the caller's idempotency key", async () => {
      const res = await postJson("/api/usage/codex/reset", { creditId: "RateLimitResetCredit_soon", idempotencyKey: "click-0001-abcd" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "reset", message: "Codex limits reset." });
      const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(calls).toEqual([{ idempotencyKey: "click-0001-abcd", creditId: "RateLimitResetCredit_soon" }]);
    });

    test("POST reports a non-reset outcome honestly and rejects a malformed credit id before calling codex", async () => {
      const used = await postJson("/api/usage/codex/reset", { creditId: "RateLimitResetCredit_used" });
      expect(await used.json()).toMatchObject({ outcome: "alreadyRedeemed" });
      const before = readFileSync(log, "utf8");
      const bad = await postJson("/api/usage/codex/reset", { creditId: "x; rm -rf /" });
      expect(bad.status).toBe(400);
      expect(readFileSync(log, "utf8")).toBe(before);
    });

    test("requires auth", async () => {
      expect((await fetch(`${srv.base}/api/usage/codex/reset`, { method: "POST" })).status).toBe(401);
      expect(existsSync(log)).toBe(true);
    });
  });

  test("the routes stay off when usage lookups are disabled and no stub is set", async () => {
    const srv = startTestServer(testConfig());
    try {
      expect((await srv.api("/api/usage/codex/resets")).status).toBe(503);
      expect((await srv.api("/api/usage/codex/reset", { method: "POST" })).status).toBe(503);
    } finally { srv.stop(); }
  });
});
