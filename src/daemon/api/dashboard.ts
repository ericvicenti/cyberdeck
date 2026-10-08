// Home dashboard: everything the widgets on the home page need in one call.
//   GET /api/dashboard  -> { at, usage: {claude, codex}, disks, system, activity, redundancy, backup }
//   GET  /api/usage/codex/resets -> the Codex rate-limit reset credits (with expiry)
//   POST /api/usage/codex/reset  -> spend one, through the official `codex app-server`
//
// Usage limits come from the same sign-ins the CLIs use (Claude Code's OAuth token in the
// macOS keychain or ~/.claude/.credentials.json; Codex's ~/.codex/auth.json) and are
// cached for a minute. Nothing here refreshes a token: when a sign-in has expired the
// widget says so and the next `claude` / `codex` launch fixes it. Set
// CYBERDECK_USAGE_NET=0 (tests do) to skip the keychain and the network entirely; Codex
// then falls back to the rate limits recorded in its newest session transcript.
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from "fs";
import { join } from "path";
import { homedir, loadavg, totalmem, freemem, uptime, cpus, platform } from "os";
import type { CyberdeckConfig } from "../config";
import { CYBERDECK_HOME } from "../config";
import { readCodexResets, consumeCodexReset, type CodexResetOutcome } from "../codexrpc";
import { randomUUID } from "crypto";

export const USAGE_CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const ACTIVITY_DAYS = 14;

export const CLAUDE_HOME = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const CODEX_HOME = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");
const netAllowed = () => process.env.CYBERDECK_USAGE_NET !== "0";
/** The reset routes follow the same switch, except when a test points them at a stub app-server. */
const resetsAllowed = () => netAllowed() || Boolean(process.env.CYBERDECK_CODEX_APP_SERVER);

// ---------------------------------------------------------------- types ----

export type UsageLimit = {
  id: string;
  /** Short human label: "session", "weekly", "weekly · Fable", "5-hour". */
  label: string;
  percent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  /** The limit the provider says is currently the binding one. */
  active: boolean;
};
/** How this account's free limit resets can be spent.
 *  - `api`: Codex reset credits; the dashboard spends one via POST /api/usage/codex/reset.
 *    `applicable` is how many would do something right now (0 when no limit is reached).
 *  - `cli`: Claude Code only honours a reset from inside Claude Code, so the dashboard opens
 *    a session running `command` and the confirmation happens there. `kind` says what it
 *    refills: the 5-hour session limit (once a week) or all limits (granted resets). */
export type UsageResets =
  | { via: "api"; available: number; applicable: number | null }
  | { via: "cli"; command: string; kind: "session" | "limits" };
export type UsageSummary = {
  tool: "claude" | "codex";
  /** Whether we have numbers to show at all. */
  available: boolean;
  plan: string | null;
  limits: UsageLimit[];
  credits: { balance: number | null; unlimited: boolean } | null;
  /** When the numbers were captured (ms); for the sessions fallback, the transcript's timestamp. */
  fetchedAt: number | null;
  source: "api" | "sessions" | "none";
  /** null: nothing to spend / not offered on this account. */
  resets: UsageResets | null;
  error?: string;
};
export type DiskInfo = { mount: string; filesystem: string; totalBytes: number; usedBytes: number; freeBytes: number; percent: number; paths: string[] };
export type SystemInfo = { platform: string; cpus: number; load: [number, number, number]; totalMem: number; freeMem: number; uptimeSec: number };
export type ActivityDay = { date: string; cc: number; cx: number };
export type Redundancy = {
  repos: number;
  safe: number;
  attention: number;
  atRisk: number;
  remoteless: number;
  dirty: number;
  unpushed: number;
  /** Bytes of repo content (junk excluded) in repos that are not "safe". */
  exposedBytes: number;
  dataBytes: number;
  dataCacheBytes: number;
  lastScanAt: number | null;
};
export type BackupStatus = {
  /** True once the (future) backup system has at least one target configured. */
  configured: boolean;
  targets: { node: string; lastSnapshotAt: number | null; ok: boolean | null }[];
  lastSnapshotAt: number | null;
  snapshots: number;
  protectedBytes: number;
  note: string;
};
export type Dashboard = {
  at: number;
  usage: { claude: UsageSummary; codex: UsageSummary };
  disks: DiskInfo[];
  system: SystemInfo;
  activity: ActivityDay[];
  redundancy: Redundancy;
  backup: BackupStatus;
};

