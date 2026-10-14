// The Desk's glance tabs under the TALK button (Fleet / Services / Agents): one read of
// /api/control/overview boiled down to what you would ask the agent about. Pure, so the
// tests can feed it the fleet stub's overview.
import type { HostStatus, Overview, Run, ServiceRow, Task } from "./control";

export type GlanceTab = "fleet" | "services" | "agents";
export const GLANCE_TABS: [GlanceTab, string][] = [["fleet", "Fleet"], ["services", "Services"], ["agents", "Agents"]];

export type Glance = {
  hosts: { up: number; down: number; unknown: number; rows: HostStatus[] };
  services: { up: number; down: ServiceRow[]; unknown: ServiceRow[]; total: number; probedAt: string | null } | null;
  agents: { active: Task[]; open: number; runs: Run[]; auto: boolean };
  handoffOpen: number | null;
};

const ACTIVE = new Set(["running", "review", "blocked"]);
const hostRank = (h: HostStatus) => (h.online === false ? 0 : h.online == null ? 1 : 2);
const taskRank = (t: Task) => (t.status === "running" ? 0 : t.status === "review" ? 1 : t.status === "blocked" ? 2 : 3);

export function glance(ov: Overview): Glance {
  const hostRows = [...(ov.status?.hosts ?? [])].sort((a, b) => hostRank(a) - hostRank(b) || a.name.localeCompare(b.name));
  const rows = ov.services?.rows ?? [];
  const tasks = ov.collab?.tasks ?? [];
  const live = tasks.filter((t) => ACTIVE.has(t.status) || t.status === "open").sort((a, b) => taskRank(a) - taskRank(b));
  return {
    hosts: {
      up: hostRows.filter((h) => h.online === true).length,
      down: hostRows.filter((h) => h.online === false).length,
      unknown: hostRows.filter((h) => h.online == null).length,
      rows: hostRows,
    },
    services: ov.services
      ? { up: rows.filter((r) => r.ok === true).length, down: rows.filter((r) => r.ok === false), unknown: rows.filter((r) => r.ok == null), total: rows.length, probedAt: ov.services.probedAt }
      : null,
    agents: { active: live, open: tasks.filter((t) => t.status === "open").length, runs: (ov.collab?.runs ?? []).slice(0, 6), auto: ov.collab?.auto ?? false },
    handoffOpen: ov.status?.handoffOpen ?? null,
  };
}

/** The tab's chip count: what needs a look (down hosts, down services, live tasks). */
export function glanceBadge(g: Glance, tab: GlanceTab): { n: number; tone: "bad" | "warn" | "ok" } {
  if (tab === "fleet") return g.hosts.down ? { n: g.hosts.down, tone: "bad" } : { n: g.hosts.up, tone: "ok" };
  if (tab === "services") return !g.services ? { n: 0, tone: "warn" } : g.services.down.length ? { n: g.services.down.length, tone: "bad" } : { n: g.services.up, tone: "ok" };
  const busy = g.agents.active.filter((t) => t.status !== "open").length;
  return busy ? { n: busy, tone: "warn" } : { n: g.agents.open, tone: "ok" };
}

/** Something to say to the agent about what the tab shows: the TALK button's natural next question. */
export function glanceAsk(g: Glance, tab: GlanceTab): string {
  if (tab === "fleet") {
    const down = g.hosts.rows.filter((h) => h.online === false).map((h) => h.name);
    return down.length ? `Why is ${down.join(" and ")} down?` : "How is the fleet doing?";
  }
  if (tab === "services") {
    const d = g.services?.down ?? [];
    return d.length ? `What is wrong with ${d[0].service} on ${d[0].host}?` : "Are all the services healthy?";
  }
  const t = g.agents.active.find((x) => x.status !== "open") ?? g.agents.active[0];
  return t ? `What is the status of ${t.id}, ${t.title}?` : "What are the agents working on?";
}
