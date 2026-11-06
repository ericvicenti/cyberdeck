// Host liveness in `deck status` comes from the tailnet, but the fleet's peers now talk over Probe
// (yacht has had no Tailscale since 2026-10-29, botical has no tailnet name at all), so the manifest
// says "offline" or "unknown" for machines Cyberdeck is talking to right now. A paired node that
// answered settles it: that host is online, reached by Cyberdeck. Shared by the MCP `fleet_status`
// tool (what the voice agent and the daily check-in read) and the Desk's Fleet glance.

/** A paired Cyberdeck node and whether it answered just now (`transport` = how it was reached). */
export type PeerSeen = { name: string; online: boolean; transport?: "probe" | "http" };

export type Live<H> = H & { reach?: "cyberdeck"; transport?: "probe" | "http" };

/**
 * `hosts` with every host the manifest does not call online, but whose paired node answered, marked
 * `online: true` + `reach: "cyberdeck"`. A peer that did not answer only fills in an unknown host;
 * it never overrides the manifest.
 */
export function withPeerLiveness<H extends { name: string; online?: boolean | null }>(hosts: H[], peers: PeerSeen[]): Live<H>[] {
  const seen = new Map(peers.map((p) => [p.name.toLowerCase(), p]));
  return hosts.map((h) => {
    const p = seen.get(h.name.toLowerCase());
    if (!p || h.online === true) return h;
    if (p.online) return { ...h, online: true, reach: "cyberdeck" as const, ...(p.transport ? { transport: p.transport } : {}) };
    return h.online == null ? { ...h, online: false } : h;
  });
}