// ----------------------------------------------------------- normalizers ----

const pct = (v: unknown): number => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const windowLabel = (minutes: number | null): string =>
  minutes == null ? "limit" : minutes <= 60 ? `${minutes}-minute` : minutes < 1440 ? `${Math.round(minutes / 60)}-hour` : minutes === 10080 ? "weekly" : `${Math.round(minutes / 1440)}-day`;

/** Shape of GET https://api.anthropic.com/api/oauth/usage into our limits list. */
export function normalizeClaudeUsage(json: any, plan: string | null, fetchedAt = Date.now()): UsageSummary {
  const limits: UsageLimit[] = [];
  if (Array.isArray(json?.limits) && json.limits.length) {
    for (const l of json.limits) {
      const scope = l.scope?.model?.display_name ?? l.scope?.surface ?? null;
      const base = l.group === "session" ? "session" : l.group === "weekly" ? "weekly" : String(l.kind ?? "limit");
      limits.push({
        id: String(l.kind ?? base) + (scope ? `:${scope}` : ""),
        label: scope ? `${base} · ${scope}` : base,
        percent: pct(l.percent),
        resetsAt: l.resets_at ?? null,
        windowMinutes: l.group === "session" ? 300 : l.group === "weekly" ? 10080 : null,
        active: Boolean(l.is_active),
      });
    }
  } else {
    // older shape: five_hour / seven_day / seven_day_<model>
    const add = (id: string, label: string, w: number, v: any) => v && limits.push({ id, label, percent: pct(v.utilization), resetsAt: v.resets_at ?? null, windowMinutes: w, active: false });
    add("session", "session", 300, json?.five_hour);
    add("weekly_all", "weekly", 10080, json?.seven_day);
    add("weekly_opus", "weekly · Opus", 10080, json?.seven_day_opus);
    add("weekly_sonnet", "weekly · Sonnet", 10080, json?.seven_day_sonnet);
  }
  return { tool: "claude", available: limits.length > 0, plan, limits, credits: null, fetchedAt, source: "api", resets: null };
}

/** Shape of GET https://chatgpt.com/backend-api/wham/usage into our limits list. */
export function normalizeCodexUsage(json: any, fetchedAt = Date.now()): UsageSummary {
  const limits: UsageLimit[] = [];
  const rl = json?.rate_limit ?? {};
  const add = (id: string, w: any) => {
    if (!w) return;
    const minutes = w.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : w.window_minutes ?? null;
    limits.push({ id, label: windowLabel(minutes), percent: pct(w.used_percent), resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null, windowMinutes: minutes, active: false });
  };
  add("primary", rl.primary_window);
  add("secondary", rl.secondary_window);
  if (limits.length) {
    // the longest window is the one that bites; mark the fullest as active
    const top = limits.reduce((a, b) => (b.percent > a.percent ? b : a));
    top.active = true;
  }
  const credits = json?.credits ? { balance: json.credits.balance != null && json.credits.balance !== "" ? Number(json.credits.balance) : null, unlimited: Boolean(json.credits.unlimited) } : null;
  const rc = json?.rate_limit_reset_credits;
  const resets: UsageResets | null = rc && Number(rc.available_count) > 0 ? { via: "api", available: Number(rc.available_count), applicable: Number.isFinite(rc.applicable_available_count) ? Number(rc.applicable_available_count) : null } : null;
  return { tool: "codex", available: limits.length > 0, plan: json?.plan_type ?? null, limits, credits, fetchedAt, source: "api", resets };
}

