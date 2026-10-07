// Shared types + helpers for the control views (fed by /api/control/*).
export type HostStatus = { name: string; kind: string; os: string; ssh?: string | null; roles: string[]; online: boolean | null; cyberdeck: { version: string; repos: number; atRisk: number; attention: number; lastScanAt: number | null } | null; note?: string };
export type FleetStatus = { host: string; time: string; hosts: HostStatus[]; repo: { branch: string; dirty: number; ahead: number; behind: number }; handoffOpen: number; sessionsIndexed: number };
export type Project = { slug: string; name: string; status: string; depth: number; parent: string | null; repos: string[]; hosts: string[]; services?: string[]; links: string[]; body: string; file: string };
export type Session = { host: string; tool: "cc" | "cx"; id: string; title: string; cwd: string; project?: string; branch?: string; started: string; updated: string; file: string; messages?: number };
export type ServiceRow = { host: string; service: string; type: string; state: string; ok: boolean | null; error?: string };
export type ServiceProbe = { probedAt: string | null; rows: ServiceRow[] };
export type TodoEntry = { date: string; text: string };
export type Todo = { sections: { title: string; entries: TodoEntry[] }[] };
export type Handoff = { file: string; host: string; agent: string; text: string };
export type Task = { id: string; title: string; project: string; host: string; worker: "cx" | "cc"; reviewer: "cx" | "cc"; status: string; created: string; body: string };
export type Run = { id: string; task: string; title: string; host: string; startedAt: string; finishedAt: string | null; status: string; step: string; verdict: string | null; dir: string };
export type Overview = { fleetDir: string; status: FleetStatus | null; projects: Project[]; todo: Todo; handoff: Handoff[]; collab: { tasks: Task[]; runs: Run[]; auto: boolean }; services: ServiceProbe | null };

export const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400",
  running: "bg-sky-500/15 text-sky-400",
  review: "bg-amber-500/15 text-amber-400",
  open: "bg-zinc-700/60 text-zinc-300",
  paused: "bg-zinc-700/60 text-zinc-400",
  maintenance: "bg-amber-500/15 text-amber-400",
  idea: "bg-violet-500/15 text-violet-300",
  done: "bg-emerald-500/15 text-emerald-400",
  blocked: "bg-red-500/15 text-red-400",
  failed: "bg-red-500/15 text-red-400",
};
export const pill = (s: string) => STATUS_PILL[s] ?? "bg-zinc-800 text-zinc-400";

export function isoAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!t) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${s | 0}s ago`;
  if (s < 5400) return `${(s / 60) | 0}m ago`;
  if (s < 172800) return `${(s / 3600) | 0}h ago`;
  return `${(s / 86400) | 0}d ago`;
}

export function duration(a: string, b: string | null): string {
  const s = Math.max(0, ((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
  return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m ${(s % 60) | 0}s` : `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m`;
}

/** Repo glob (relative to ~/Code, `*` = one path segment) → does it cover this repo path? */
export function globMatches(glob: string, repoPath: string): boolean {
  const rel = repoPath.replace(/^.*\/Code\//, "");
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "(/|$)");
  return re.test(rel);
}

/** Service pattern `host/name` from a project's `services:` (`*` = one segment) → does it cover this probe row? */
export function serviceMatches(pattern: string, row: { host: string; service: string }): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
  return re.test(`${row.host}/${row.service}`);
}
/** Projects that declare this service (parents included when a subproject declares it). */
export function projectsForService(row: { host: string; service: string }, projects: Project[]): Project[] {
  return projects.filter((p) => (p.services ?? []).some((g) => serviceMatches(g, row)));
}
/** Probe rows that belong to a project or any of its subprojects. */
export function servicesForProject(p: Project, projects: Project[], rows: ServiceRow[]): ServiceRow[] {
  const mine = projects.filter((x) => x.slug === p.slug || x.slug.startsWith(p.slug + "/"));
  return rows.filter((r) => mine.some((x) => (x.services ?? []).some((g) => serviceMatches(g, r))));
}
/** Projects whose `hosts:` list this host. */
export const projectsOnHost = (host: string, projects: Project[]) => projects.filter((p) => p.hosts.some((h) => h.toLowerCase() === host.toLowerCase()));

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Shell command that shows a service's recent logs and follows them, run on the service's host. null when the type has no logs (http probes). */
export function serviceLogCmd(row: { service: string; type: string }): string | null {
  const n = q(row.service);
  switch (row.type) {
    case "systemd": return `journalctl -u ${n} -n 200 -f || sudo journalctl -u ${n} -n 200 -f`;
    case "systemd-timer": return `systemctl list-timers ${n}; journalctl -u ${q(row.service.replace(/\.timer$/, ""))} -n 200 || sudo journalctl -u ${q(row.service.replace(/\.timer$/, ""))} -n 200`;
    case "systemd-user": return `journalctl --user -u ${n} -n 200 -f`;
    case "launchd": return `launchctl print gui/$(id -u)/${n} | head -40; p=$(launchctl print gui/$(id -u)/${n} | awk '/(stdout|stderr) path = /{print $NF}' | sort -u); [ -n "$p" ] && tail -n 100 -f $p`;
    case "docker": return `docker logs -n 200 -f ${n} 2>&1 || sudo -n docker logs -n 200 -f ${n}`;
    default: return null;
  }
}
/** Shell command that restarts a service, run on its host. null for types that cannot be restarted this way. */
export function serviceRestartCmd(row: { service: string; type: string }): string | null {
  const n = q(row.service);
  switch (row.type) {
    case "systemd": case "systemd-timer": return `sudo systemctl restart ${n} && systemctl status ${n} --no-pager | head -20`;
    case "systemd-user": return `systemctl --user restart ${n} && systemctl --user status ${n} --no-pager | head -20`;
    case "launchd": return `launchctl kickstart -k gui/$(id -u)/${n} && launchctl print gui/$(id -u)/${n} | head -20`;
    case "docker": return `docker restart ${n} || sudo -n docker restart ${n}`;
    default: return null;
  }
}
/** A project link that is a shell command rather than a URL ("ssh root@host", "ssh agent.hm (containers ...)"). */
export function linkCommand(link: string): string | null {
  const m = link.match(/^((?:ssh|mosh)\s+\S+)/);
  return m ? m[1] : null;
}
/** The handoff file for a status row ("handoff/starlight-cc.md" or absolute) as a path on the fleet checkout. */
export const fleetPath = (fleetDir: string, file: string) => (file.startsWith("/") ? file : `${fleetDir}/${file}`);
export const homePath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");

/** Tiny markdown renderer: headings, bullets, code, links, inline code/bold. Returns React nodes via a parser into blocks. */
export type MdBlock = { kind: "h" | "p" | "li" | "code"; level?: number; text: string };
export function parseMd(src: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = src.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push({ kind: "code", text: buf.join("\n") });
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push({ kind: "h", level: h[1].length, text: h[2] }); i++; continue; }
    const li = l.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      let text = li[1];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*[-*]\s/.test(lines[i + 1])) text += " " + lines[++i].trim();
      out.push({ kind: "li", text });
      i++;
      continue;
    }
    if (l.trim() === "") { i++; continue; }
    let text = l;
    while (i + 1 < lines.length && lines[i + 1].trim() !== "" && !/^(#{1,4}\s|\s*[-*]\s|```)/.test(lines[i + 1])) text += " " + lines[++i].trim();
    out.push({ kind: "p", text });
    i++;
  }
  return out;
}
