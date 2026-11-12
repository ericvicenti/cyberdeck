import type { DiskInfo } from "../../src/daemon/api/dashboard";
// Mirror the warning thresholds in src/daemon/disks.ts (do not bundle daemon code into Vite).
const FILLING_DAYS = 14, FULL_PERCENT = 90, LOW_FREE_BYTES = 10 * 1024 ** 3;

// The API reports merged volumes, not partitions. Keep both reported fields in the URL
// so two volumes mounted on the same path cannot silently resolve to the wrong item.
export function storageRoute(node: string, disk: Pick<DiskInfo, "filesystem" | "mount">) {
  return { node: node || "self", filesystem: disk.filesystem, mount: disk.mount };
}
export function findStorageDisk(disks: DiskInfo[], filesystem: string, mount: string) {
  return disks.find((d) => d.filesystem === filesystem && d.mount === mount) ?? null;
}
export function storageWarning(d: DiskInfo): { level: "bad" | "warn" | "ok"; text: string } {
  if (d.percent >= FULL_PERCENT || d.freeBytes < LOW_FREE_BYTES) return { level: "bad", text: "Low space — this volume is nearly full" };
  if (d.trend?.daysLeft != null && d.trend.daysLeft <= FILLING_DAYS) return { level: "warn", text: `Filling fast — projected full in about ${Math.max(1, Math.ceil(d.trend.daysLeft))} day(s)` };
  if (d.percent >= 80) return { level: "warn", text: "High utilization — watch available space" };
  return { level: "ok", text: "Space available" };
}
