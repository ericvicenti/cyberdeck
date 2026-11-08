// Fleet disk headroom, for the `disks` MCP tool (and through it the voice agent and the daily check-in).
//
// A full disk has taken a fleet machine down more than once (yacht 2026-10-12; agentic prod 2026-10-31,
// when the enuc backup's VACUUM INTO copy filled /var/lib/docker). Each paired node reports its own
// volumes (`GET /api/disks`, the same rows as the Home page's Storage widget); a manifest host without a
// Cyberdeck node (agentic) is read with a fixed `df -Pk` over its ssh alias. These helpers are pure,
// except the `disk_samples` history: every node samples its own volumes hourly (and the node answering
// the tool records what it read from the others), so a reading can say how fast a disk fills.
import type { Database } from "bun:sqlite";
import { mergeVolumes, parseDf, type DiskInfo } from "./api/dashboard";

/** A disk is "nearly full" at this percentage, or with less than LOW_FREE_BYTES left, whichever comes first. */
export const FULL_PERCENT = 90;
export const LOW_FREE_BYTES = 10 * 1024 ** 3;

/** The command run on a host without a Cyberdeck node: local filesystems only where df supports it. */
export const REMOTE_DF = "df -Pk -l 2>/dev/null || df -Pk";

/** macOS auxiliary APFS volumes that share the boot container and say nothing about headroom on their own. */
const MAC_AUX = /^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)(\/|$)/;

/** `df -Pk` from a remote host -> its real volumes: block devices only (no tmpfs, overlay, snap loops, boot partitions), pools merged. */
export function remoteDisks(dfOutput: string): DiskInfo[] {
  const rows = parseDf(dfOutput)
    .filter((r) => r.filesystem.startsWith("/dev/") && !/^\/dev\/loop/.test(r.filesystem))
    .filter((r) => !MAC_AUX.test(r.mount) && !/^\/boot(\/|$)/.test(r.mount) && !/^\/(snap|run|dev)(\/|$)/.test(r.mount))
    .map((r) => ({ ...r, paths: [r.mount] }));
  return mergeVolumes(rows);
}

export type HostDisks = {
  host: string;
  /** Where the numbers came from: this node, a paired node's daemon, or `df` over ssh. */
  via: "self" | "cyberdeck" | "ssh";
  disks: DiskInfo[];
  /** Set when the host could not be read; `disks` is then empty. */
  error?: string;
};

export const nearlyFull = (d: DiskInfo) => d.percent >= FULL_PERCENT || d.freeBytes < LOW_FREE_BYTES;

// ------------------------------------------------------------------ trend ----

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Samples older than this do not count toward the rate. */
export const TREND_WINDOW_MS = 7 * DAY;
/** A rate needs samples at least this far apart. */
export const TREND_MIN_SPAN_MS = 12 * HOUR;
/** Below this loss a day a disk is "steady", not filling. */
export const TREND_MIN_LOSS = 256 * 1024 ** 2;
/** Free space that comes back by more than this between two samples is a cleanup: the rate starts after it. */
export const TREND_CLEANUP_BYTES = 1024 ** 3;
/** A disk not yet nearly full but due to fill within this many days is "filling fast". */
export const FILLING_DAYS = 14;
export const SAMPLE_EVERY_MS = 50 * 60_000;
const KEEP_MS = 30 * DAY;

export type DiskSample = { at: number; freeBytes: number; totalBytes: number };
export type DiskTrend = {
  /** Bytes lost per day (negative: the disk is gaining space). */
  lossPerDay: number;
  /** Days until free space runs out at that rate; null when it is not filling. */
  daysLeft: number | null;
  /** How much history the rate is drawn from. */
  spanDays: number;
  samples: number;
};

/**
 * The fill rate over the last week: a least-squares line through free bytes, after the latest cleanup
 * (free space jumping back up) and ignoring samples taken while the volume had another size. Null until
 * there are samples at least 12 h apart.
 */
export function diskTrend(samples: DiskSample[], now = Date.now()): DiskTrend | null {
  let s = samples.filter((x) => x.at > now - TREND_WINDOW_MS && x.at <= now).sort((a, b) => a.at - b.at);
  if (!s.length) return null;
  const total = s[s.length - 1].totalBytes;
  s = s.filter((x) => Math.abs(x.totalBytes - total) <= total * 0.01);
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i].freeBytes - s[i - 1].freeBytes > TREND_CLEANUP_BYTES) { s = s.slice(i); break; }
  }
  if (s.length < 2) return null;
  const span = s[s.length - 1].at - s[0].at;
  if (span < TREND_MIN_SPAN_MS) return null;
  const t0 = s[0].at;
  const xs = s.map((x) => (x.at - t0) / DAY);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = s.reduce((a, x) => a + x.freeBytes, 0) / s.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (s[i].freeBytes - my); den += (x - mx) ** 2; });
  const lossPerDay = den ? -num / den : 0;
  const free = s[s.length - 1].freeBytes;
  return {
    lossPerDay: Math.round(lossPerDay),
    daysLeft: lossPerDay >= TREND_MIN_LOSS ? Math.round((free / lossPerDay) * 10) / 10 : null,
    spanDays: Math.round((span / DAY) * 10) / 10,
    samples: s.length,
  };
}