/** The `rate_limits` object Codex writes into its session transcripts (token_count events). */
export function normalizeCodexSessionLimits(rl: any, at: number): UsageSummary {
  const limits: UsageLimit[] = [];
  const add = (id: string, w: any) => {
    if (!w) return;
    const minutes = w.window_minutes ?? null;
    limits.push({ id, label: windowLabel(minutes), percent: pct(w.used_percent), resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null, windowMinutes: minutes, active: false });
  };
  add("primary", rl?.primary);
  add("secondary", rl?.secondary);
  if (limits.length) limits.reduce((a, b) => (b.percent > a.percent ? b : a)).active = true;
  const credits = rl?.credits ? { balance: rl.credits.balance != null && rl.credits.balance !== "" ? Number(rl.credits.balance) : null, unlimited: Boolean(rl.credits.unlimited) } : null;
  return { tool: "codex", available: limits.length > 0, plan: rl?.plan_type ?? null, limits, credits, fetchedAt: at, source: "sessions", resets: null };
}

const none = (tool: "claude" | "codex", error: string): UsageSummary => ({ tool, available: false, plan: null, limits: [], credits: null, fetchedAt: null, source: "none", resets: null, error });

/** Whether Claude Code offers `/limit-reset` to this account, from the feature flags it caches in
 *  its own config file (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`). The reset itself
 *  is only granted to Claude Code, so the dashboard's button opens a session that runs the command. */
export function claudeResetOffer(configFile = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json")): UsageResets | null {
  try {
    if (!existsSync(configFile)) return null;
    const flags = JSON.parse(readFileSync(configFile, "utf8"))?.cachedGrowthBookFeatures ?? {};
    if (flags.tengu_cedar_ember?.enabled === true) return { via: "cli", command: "/limit-reset", kind: "limits" };
    if (flags.tengu_nifty_lemur?.enabled === true) return { via: "cli", command: "/limit-reset", kind: "session" };
  } catch {}
  return null;
}

// ----------------------------------------------------------- credentials ----

type ClaudeCreds = { accessToken: string; expiresAt: number | null; plan: string | null };

