import { useEffect, useMemo, useState } from "react";
import { api, navigate, activeNode, activeNodeName, fmtAgo, ApiError } from "../lib/api";
import { type Overview, type Project, type Session, pill, isoAgo, globMatches } from "../lib/control";
import { Markdown } from "./Markdown";

type Repo = { id: number; path: string; name: string; head_branch: string | null; dirty_files: number; untracked_files: number; stashes: number; ahead: number; risk: string; last_commit_at: number | null };

export function Projects({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const selected = params.get("p") ?? "";

  const load = async () => {
    try {
      const [o, r] = await Promise.all([api<Overview>("/api/control/overview"), api<Repo[]>("/api/repos")]);
      setOv(o);
      setRepos(r);
      setErr(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      else setErr(e instanceof ApiError && e.status === 404 ? "No fleet dir configured on this node (set fleetDir in ~/.steward/config.json)." : String(e instanceof Error ? e.message : e));
    }
  };
  useEffect(() => {
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    api<Session[]>("/api/control/sessions").then(setSessions).catch(() => {});
  }, [ov?.fleetDir]);

  const projects = ov?.projects ?? [];
  const current: Project | undefined = projects.find((p) => p.slug === selected) ?? projects[0];
  const children = useMemo(() => (current ? projects.filter((p) => p.parent === current.slug) : []), [projects, current]);
  const projRepos = useMemo(() => (current ? repos.filter((r) => current.repos.some((g) => globMatches(g, r.path))) : []), [repos, current]);
  const needles = useMemo(() => (current ? [current.name, ...current.repos.map((r) => r.replace(/[/*].*$/, ""))].filter((n) => n.length > 2).map((n) => n.toLowerCase()) : []), [current]);
  const handoffHits = useMemo(() => (ov?.todo.sections ?? []).flatMap((s) => s.entries).filter((e) => needles.some((n) => e.text.toLowerCase().includes(n))), [ov, needles]);
  const projSessions = useMemo(() => (current ? sessions.filter((s) => s.project === current.slug || (current.slug && s.project?.startsWith(current.slug + "/"))) : []), [sessions, current]);
  const projTasks = useMemo(() => (current ? (ov?.collab.tasks ?? []).filter((t) => t.project === current.slug || t.project?.startsWith(current.slug + "/")) : []), [ov, current]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <header>
          <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">Projects{activeNode() ? ` on ${activeNodeName()}` : ""}</h1>
          <p className="text-xs text-zinc-500">{ov ? `${projects.length} projects · ${ov.status?.handoffOpen ?? "?"} open handoff entries · fleet repo ${ov.status?.repo.branch ?? ""}${ov.status?.repo.dirty ? ` (${ov.status.repo.dirty} dirty)` : ""}` : err ?? "loading…"}</p>
        </header>
        {err && !ov && <div className="mt-6 hud-card p-6 text-sm text-zinc-400">{err}</div>}
        {ov && (
          <div className="mt-5 grid gap-4 md:grid-cols-[260px_1fr]">
            <nav className="hud-card p-2" data-testid="project-tree">
              {projects.map((p) => (
                <button
                  key={p.slug}
                  onClick={() => navigate("projects", { p: p.slug })}
                  className={`hud-row flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] ${current?.slug === p.slug ? "bg-sky-500/10 text-zinc-100 shadow-[inset_2px_0_0_#22d3ee]" : "text-zinc-300"}`}
                  style={{ paddingLeft: 8 + p.depth * 14 }}
                >
                  <span className="truncate">{p.name}</span>
                  <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${pill(p.status)}`}>{p.status}</span>
                </button>
              ))}
              {projects.length === 0 && <div className="p-3 text-[12px] text-zinc-500">No projects yet. Add folders under projects/ in the fleet repo.</div>}
            </nav>

            {current && (
              <section className="min-w-0 space-y-4">
                <div className="hud-card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="neon-magenta text-base font-semibold uppercase tracking-[0.12em]">{current.name}</h2>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${pill(current.status)}`}>{current.status}</span>
                    {current.hosts.map((h) => <span key={h} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{h}</span>)}
                    <span className="ml-auto font-mono text-[10px] text-zinc-600">{current.slug}</span>
                  </div>
                  <Markdown text={current.body} className="mt-3" />
                  {current.links.length > 0 && (
                    <div className="mt-3 space-y-0.5">
                      {current.links.map((l, i) => (
                        <div key={i} className="truncate text-[11px] text-zinc-400">{/^https?:\/\//.test(l) ? <a href={l} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">{l}</a> : l}</div>
                      ))}
                    </div>
                  )}
                  {children.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {children.map((c) => (
                        <button key={c.slug} onClick={() => navigate("projects", { p: c.slug })} className="rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800">
                          {c.name} <span className={`ml-1 rounded px-1 text-[9px] ${pill(c.status)}`}>{c.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <Panel title={`Repos on this machine (${projRepos.length})`}>
                  {projRepos.length === 0 && <Empty>No checkouts matching {current.repos.join(", ") || "(no repos listed)"} here.</Empty>}
                  {projRepos.map((r) => (
                    <Row key={r.id}>
                      <span className="w-52 truncate font-mono text-[11px] text-zinc-200">{r.path.replace(/^.*\/Code\//, "")}</span>
                      <span className="w-40 truncate text-[11px] text-zinc-400">{r.head_branch ?? "detached"}</span>
                      <span className="text-[11px] text-zinc-500">{r.dirty_files ? `${r.dirty_files} modified · ` : ""}{r.untracked_files ? `${r.untracked_files} untracked · ` : ""}{r.ahead ? `${r.ahead} local-only · ` : ""}{r.stashes ? `${r.stashes} stashes · ` : ""}{fmtAgo(r.last_commit_at)}</span>
                      <span className={`ml-auto rounded px-1.5 py-0.5 text-[9px] uppercase ${r.risk === "safe" ? "bg-emerald-500/15 text-emerald-400" : r.risk === "attention" ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400"}`}>{r.risk}</span>
                    </Row>
                  ))}
                </Panel>

                <Panel title={`Handoff entries (${handoffHits.length})`}>
                  {handoffHits.length === 0 && <Empty>Nothing in the handoff mentions this project.</Empty>}
                  {handoffHits.slice(0, 20).map((e, i) => (
                    <div key={i} className="border-b border-zinc-800/60 py-1.5 last:border-0"><span className="mr-2 font-mono text-[10px] text-zinc-500">{e.date}</span><Markdown text={e.text} className="inline" /></div>
                  ))}
                </Panel>

                <Panel title={`Collab tasks (${projTasks.length})`}>
                  {projTasks.length === 0 && <Empty>No tasks. Add one on the Agents page.</Empty>}
                  {projTasks.map((t) => (
                    <Row key={t.id}>
                      <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${pill(t.status)}`}>{t.status}</span>
                      <span className="truncate text-[12px] text-zinc-200">{t.title}</span>
                      <span className="ml-auto text-[10px] text-zinc-500">{t.host} · {t.worker}→{t.reviewer}</span>
                    </Row>
                  ))}
                  <button onClick={() => navigate("agents")} className="mt-2 text-[11px] text-sky-400 hover:underline">Open Agents →</button>
                </Panel>

                <Panel title={`Sessions (${projSessions.length})`}>
                  {projSessions.length === 0 && <Empty>No indexed sessions for this project.</Empty>}
                  {projSessions.slice(0, 15).map((s) => (
                    <Row key={`${s.host}-${s.id}`}>
                      <span className="w-16 text-[11px] text-zinc-400">{s.host}</span>
                      <span className={`rounded px-1 text-[10px] ${s.tool === "cc" ? "bg-orange-500/15 text-orange-300" : "bg-sky-500/15 text-sky-300"}`}>{s.tool}</span>
                      <span className="w-14 text-[10px] text-zinc-500">{isoAgo(s.updated)}</span>
                      <span className="truncate text-[12px] text-zinc-200" title={s.title}>{s.title}</span>
                      <span className="ml-auto hidden truncate font-mono text-[10px] text-zinc-600 sm:inline">{s.cwd.replace(/^\/(Users|home)\/[^/]+/, "~")}</span>
                    </Row>
                  ))}
                </Panel>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="hud-card p-4">
      <div className="flex items-center justify-between"><h3 className="hud-label neon">{title}</h3>{right}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
export const Row = ({ children, onClick, active }: { children: React.ReactNode; onClick?: () => void; active?: boolean }) => (
  <div onClick={onClick} className={`hud-row flex items-center gap-2 border-b border-zinc-800/60 px-1 py-1.5 last:border-0 ${onClick ? "cursor-pointer" : ""} ${active ? "bg-sky-500/10 shadow-[inset_2px_0_0_#22d3ee]" : ""}`}>{children}</div>
);
export const Empty = ({ children }: { children: React.ReactNode }) => <div className="py-2 text-[11px] text-zinc-500">{children}</div>;