/** "losing 3 GB a day, full in about 2 days"; null when the disk is not filling or will last months. */
export function trendWords(t: DiskTrend | null | undefined): string | null {
  if (!t || t.daysLeft === null || t.daysLeft >= 90) return null;
  const d = t.daysLeft;
  const when = d < 1 ? "full within a day" : d < 1.5 ? "full in about a day" : d < 14 ? `full in about ${Math.round(d)} days` : `full in about ${Math.round(d / 7)} weeks`;
  return `losing ${sizeWords(t.lossPerDay)} a day, ${when}`;
}

export const fillingFast = (d: DiskInfo) => !nearlyFull(d) && d.trend?.daysLeft != null && d.trend.daysLeft < FILLING_DAYS;

export function ensureDiskSamples(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS disk_samples (host TEXT NOT NULL, mount TEXT NOT NULL, at INTEGER NOT NULL, free INTEGER NOT NULL, total INTEGER NOT NULL)`);
  db.run(`CREATE INDEX IF NOT EXISTS disk_samples_key ON disk_samples(host, mount, at)`);
}

/** Stores one sample per volume, at most one per SAMPLE_EVERY_MS, and drops month-old ones. */
export function recordDisks(db: Database, host: string, disks: DiskInfo[], now = Date.now()) {
  const h = host.toLowerCase();
  const last = db.query(`SELECT MAX(at) AS at FROM disk_samples WHERE host = ? AND mount = ?`);
  const put = db.query(`INSERT INTO disk_samples (host, mount, at, free, total) VALUES (?, ?, ?, ?, ?)`);
  for (const d of disks) {
    const prev = (last.get(h, d.mount) as { at: number | null } | null)?.at;
    if (prev && now - prev < SAMPLE_EVERY_MS) continue;
    put.run(h, d.mount, now, d.freeBytes, d.totalBytes);
  }
  db.query(`DELETE FROM disk_samples WHERE at < ?`).run(now - KEEP_MS);
}

/** The volumes with `trend` filled from this node's history of that host. */
export function withTrends(db: Database, host: string, disks: DiskInfo[], now = Date.now()): DiskInfo[] {
  const q = db.query(`SELECT at, free AS freeBytes, total AS totalBytes FROM disk_samples WHERE host = ? AND mount = ? AND at > ? ORDER BY at`);
  return disks.map((d) => ({ ...d, trend: diskTrend(q.all(host.toLowerCase(), d.mount, now - TREND_WINDOW_MS) as DiskSample[], now) }));
}

/** Record, then read back with trends: what every reader of a host's disks does. */
export function sampleDisks(db: Database, host: string, disks: DiskInfo[], now = Date.now()): DiskInfo[] {
  recordDisks(db, host, disks, now);
  return withTrends(db, host, disks, now);
}

/** "12 GB" / "850 MB": whole units, as said aloud. */
export function sizeWords(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`;
  if (Math.round(bytes / 1024 ** 2) >= 1024) return `${Math.round(gb)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

const label = (host: string, d: DiskInfo) => `${host} ${d.mount}`;
const reading = (host: string, d: DiskInfo) => {
  const t = trendWords(d.trend);
  return `${label(host, d)} at ${d.percent}% (${sizeWords(d.freeBytes)} free${t ? `, ${t}` : ""})`;
};

/**
 * One spoken sentence over the fleet's disks: the nearly full ones first (or "none nearly full"),
 * then any filling fast (due to fill within FILLING_DAYS), then the fullest of the rest, then the hosts
 * that could not be read. A disk with a known fill rate says it: "losing 3 GB a day, full in about 2 days".
 */
export function disksSentence(hosts: HostDisks[]): string {
  const all = hosts.flatMap((h) => h.disks.map((d) => ({ host: h.host, d }))).sort((a, b) => b.d.percent - a.d.percent);
  const read = hosts.filter((h) => !h.error);
  const failed = hosts.filter((h) => h.error).map((h) => h.host);
  if (!all.length) return failed.length ? `No disk could be read; ${failed.join(", ")} did not answer.` : "No disks to report.";
  const full = all.filter((x) => nearlyFull(x.d));
  const filling = all.filter((x) => fillingFast(x.d)).sort((a, b) => a.d.trend!.daysLeft! - b.d.trend!.daysLeft!);
  const rest = all.filter((x) => !nearlyFull(x.d) && !fillingFast(x.d));
  const parts: string[] = [];
  parts.push(`${all.length} ${all.length === 1 ? "disk" : "disks"} on ${read.length} ${read.length === 1 ? "host" : "hosts"}`);
  if (full.length) parts.push(`nearly full: ${full.slice(0, 4).map((x) => reading(x.host, x.d)).join(", ")}${full.length > 4 ? ` and ${full.length - 4} more` : ""}`);
  else parts.push("none nearly full");
  if (filling.length) parts.push(`filling fast: ${filling.slice(0, 2).map((x) => reading(x.host, x.d)).join(", ")}${filling.length > 2 ? ` and ${filling.length - 2} more` : ""}`);
  if (rest.length) parts.push(`${full.length ? "next" : "fullest"} ${rest.slice(0, full.length ? 1 : 2).map((x) => reading(x.host, x.d)).join(", ")}`);
  let s = parts.join("; ");
  if (failed.length) s += `; ${failed.join(", ")} did not answer`;
  return `${s}.`;
}
