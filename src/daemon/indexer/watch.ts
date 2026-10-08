// Automatic rescans: watch the code roots recursively (FSEvents on macOS,
// inotify on Linux) and debounce changes into a repo scan. Data roots are
// heavy (du over Documents etc.), so they rescan on a slower timer instead.
import { watch, existsSync, type FSWatcher } from "fs";
import type { Database } from "bun:sqlite";
import type { CyberdeckConfig } from "../config";
import { runScan } from "./scan";
import { runDataScan } from "./data";
import { bus } from "../events";

const IGNORE = /node_modules|\.git\/|\/\.cache\/|\/dist\/|\/build\//;

export function startWatcher(db: Database, cfg: CyberdeckConfig, debounceMs = 15_000): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingChanges = 0;

  const schedule = () => {
    pendingChanges++;
    clearTimeout(timer);
    timer = setTimeout(() => {
      bus.emit({ kind: "watch:rescan", changes: pendingChanges });
      pendingChanges = 0;
      runScan(db, cfg).catch((err) => console.error("watch-triggered scan failed:", err));
    }, debounceMs);
  };

  for (const root of cfg.roots) {
    if (!existsSync(root)) continue;
    try {
      const w = watch(root, { recursive: true }, (_event, filename) => {
        if (filename && IGNORE.test(`/${filename}/`)) return;
        schedule();
      });
      // A watcher can fail after it is set up (Linux: ENOSPC once the inotify
      // watch limit is hit on a big tree). Unhandled, that error event kills
      // the whole daemon; instead drop this root and rely on the hourly scan.
      w.on("error", (err) => {
        console.error(`watch on ${root} failed, falling back to periodic scans:`, err instanceof Error ? err.message : err);
        try { w.close(); } catch {}
        const i = watchers.indexOf(w);
        if (i >= 0) watchers.splice(i, 1);
      });
      watchers.push(w);
    } catch (err) {
      console.error(`could not watch ${root}:`, err);
    }
  }
  console.log(`watching ${watchers.length} root(s) for changes (auto-rescan)`);

  // Data roots: rescan every 6 hours.
  const dataTimer = setInterval(() => {
    runDataScan(db, cfg).catch((err) => console.error("periodic data scan failed:", err));
  }, 6 * 60 * 60 * 1000);

  return () => {
    for (const w of watchers) w.close();
    clearTimeout(timer);
    clearInterval(dataTimer);
  };
}