async function readKeychain(service: string): Promise<string | null> {
  if (platform() !== "darwin") return null;
  try {
    const p = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

async function claudeCredentials(): Promise<ClaudeCreds | null> {
  const parse = (raw: string | null): ClaudeCreds | null => {
    if (!raw) return null;
    try {
      const o = JSON.parse(raw)?.claudeAiOauth;
      if (!o?.accessToken) return null;
      return { accessToken: o.accessToken, expiresAt: o.expiresAt ?? null, plan: o.rateLimitTier ?? o.subscriptionType ?? null };
    } catch {
      return null;
    }
  };
  // Keychain first on macOS (Claude Code's home there); the file is the Linux layout and a
  // stale leftover on Macs that once lacked a keychain.
  const fromKeychain = parse(await readKeychain("Claude Code-credentials"));
  if (fromKeychain) return fromKeychain;
  const file = join(CLAUDE_HOME(), ".credentials.json");
  return existsSync(file) ? parse(readFileSync(file, "utf8")) : null;
}

function codexCredentials(): { accessToken: string; accountId: string | null } | null {
  const file = join(CODEX_HOME(), "auth.json");
  if (!existsSync(file)) return null;
  try {
    const t = JSON.parse(readFileSync(file, "utf8"))?.tokens;
    return t?.access_token ? { accessToken: t.access_token, accountId: t.account_id ?? null } : null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ------------------------------------------------------- codex fallback ----

/** Newest `rate_limits` recorded in Codex's session transcripts (reads the tail of the newest few files). */
export function codexUsageFromSessions(codexHome = CODEX_HOME()): UsageSummary | null {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return null;
  // sessions/YYYY/MM/DD/rollout-*.jsonl: walk the newest day directories first
  const files: string[] = [];
  const descending = (dir: string) => { try { return readdirSync(dir).sort().reverse(); } catch { return []; } };
  outer: for (const y of descending(root)) for (const m of descending(join(root, y))) for (const d of descending(join(root, y, m))) {
    for (const f of descending(join(root, y, m, d))) if (f.endsWith(".jsonl")) files.push(join(root, y, m, d, f));
    if (files.length >= 6) break outer;
  }
  for (const file of files) {
    const text = tail(file, 256 * 1024);
    const lines = text.split("\n").filter((l) => l.includes('"rate_limits"'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        const rl = ev?.payload?.rate_limits;
        if (rl?.primary || rl?.secondary) return normalizeCodexSessionLimits(rl, Date.parse(ev.timestamp) || statSync(file).mtimeMs);
      } catch {}
    }
  }
  return null;
}

function tail(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// -------------------------------------------------------------- fetchers ----

async function fetchClaudeUsage(): Promise<UsageSummary> {
  if (!netAllowed()) return none("claude", "usage lookups disabled");
  const creds = await claudeCredentials();
  if (!creds) return none("claude", "not signed in to Claude Code on this node");
  if (creds.expiresAt && creds.expiresAt < Date.now()) return none("claude", "Claude Code sign-in expired; launch claude to refresh");
  try {
    const { status, json } = await fetchJson("https://api.anthropic.com/api/oauth/usage", { authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" });
    if (status === 401 || status === 403) return none("claude", "Claude Code sign-in rejected; launch claude to refresh");
    if (status !== 200 || !json) return none("claude", `usage API returned ${status}`);
    return normalizeClaudeUsage(json, creds.plan);
  } catch (err) {
    return none("claude", `usage API unreachable: ${err instanceof Error ? err.message : err}`);
  }
}

async function fetchCodexUsage(): Promise<UsageSummary> {
  const fallback = () => codexUsageFromSessions();
  if (!netAllowed()) return fallback() ?? none("codex", "usage lookups disabled");
  const creds = codexCredentials();
  if (!creds) return fallback() ?? none("codex", "not signed in to Codex on this node");
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${creds.accessToken}`, accept: "application/json" };
    if (creds.accountId) headers["chatgpt-account-id"] = creds.accountId;
    const { status, json } = await fetchJson("https://chatgpt.com/backend-api/wham/usage", headers);
    if (status === 200 && json) return normalizeCodexUsage(json);
    const fb = fallback();
    if (fb) return { ...fb, error: status === 401 ? "Codex sign-in expired; showing the last transcript's numbers" : `usage API returned ${status}; showing the last transcript's numbers` };
    return none("codex", status === 401 ? "Codex sign-in expired; launch codex to refresh" : `usage API returned ${status}`);
  } catch (err) {
    const fb = fallback();
    return fb ? { ...fb, error: "usage API unreachable; showing the last transcript's numbers" } : none("codex", `usage API unreachable: ${err instanceof Error ? err.message : err}`);
  }
}

// ------------------------------------------------------- local metrics ----

/** `df -Pk` rows -> DiskInfo (POSIX output: Filesystem 1024-blocks Used Available Capacity Mounted on). */
export function parseDf(output: string): Omit<DiskInfo, "paths">[] {
  const rows: Omit<DiskInfo, "paths">[] = [];
  for (const line of output.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem, blocks, used, avail, , ...mountParts] = parts;
    const total = Number(blocks) * 1024, usedB = Number(used) * 1024, free = Number(avail) * 1024;
    if (!Number.isFinite(total) || total <= 0) continue;
    // percent = used / (used + available): matches df's own Capacity on filesystems with reserved blocks
    rows.push({ filesystem, mount: mountParts.join(" "), totalBytes: total, usedBytes: usedB, freeBytes: free, percent: Math.round((usedB / Math.max(1, usedB + free)) * 100) });
  }
  return rows;
}

async function diskInfo(cfg: CyberdeckConfig): Promise<DiskInfo[]> {
  const paths = ["/", CYBERDECK_HOME, ...cfg.roots, ...(cfg.dataRoots ?? [])].filter((p, i, a) => existsSync(p) && a.indexOf(p) === i);
  const rows: DiskInfo[] = [];
  for (const path of paths) {
    try {
      const p = Bun.spawn(["df", "-Pk", path], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) continue;
      for (const row of parseDf(out)) rows.push({ ...row, paths: [path] });
    } catch {}
  }
  return mergeVolumes(rows);
}

/** /dev/disk3s1s1 and /dev/disk3s5 live in APFS container disk3; other device names are their own container. */
const container = (fs: string): string => /^\/dev\/disk\d+s\d+/.test(fs) ? fs.replace(/^(\/dev\/disk\d+)s.*$/, "$1") : fs;

/** One entry per physical volume. Rows with the same filesystem are the same mount; rows with the
 *  same total AND free bytes share a pool (APFS system + data volumes in one container, btrfs
 *  subvolumes) and are reported once, as the pool: used = total - free, named after "/" when
 *  it is a member. */
export function mergeVolumes(rows: DiskInfo[]): DiskInfo[] {
  const out: DiskInfo[] = [];
  for (const r of rows) {
    const same = out.find((o) => o.filesystem === r.filesystem || container(o.filesystem) === container(r.filesystem) || (o.totalBytes === r.totalBytes && Math.abs(o.freeBytes - r.freeBytes) <= r.totalBytes * 0.005));
    if (!same) { out.push({ ...r, paths: [...r.paths] }); continue; }
    for (const p of r.paths) if (!same.paths.includes(p)) same.paths.push(p);
    if (same.filesystem !== r.filesystem) {
      // a shared pool: report the pool's fullness and the most recognisable mount
      if (r.mount === "/" ) { same.mount = "/"; same.filesystem = r.filesystem; }
      same.usedBytes = same.totalBytes - same.freeBytes;
      same.percent = Math.round((same.usedBytes / Math.max(1, same.totalBytes)) * 100);
    }
  }
  return out.sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : b.totalBytes - a.totalBytes));
}

async function systemInfo(): Promise<SystemInfo> {
  const [a, b, c] = loadavg();
  return { platform: platform(), cpus: cpus().length, load: [a, b, c], totalMem: totalmem(), freeMem: await availableMem(), uptimeSec: uptime() };
}

/** Memory that can be handed out without swapping. `os.freemem()` only counts untouched pages,
 *  which on macOS is a few hundred MB on a healthy 32 GB machine; this reads the kernel's view. */
async function availableMem(): Promise<number> {
  try {
    if (platform() === "linux") {
      const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
      if (m) return Number(m[1]) * 1024;
    } else if (platform() === "darwin") {
      const p = Bun.spawn(["vm_stat"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) === 0) {
        const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
        const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
        return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * page;
      }
    }
  } catch {}
  return freemem();
}

/** Prompts per day for the last N days from Claude Code's and Codex's history files (one line per prompt). */
export function activityByDay(claudeHome = CLAUDE_HOME(), codexHome = CODEX_HOME(), days = ACTIVITY_DAYS, now = Date.now()): ActivityDay[] {
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const out = new Map<string, ActivityDay>();
  for (let i = days - 1; i >= 0; i--) {
    const d = dayKey(now - i * 86400000);
    out.set(d, { date: d, cc: 0, cx: 0 });
  }
  const count = (file: string, tool: "cc" | "cx", ts: (o: any) => number) => {
    if (!existsSync(file)) return;
    for (const line of tail(file, 2 * 1024 * 1024).split("\n")) {
      if (!line.startsWith("{")) continue; // a cut first line from the tail window
      try {
        const o = JSON.parse(line);
        const t = ts(o);
        if (!t) continue;
        const row = out.get(dayKey(t));
        if (row) row[tool]++;
      } catch {}
    }
  };
  count(join(claudeHome, "history.jsonl"), "cc", (o) => Number(o.timestamp) || 0);
  count(join(codexHome, "history.jsonl"), "cx", (o) => (Number(o.ts) || 0) * 1000);
  return [...out.values()];
}

export function redundancy(db: Database): Redundancy {
  const r = db
    .query(
      `SELECT COUNT(*) AS repos,
              COALESCE(SUM(risk = 'safe'), 0) AS safe,
              COALESCE(SUM(risk = 'attention'), 0) AS attention,
              COALESCE(SUM(risk = 'at-risk'), 0) AS atRisk,
              COALESCE(SUM(remotes = '[]'), 0) AS remoteless,
              COALESCE(SUM(dirty_files + untracked_files > 0), 0) AS dirty,
              COALESCE(SUM(ahead > 0), 0) AS unpushed,
              COALESCE(SUM(CASE WHEN risk != 'safe' THEN MAX(size_bytes - junk_bytes, 0) ELSE 0 END), 0) AS exposedBytes,
              MAX(scanned_at) AS lastScanAt
       FROM repos`
    )
    .get() as any;
  const d = db.query(`SELECT COALESCE(SUM(size_bytes), 0) AS dataBytes, COALESCE(SUM(cache_bytes), 0) AS dataCacheBytes FROM data_dirs`).get() as any;
  return { ...r, dataBytes: d.dataBytes, dataCacheBytes: d.dataCacheBytes };
}

/** The backup system (ROADMAP M2: blob store + replication) does not exist yet. This reports
 *  its configuration honestly so the widget lights up the day it lands. */
export function backupStatus(cfg: CyberdeckConfig): BackupStatus {
  const targets = (cfg.backup?.targets ?? []).map((node) => ({ node, lastSnapshotAt: null, ok: null }));
  return {
    configured: targets.length > 0,
    targets,
    lastSnapshotAt: null,
    snapshots: 0,
    protectedBytes: 0,
    note: targets.length ? "backup targets configured; the replication engine is not built yet (ROADMAP M2)" : "no backup system yet: redundancy comes from git remotes only (ROADMAP M2)",
  };
}

// ---------------------------------------------------------------- routes ----

export function registerDashboardRoutes(app: Hono, db: Database, cfg: CyberdeckConfig) {
  const cache = new Map<string, { at: number; value: Promise<UsageSummary> }>();
  const usage = (tool: "claude" | "codex", fresh: boolean): Promise<UsageSummary> => {
    const hit = cache.get(tool);
    if (hit && !fresh && Date.now() - hit.at < USAGE_CACHE_MS) return hit.value;
    const value = (tool === "claude" ? fetchClaudeUsage() : fetchCodexUsage()).catch((err) => none(tool, String(err instanceof Error ? err.message : err)));
    cache.set(tool, { at: Date.now(), value });
    return value;
  };

  app.get("/api/dashboard", async (c) => {
    const fresh = Boolean(c.req.query("fresh"));
    const [claude, codex, disks, system] = await Promise.all([usage("claude", fresh), usage("codex", fresh), diskInfo(cfg), systemInfo()]);
    const body: Dashboard = {
      at: Date.now(),
      usage: { claude: { ...claude, resets: claude.resets ?? claudeResetOffer() }, codex },
      disks,
      system,
      activity: activityByDay(),
      redundancy: redundancy(db),
      backup: backupStatus(cfg),
    };
    return c.json(body);
  });

  // ---- Codex rate-limit reset credits (spent through the official app-server) ----
  app.get("/api/usage/codex/resets", async (c) => {
    if (!resetsAllowed()) return c.json({ error: "usage lookups disabled" }, 503);
    try { return c.json(await readCodexResets()); }
    catch (err) { return c.json({ error: String(err instanceof Error ? err.message : err) }, 502); }
  });

  // One click = one idempotency key, so a retried request can never spend two credits.
  app.post("/api/usage/codex/reset", async (c) => {
    if (!resetsAllowed()) return c.json({ error: "usage lookups disabled" }, 503);
    const b = await c.req.json().catch(() => ({}));
    const creditId = typeof b.creditId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(b.creditId) ? b.creditId : undefined;
    if (b.creditId != null && !creditId) return c.json({ error: "bad creditId" }, 400);
    const key = typeof b.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(b.idempotencyKey) ? b.idempotencyKey : randomUUID();
    let outcome: CodexResetOutcome;
    try { outcome = await consumeCodexReset(key, creditId); }
    catch (err) { return c.json({ error: String(err instanceof Error ? err.message : err) }, 502); }
    cache.delete("codex"); // the next dashboard read shows the refilled limits
    return c.json({ outcome, message: RESET_MESSAGES[outcome] });
  });
}

const RESET_MESSAGES: Record<CodexResetOutcome, string> = {
  reset: "Codex limits reset.",
  nothingToReset: "Nothing to reset: no Codex limit is reached, so no credit was used.",
  noCredit: "No reset credit available.",
  alreadyRedeemed: "That reset was already used.",
  unknown: "Codex answered with an outcome this version does not know; check the limits above.",
};
