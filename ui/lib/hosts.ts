// Run a command in a terminal on a fleet host (a name from fleet.json), from any view.
// Natively when the host is this node or a paired online node; otherwise over ssh
// from here using the alias fleet.json gives it.
import { useEffect, useState } from "react";
import { activeNode } from "./api";
import { openTerminal, shq } from "./terms";
import { fetchNodes, type FleetNode } from "./sessions";
import type { HostStatus } from "./control";

export function useFleetNodes(): FleetNode[] {
  const [nodes, setNodes] = useState<FleetNode[]>([]);
  useEffect(() => { fetchNodes().then((f) => setNodes(f.nodes ?? [])).catch(() => {}); }, []);
  return nodes;
}

export type HostTarget = {
  /** fleet.json host name */
  host: string;
  /** the host the control data came from (`status.host`), i.e. "here" */
  me: string;
  hosts: HostStatus[];
  nodes: FleetNode[];
};

/** Where a command for `host` would run. */
export function resolveHost(t: HostTarget): { kind: "local" } | { kind: "node"; id: string; name: string } | { kind: "ssh"; alias: string } | { kind: "none"; reason: string } {
  const h = t.host.toLowerCase();
  if (h === t.me.toLowerCase()) return { kind: "local" };
  const n = t.nodes.find((x) => x.name.toLowerCase() === h);
  if (n?.online) return { kind: "node", id: n.id, name: n.name };
  const alias = t.hosts.find((x) => x.name.toLowerCase() === h)?.ssh;
  if (alias) return { kind: "ssh", alias };
  return { kind: "none", reason: n ? `${t.host} is offline` : `${t.host} has no ssh alias and is not a paired node` };
}

/** Open a terminal running `cmd` on the host. Returns an error message, or null when a session was started. */
export function openOnHost(t: HostTarget & { cmd?: string; cwd?: string; title: string }): string | null {
  const r = resolveHost(t);
  if (r.kind === "none") return r.reason;
  if (r.kind === "local") { openTerminal({ node: activeNode(), cwd: t.cwd ?? "", cmd: t.cmd, title: t.title }); return null; }
  if (r.kind === "node") { openTerminal({ node: r.id, nodeName: r.name, cwd: t.cwd ?? "", cmd: t.cmd, title: t.title }); return null; }
  const remote = t.cwd ? `cd ${shq(t.cwd)} && ${t.cmd ?? "exec $SHELL -l"}` : t.cmd;
  openTerminal({ node: activeNode(), cwd: "", cmd: remote ? `ssh -t ${r.alias} ${shq(remote)}` : `ssh ${r.alias}`, title: t.title });
  return null;
}
