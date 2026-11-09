// Disk usage for the indexers. `du` over node_modules/build trees is the most
// expensive thing the daemon does: the repo scan reruns on every quiet moment
// in ~/Code, and with eight parallel `du` children over ~40 Seed worktrees it
// kept yacht's load average above 100 (2026-11-04). So every `du` here runs
// one at a time at background priority, and repo junk sizes are cached.
import { existsSync } from "fs";

/** argv prefix that runs a command at background priority (CPU and I/O). */
export function lowPriority(platform = process.platform, has = existsSync): string[] {
  if (platform === "darwin" && has("/usr/sbin/taskpolicy")) return ["/usr/sbin/taskpolicy", "-b"];
  if (platform === "linux" && has("/usr/bin/ionice")) return ["/usr/bin/ionice", "-c3", "nice", "-n", "19"];
  return ["nice", "-n", "19"];
}

const PREFIX = lowPriority();
let tail: Promise<unknown> = Promise.resolve();

/** Run `fn` after every `du` already queued daemon-wide (the indexer's and the space report's share one queue). */
export function serialDu<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn, fn);
  tail = result.catch(() => {});
  return result;
}

/** `du -xk -d 1 <dir>` at background priority, in the shared queue: the directory's total and its direct subdirectories, in bytes. Null when it took longer than `timeoutMs`. */
export function duTree(dir: string, timeoutMs: number): Promise<{ bytes: number; children: Map<string, number> } | null> {
  return serialDu(async () => {
    const proc = Bun.spawn([...PREFIX, "du", "-xk", "-d", "1", dir], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    if (proc.signalCode) return null;
    const children = new Map<string, number>();
    let bytes = 0;
    for (const line of text.split("\n")) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const b = parseInt(m[1], 10) * 1024;
      if (m[2] === dir) bytes = b;
      else children.set(m[2], b);
    }
    return { bytes, children };
  });
}

/** `du -sk` sizes in bytes keyed by path, serialised daemon-wide. */
export function duBytes(paths: string[]): Promise<Map<string, number>> {
  const run = async () => {
    const out = new Map<string, number>();
    // Batch to keep argv within limits.
    for (let i = 0; i < paths.length; i += 50) {
      const batch = paths.slice(i, i + 50);
      const proc = Bun.spawn([...PREFIX, "du", "-sk", ...batch], { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      for (const line of text.split("\n")) {
        const m = line.match(/^(\d+)\s+(.+)$/);
        if (m) out.set(m[2], parseInt(m[1], 10) * 1024);
      }
    }
    return out;
  };
  if (paths.length === 0) return Promise.resolve(new Map());
  return serialDu(run);
}

/** How long a repo's junk size stays good. Sizes are informational; a new or removed junk dir re-measures at once. */
export const JUNK_TTL_MS = 6 * 60 * 60 * 1000;

const junkCache = new Map<string, { key: string; bytes: number; at: number }>();

/** Total size of `targets`, reusing the last measurement for `repo` while the target list is unchanged and fresh. */
export async function cachedJunkBytes(
  repo: string,
  targets: string[],
  now = Date.now(),
  measure: (paths: string[]) => Promise<Map<string, number>> = duBytes,
): Promise<number> {
  if (targets.length === 0) return 0;
  const key = targets.join("\0");
  const hit = junkCache.get(repo);
  if (hit && hit.key === key && now - hit.at < JUNK_TTL_MS) return hit.bytes;
  let bytes = 0;
  for (const v of (await measure(targets)).values()) bytes += v;
  junkCache.set(repo, { key, bytes, at: now });
  return bytes;
}

export function clearJunkCache(): void {
  junkCache.clear();
}
