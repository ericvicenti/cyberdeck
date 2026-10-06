// Shared types + helpers for the control views (fed by /api/control/*).
export type HostStatus = { name: string; kind: string; os: string; roles: string[]; online: boolean | null; steward: { version: string; repos: number; atRisk: number; attention: number; lastScanAt: number | null } | null; note?: string };
export type FleetStatus = { host: string; time: string; hosts: HostStatus[]; repo: { branch: string; dirty: number; ahead: number; behind: number }; handoffOpen: number; sessionsIndexed: number };
export type Project = { slug: string; name: string; status: string; depth: number; parent: string | null; repos: string[]; hosts: string[]; links: string[]; body: string; file: string };
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
