import { test, expect } from "bun:test";
import type { DiskInfo } from "../src/daemon/api/dashboard";
import { findStorageDisk, storageRoute, storageWarning } from "../ui/lib/storage";
import { routeHash, readRoute, routeTitle } from "../ui/lib/navigation";

const disk: DiskInfo = { filesystem: "tank/iris", mount: "/mnt/Iris ambience", totalBytes: 100 * 1024 ** 3, usedBytes: 40 * 1024 ** 3, freeBytes: 60 * 1024 ** 3, percent: 40, paths: ["/mnt/Iris ambience"] };
test("storage links retain explicit machine and both volume identity fields", () => {
  const route = storageRoute("peer-iris", disk);
  const hash = routeHash("storage", route);
  expect(hash).toContain("node=peer-iris");
  const parsed = readRoute(hash);
  expect(parsed.params.get("filesystem")).toBe("tank/iris");
  expect(parsed.params.get("mount")).toBe("/mnt/Iris ambience");
  expect(findStorageDisk([disk, { ...disk, mount: "/other" }], parsed.params.get("filesystem")!, parsed.params.get("mount")!)).toBe(disk);
  expect(findStorageDisk([disk], disk.filesystem, "/gone")).toBeNull();
  expect(storageRoute("", disk).node).toBe("self");
  expect(routeTitle(parsed)).toContain("/mnt/Iris ambience · Storage");
});
test("health warns for low space, high utilization and fast fill without inventing trend", () => {
  expect(storageWarning(disk).level).toBe("ok");
  expect(storageWarning({ ...disk, percent: 83 }).level).toBe("warn");
  expect(storageWarning({ ...disk, trend: { lossPerDay: 1024 ** 3, daysLeft: 3, samples: 12, spanDays: 3 } }).text).toContain("3 day");
  expect(storageWarning({ ...disk, freeBytes: 2 * 1024 ** 3 }).level).toBe("bad");
  expect(storageWarning({ ...disk, percent: 91 }).level).toBe("bad");
});
