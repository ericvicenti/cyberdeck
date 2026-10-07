// Terminal helpers. Terminals are live sessions owned by the daemon (see lib/sessions.ts);
// this module keeps the launch-command vocabulary and the "open a terminal here" entry
// point that other views use.
import { startSession } from "./sessions";
import type { Tool } from "../../src/shared/harness";
export { AGENT_CMDS, launchCmd, resumeCmd, shq, shortCwd } from "../../src/shared/harness";

const RECENT_KEY = "cyberdeck-term-recent-cwds";
export function recentCwds(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } }
export function rememberCwd(cwd: string) {
  if (!cwd) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([cwd, ...recentCwds().filter((c) => c !== cwd)].slice(0, 12))); } catch {}
}

/** Start a session on a node (switching the UI to that node) and navigate to it. */
export function openTerminal(opts: { node?: string; nodeName?: string; title?: string; cwd: string; cmd?: string; tool?: Tool; prompt?: string }) {
  rememberCwd(opts.cwd);
  return startSession({ ...opts, open: true });
}
