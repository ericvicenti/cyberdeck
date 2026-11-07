// Fleet disk headroom, for the `disks` MCP tool (and through it the voice agent and the daily check-in).
//
// A full disk has taken a fleet machine down more than once (yacht 2026-10-12; agentic prod 2026-10-31,
// when the enuc backup's VACUUM INTO copy filled /var/lib/docker). Each paired node reports its own
// volumes (`GET /api/disks`, the same rows as the Home page's Storage widget); a manifest host without a
// Cyberdeck node (agentic) is read with a fixed `df -Pk` over its ssh alias. These helpers are pure.
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

/** "12 GB" / "850 MB": whole units, as said aloud. */
export function sizeWords(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 1) return `${Math.round(gb)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

const label = (host: string, d: DiskInfo) => `${host} ${d.mount}`;
const reading = (host: string, d: DiskInfo) => `${label(host, d)} at ${d.percent}% (${sizeWords(d.freeBytes)} free)`;

/**
 * One spoken sentence over the fleet's disks: the nearly full ones first (or "none nearly full"),
 * then the fullest of the rest, then the hosts that could not be read.
 */
export function disksSentence(hosts: HostDisks[]): string {
  const all = hosts.flatMap((h) => h.disks.map((d) => ({ host: h.host, d }))).sort((a, b) => b.d.percent - a.d.percent);
  const read = hosts.filter((h) => !h.error);
  const failed = hosts.filter((h) => h.error).map((h) => h.host);
  if (!all.length) return failed.length ? `No disk could be read; ${failed.join(", ")} did not answer.` : "No disks to report.";
  const full = all.filter((x) => nearlyFull(x.d));
  const rest = all.filter((x) => !nearlyFull(x.d));
  const parts: string[] = [];
  parts.push(`${all.length} ${all.length === 1 ? "disk" : "disks"} on ${read.length} ${read.length === 1 ? "host" : "hosts"}`);
  if (full.length) parts.push(`nearly full: ${full.slice(0, 4).map((x) => reading(x.host, x.d)).join(", ")}${full.length > 4 ? ` and ${full.length - 4} more` : ""}`);
  else parts.push("none nearly full");
  if (rest.length) parts.push(`${full.length ? "next" : "fullest"} ${rest.slice(0, full.length ? 1 : 2).map((x) => reading(x.host, x.d)).join(", ")}`);
  let s = parts.join("; ");
  if (failed.length) s += `; ${failed.join(", ")} did not answer`;
  return `${s}.`;
}
