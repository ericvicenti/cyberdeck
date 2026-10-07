// Terminal tabs: per-node, persisted in localStorage. A tab is a cwd + optional startup command;
// the startup command is sent as the first input after the PTY opens, so it works unchanged
// through the fleet proxy to another node.
import { activeNode, setActiveNode, navigate } from "./api";

export type TermTab = { id: string; title: string; cwd: string; cmd?: string; created: number };

const key = (node: string) => `cyberdeck-term-tabs:${node || "local"}`;
const RECENT_KEY = "cyberdeck-term-recent-cwds";

export function listTabs(node = activeNode()): TermTab[] {
  try { return JSON.parse(localStorage.getItem(key(node)) ?? "[]"); } catch { return []; }
}
function saveTabs(node: string, tabs: TermTab[]) {
  try { localStorage.setItem(key(node), JSON.stringify(tabs)); } catch {}
}
export function addTab(node: string, t: { title?: string; cwd: string; cmd?: string }): TermTab {
  const tab: TermTab = { id: Math.random().toString(36).slice(2, 10), title: t.title || (t.cmd ? t.cmd.split(" ")[0] : shortCwd(t.cwd)), cwd: t.cwd, cmd: t.cmd, created: Date.now() };
  saveTabs(node, [...listTabs(node), tab]);
  rememberCwd(t.cwd);
  return tab;
}
export function removeTab(node: string, id: string) { saveTabs(node, listTabs(node).filter((t) => t.id !== id)); }
export function renameTab(node: string, id: string, title: string) { saveTabs(node, listTabs(node).map((t) => (t.id === id ? { ...t, title } : t))); }
export function recentCwds(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } }
export function rememberCwd(cwd: string) {
  if (!cwd) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([cwd, ...recentCwds().filter((c) => c !== cwd)].slice(0, 12))); } catch {}
}
export const shortCwd = (cwd: string) => (cwd || "~").replace(/^\/(Users|home)\/[^/]+/, "~");

/** POSIX single-quote shell quoting. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Open a terminal tab on a node (switching the UI to that node if needed) and navigate to it. */
export function openTerminal(opts: { node?: string; nodeName?: string; title?: string; cwd: string; cmd?: string }) {
  const node = opts.node ?? activeNode();
  if (node !== activeNode()) setActiveNode(node, opts.nodeName ?? "node");
  const tab = addTab(node, { title: opts.title, cwd: opts.cwd, cmd: opts.cmd });
  navigate("term", { tab: tab.id });
  return tab;
}

export const AGENT_CMDS = {
  cc: "claude --dangerously-skip-permissions",
  cx: "codex --yolo",
} as const;
export const launchCmd = (tool: "cc" | "cx", prompt?: string) => (prompt ? `${AGENT_CMDS[tool]} ${shq(prompt)}` : AGENT_CMDS[tool]);
export const resumeCmd = (tool: "cc" | "cx", id: string) => (tool === "cc" ? `${AGENT_CMDS.cc} --resume ${shq(id)}` : `${AGENT_CMDS.cx} resume ${shq(id)}`);
