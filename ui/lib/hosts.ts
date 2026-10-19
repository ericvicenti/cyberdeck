// Run a command in a terminal on a fleet host (a name from fleet.json), from any view.
// Natively when the host is this node or a paired online node; otherwise over ssh
// from here using the alias fleet.json gives it. The target is always resolved from
// the host name on the row, never from a page-wide selection, and "here" is the machine
// serving the page, never the machine the Deck data was read from (src/shared/fleetview.ts).
import { openTerminal, shq } from "./terms";
import { useFleet, type FleetNode, type OverviewSource } from "./fleet";
import type { HostStatus, Overview } from "./control";
import { resolveHost, servingHost } from "../../src/shared/fleetview";

export { resolveHost };

export function useFleetNodes(): FleetNode[] {
  return useFleet().fleet?.nodes ?? [];
}

export type HostTarget = {
  /** fleet.json host name */
  host: string;
  /** the fleet.json name of the machine serving this page ("here"); see `useHostTargets` */
  me: string;
  hosts: HostStatus[];
  nodes: FleetNode[];
};

/** The pieces `openOnHost` needs, with `me` derived safely from where the overview came from. */
export function useHostTargets(ov: Overview | null, source: OverviewSource | null): { me: string; selfName: string; hosts: HostStatus[]; nodes: FleetNode[] } {
  const { fleet } = useFleet();
  return { me: servingHost(ov?.status?.host, source, fleet?.self.name), selfName: fleet?.self.name ?? "", hosts: ov?.status?.hosts ?? [], nodes: fleet?.nodes ?? [] };
}

/** Open a terminal running `cmd` on the host. Returns an error message, or null when a session was started. */
export function openOnHost(t: HostTarget & { cmd?: string; cwd?: string; title: string }): string | null {
  const r = resolveHost(t);
  if (r.kind === "none") return r.reason;
  if (r.kind === "local") { openTerminal({ node: "", cwd: t.cwd ?? "", cmd: t.cmd, title: t.title }); return null; }
  if (r.kind === "node") { openTerminal({ node: r.id, nodeName: r.name, cwd: t.cwd ?? "", cmd: t.cmd, title: t.title }); return null; }
  const remote = t.cwd ? `cd ${shq(t.cwd)} && ${t.cmd ?? "exec $SHELL -l"}` : t.cmd;
  openTerminal({ node: "", cwd: "", cmd: remote ? `ssh -t ${r.alias} ${shq(remote)}` : `ssh ${r.alias}`, title: t.title });
  return null;
}
