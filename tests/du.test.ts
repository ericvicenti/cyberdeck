import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { lowPriority, duBytes, cachedJunkBytes, clearJunkCache, JUNK_TTL_MS } from "../src/daemon/indexer/du";
import { tmpHomeDir } from "./helpers";

beforeEach(clearJunkCache);

test("du runs at background priority on every platform", () => {
  expect(lowPriority("darwin", () => true)).toEqual(["/usr/sbin/taskpolicy", "-b"]);
  expect(lowPriority("linux", () => true)).toEqual(["/usr/bin/ionice", "-c3", "nice", "-n", "19"]);
  expect(lowPriority("linux", () => false)).toEqual(["nice", "-n", "19"]);
});

test("duBytes measures real directories and runs one du at a time", async () => {
  const { dir, cleanup } = tmpHomeDir("du");
  try {
    const a = join(dir, "a");
    mkdirSync(a);
    writeFileSync(join(a, "blob"), "x".repeat(200_000));
    const sizes = await Promise.all([duBytes([a]), duBytes([a]), duBytes([])]);
    expect(sizes[0].get(a)).toBeGreaterThan(150_000);
    expect(sizes[1].get(a)).toBe(sizes[0].get(a));
    expect(sizes[2].size).toBe(0);
  } finally {
    cleanup();
  }
});

test("repo junk sizes are cached until the target list changes or the TTL passes", async () => {
  let calls = 0;
  const measure = async (paths: string[]) => {
    calls++;
    return new Map(paths.map((p) => [p, 1024 * calls]));
  };
  const t0 = 1_000_000;
  expect(await cachedJunkBytes("/r", ["/r/node_modules"], t0, measure)).toBe(1024);
  expect(await cachedJunkBytes("/r", ["/r/node_modules"], t0 + 60_000, measure)).toBe(1024);
  expect(calls).toBe(1);
  // A new junk dir re-measures at once.
  expect(await cachedJunkBytes("/r", ["/r/node_modules", "/r/build"], t0 + 61_000, measure)).toBe(4096);
  expect(calls).toBe(2);
  // So does age.
  await cachedJunkBytes("/r", ["/r/node_modules", "/r/build"], t0 + 61_000 + JUNK_TTL_MS, measure);
  expect(calls).toBe(3);
  // No junk, no du.
  expect(await cachedJunkBytes("/r", [], t0, measure)).toBe(0);
  expect(calls).toBe(3);
});
