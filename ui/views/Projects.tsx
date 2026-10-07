import { useEffect, useMemo, useState } from "react";
import { api, navigate, activeNode, activeNodeName, fmtAgo, ApiError } from "../lib/api";
import { type Overview, type Project, type Session, type ServiceRow, pill, isoAgo, globMatches, servicesForProject, serviceLogCmd, linkCommand, fleetPath, homePath } from "../lib/control";
import { openTerminal, launchCmd, resumeCmd } from "../lib/terms";
import { useFleetNodes, openOnHost } from "../lib/hosts";
import { Markdown } from "./Markdown";

const UNASSIGNED = "_repos";

type Repo = { id: number; path: string; name: string; head_branch: string | null; dirty_files: number; untracked_files: number; stashes: number; ahead: number; risk: string; last_commit_at: number | null };

export function Projects({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const nodes = useFleetNodes();
  const [repoQ, setRepoQ] = useState("");
  const selected = params.get("p") ?? "";

  const load = async () => {
    try {
      const [o, r] = await Promise.all([api<Overview>("/api/control/overview"), api<Repo[]>("/api/repos")]);
      setOv(o);
      setRepos(r);
      setErr(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      else setErr(e instanceof ApiError && e.status === 404 ? "No fleet dir configured on this node (set fleetDir in ~/.cyberdeck/config.json)." : String(e instanceof Error ? e.message : e));
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
  const showUnassigned = selected === UNASSIGNED;
  const current: Project | undefined = showUnassigned ? undefined : projects.find((p) => p.slug === selected) ?? projects[0];
  const parent = useMemo(() => (current?.parent ? projects.find((p) => p.slug === current.parent) : undefined), [projects, current]);
  // Every indexed checkout that no project claims: the long tail Eric still thinks of as projects.
  const unassigned = useMemo(() => repos.filter((r) => !projects.some((p) => p.repos.some((g) => globMatches(g, r.path)))).sort((a, b) => (b.last_commit_at ?? 0) - (a.last_commit_at ?? 0)), [repos, projects]);
  const unassignedShown = useMemo(() => { const q = repoQ.trim().toLowerCase(); return q ? unassigned.filter((r) => r.path.toLowerCase().includes(q)) : unassigned; }, [unassigned, repoQ]);
  const children = useMemo(() => (current ? projects.filter((p) => p.parent === current.slug) : []), [projects, current]);
  const projRepos = useMemo(() => (current ? repos.filter((r) => current.repos.some((g) => globMatches(g, r.path))) : []), [repos, current]);
  const needles = useMemo(() => (current ? [current.name, ...current.repos.map((r) => r.replace(/[/*].*$/, ""))].filter((n) => n.length > 2).map((n) => n.toLowerCase()) : []), [current]);
  const handoffHits = useMemo(() => (ov?.todo.sections ?? []).flatMap((s) => s.entries).filter((e) => needles.some((n) => e.text.toLowerCase().includes(n))), [ov, needles]);
  const projSessions = useMemo(() => (current ? sessions.filter((s) => s.project === current.slug || (current.slug && s.project?.startsWith(current.slug + "/"))) : []), [sessions, current]);
  const projTasks = useMemo(() => (current ? (ov?.collab.tasks ?? []).filter((t) => t.project === current.slug || t.project?.startsWith(current.slug + "/")) : []), [ov, current]);
  const projServices = useMemo(() => (current ? servicesForProject(current, projects, ov?.services?.rows ?? []) : []), [ov, projects, current]);
  const declaredServices = useMemo(() => (current ? projects.filter((x) => x.slug === current.slug || x.slug.startsWith(current.slug + "/")).flatMap((x) => x.services ?? []) : []), [projects, current]);
  const projRuns = useMemo(() => (ov?.collab.runs ?? []).filter((r) => projTasks.some((t) => t.id === r.task)), [ov, projTasks]);

  const me = ov?.status?.host ?? "";
  const hosts = ov?.status?.hosts ?? [];
  const hostStatus = (name: string) => hosts.find((h) => h.name.toLowerCase() === name.toLowerCase());
  const onHost = (host: string, cmd: string | undefined, title: string, cwd?: string) => {
    const e = openOnHost({ host, me, hosts, nodes, cmd, cwd, title });
    if (e) setMsg(e);
  };
  const edit = (path: string) => navigate("edit", { path });

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">Projects{activeNode() ? ` on ${activeNodeName()}` : ""}</h1>
            <p className="text-xs text-zinc-500">
              {ov ? (
                <>
                  {projects.length} projects · <button className="hover:text-zinc-300 hover:underline" onClick={() => ov.fleetDir && edit(`${ov.fleetDir}/handoff/TODO.md`)}>{ov.status?.handoffOpen ?? "?"} open handoff entries</button> · fleet repo {ov.status?.repo.branch ?? ""}{ov.status?.repo.dirty ? ` (${ov.status.repo.dirty} dirty)` : ""}
                </>
              ) : err ?? "loading…"}
            </p>
          </div>
          {msg && <span className="text-[11px] text-amber-400/90" data-testid="projects-msg">{msg}</span>}
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
              {ov.fleetDir && <button onClick={() => navigate("files", { path: `${ov.fleetDir}/projects` })} className="mt-1 w-full px-2 py-1 text-left text-[10px] text-zinc-600 hover:text-sky-400">browse projects/ →</button>}
              <button
                onClick={() => navigate("projects", { p: UNASSIGNED })}
                data-testid="project-unassigned"
                className={`hud-row mt-1 flex w-full items-center gap-2 rounded-sm border-t border-zinc-800/60 px-2 py-1.5 text-left text-[12px] ${showUnassigned ? "bg-sky-500/10 text-zinc-100 shadow-[inset_2px_0_0_#22d3ee]" : "text-zinc-400"}`}
                title="checkouts on this machine that no project claims"
              >
                <span className="truncate">Unassigned repos</span>
                <span className="ml-auto shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-zinc-400">{unassigned.length}</span>
              </button>
            </nav>

            {showUnassigned && (
              <section className="min-w-0 space-y-4">
                <Panel
                  title={`Unassigned repos on ${activeNode() ? activeNodeName() : ov.status?.host ?? "this machine"} (${unassignedShown.length}${repoQ ? ` of ${unassigned.length}` : ""})`}
                  right={<input value={repoQ} onChange={(e) => setRepoQ(e.target.value)} placeholder="filter" data-testid="unassigned-filter" className="w-40 rounded-sm border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-sky-500/60" />}
                >
                  <p className="pb-2 text-[11px] text-zinc-500">Every git checkout the daemon indexed here that no Deck project lists in its <span className="font-mono">repos</span>. Add a project file under <span className="font-mono">Deck/projects/</span> to claim one; or just start a session in it.</p>
                  {unassignedShown.length === 0 && <Empty>{repos.length ? "Everything here belongs to a project." : "No repos indexed yet."}</Empty>}
                  {unassignedShown.slice(0, 300).map((r) => (
                    <Row key={r.id}>
                      <span className="w-56 truncate font-mono text-[11px] text-zinc-200" title={r.path}>{r.path.replace(/^.*\/Code\//, "")}</span>
                      <span className="hidden w-32 truncate text-[11px] text-zinc-400 sm:inline">{r.head_branch ?? "detached"}</span>
                      <span className="hidden min-w-0 flex-1 truncate text-[11px] text-zinc-500 md:inline">{r.dirty_files ? `${r.dirty_files} modified · ` : ""}{r.untracked_files ? `${r.untracked_files} untracked · ` : ""}{r.ahead ? `${r.ahead} local-only · ` : ""}{fmtAgo(r.last_commit_at)}</span>
                      <span className={`ml-auto rounded px-1.5 py-0.5 text-[9px] uppercase ${r.risk === "safe" ? "bg-emerald-500/15 text-emerald-400" : r.risk === "attention" ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400"}`}>{r.risk}</span>
                      <button onClick={() => openTerminal({ cwd: r.path, title: `sh ${r.path.split("/").pop()}` })} className="shrink-0 rounded border border-sky-500/30 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/10" title="open a shell session here">Session</button>
                    </Row>
                  ))}
                  {unassignedShown.length > 300 && <div className="pt-2 text-[10px] text-zinc-600">showing 300; narrow the filter</div>}
                </Panel>
              </section>
            )}

            {current && (
              <section className="min-w-0 space-y-4">
                <div className="hud-card p-4">
                  {parent && (
                    <button onClick={() => navigate("projects", { p: parent.slug })} className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-sky-400">↑ {parent.name}</button>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="neon-magenta text-base font-semibold uppercase tracking-[0.12em]">{current.name}</h2>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${pill(current.status)}`}>{current.status}</span>
                    {current.hosts.map((h) => {
                      const st = hostStatus(h);
                      return (
                        <button key={h} onClick={() => navigate("services", { host: h })} title={`services on ${h}`} className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100" data-testid={`host-chip-${h}`}>
                          <span className={`led ${st?.online === true ? "led-on" : st?.online === false ? "led-err" : "led-off"}`} />
                          {h}
                        </button>
                      );
                    })}
                    <button onClick={() => edit(current.file)} className="ml-auto font-mono text-[10px] text-zinc-600 hover:text-sky-400" title="edit this project's index.md">{current.slug} ✎</button>
                  </div>
                  <Markdown text={current.body} className="mt-3" />
                  {current.links.length > 0 && (
                    <div className="mt-3 space-y-0.5">
                      {current.links.map((l, i) => {
                        const cmd = linkCommand(l);
                        return (
                          <div key={i} className="truncate text-[11px] text-zinc-400">
                            {/^https?:\/\//.test(l) ? (
                              <a href={l} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">{l}</a>
                            ) : cmd ? (
                              <button onClick={() => openTerminal({ node: activeNode(), cwd: "", cmd, title: cmd.replace(/^\S+\s+/, "") })} className="text-sky-400 hover:underline" title="open in a terminal">
                                <span className="font-mono">{cmd}</span>{l.slice(cmd.length)}
                              </button>
                            ) : l}
                          </div>
                        );
                      })}
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

                <Panel title={`Repos on this machine (${projRepos.length})`} right={<button onClick={() => navigate("data")} className="text-[10px] text-zinc-500 hover:text-sky-400">all repos →</button>}>
                  {projRepos.length === 0 && <Empty>No checkouts matching {current.repos.join(", ") || "(no repos listed)"} here.</Empty>}
                  {projRepos.map((r) => (
                    <Row key={r.id} onClick={() => navigate("files", { path: r.path })}>
                      <span className="w-52 truncate font-mono text-[11px] text-zinc-200">{r.path.replace(/^.*\/Code\//, "")}</span>
                      <span className="w-40 truncate text-[11px] text-zinc-400">{r.head_branch ?? "detached"}</span>
                      <span className="hidden text-[11px] text-zinc-500 sm:inline">{r.dirty_files ? `${r.dirty_files} modified · ` : ""}{r.untracked_files ? `${r.untracked_files} untracked · ` : ""}{r.ahead ? `${r.ahead} local-only · ` : ""}{r.stashes ? `${r.stashes} stashes · ` : ""}{fmtAgo(r.last_commit_at)}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        <Action onClick={() => openTerminal({ node: activeNode(), cwd: r.path, title: r.name })} title="shell here">$</Action>
                        <Action onClick={() => openTerminal({ node: activeNode(), cwd: r.path, cmd: launchCmd("cc"), title: `cc ${r.name}` })} title="start Claude Code here" tone="orange">cc</Action>
                        <Action onClick={() => openTerminal({ node: activeNode(), cwd: r.path, cmd: launchCmd("cx"), title: `cx ${r.name}` })} title="start Codex here" tone="sky">cx</Action>
                        <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${r.risk === "safe" ? "bg-emerald-500/15 text-emerald-400" : r.risk === "attention" ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400"}`}>{r.risk}</span>
                      </span>
                    </Row>
                  ))}
                </Panel>

                <Panel title={`Services (${projServices.length})`} right={<button onClick={() => navigate("services")} className="text-[10px] text-zinc-500 hover:text-sky-400">all services →</button>}>
                  {projServices.length === 0 && (
                    <Empty>
                      {declaredServices.length === 0 ? (
                        <>No services declared. Add <code className="text-zinc-400">services: [host/name]</code> to <button onClick={() => edit(current.file)} className="text-sky-400 hover:underline">{current.slug}/index.md</button>.</>
                      ) : ov.services ? `Nothing in the last probe matches ${declaredServices.join(", ")}.` : "Not probed yet."}
                    </Empty>
                  )}
                  {projServices.map((r) => (
                    <ServiceLine key={`${r.host}/${r.service}`} row={r} onOpen={() => navigate("services", { host: r.host, svc: r.service })} onLogs={() => { const c = serviceLogCmd(r); if (c) onHost(r.host, c, `${r.service} @ ${r.host}`); }} />
                  ))}
                </Panel>

                <Panel title={`Handoff entries (${handoffHits.length})`} right={ov.fleetDir ? <button onClick={() => edit(`${ov.fleetDir}/handoff/TODO.md`)} className="text-[10px] text-zinc-500 hover:text-sky-400">edit TODO.md →</button> : undefined}>
                  {handoffHits.length === 0 && <Empty>Nothing in the handoff mentions this project.</Empty>}
                  {handoffHits.slice(0, 20).map((e, i) => (
                    <div key={i} onClick={() => ov.fleetDir && edit(`${ov.fleetDir}/handoff/TODO.md`)} className="hud-row cursor-pointer border-b border-zinc-800/60 px-1 py-1.5 last:border-0" title="open TODO.md"><span className="mr-2 font-mono text-[10px] text-zinc-500">{e.date}</span><Markdown text={e.text} className="inline" /></div>
                  ))}
                </Panel>

                <Panel title={`Collab tasks (${projTasks.length})`} right={<button onClick={() => navigate("agents", { project: current.slug })} className="text-[10px] text-zinc-500 hover:text-sky-400">add a task →</button>}>
                  {projTasks.length === 0 && <Empty>No tasks. <button onClick={() => navigate("agents", { project: current.slug })} className="text-sky-400 hover:underline">Add one on the Agents page.</button></Empty>}
                  {projTasks.map((t) => {
                    const run = projRuns.find((r) => r.task === t.id);
                    return (
                      <Row key={t.id} onClick={() => navigate("agents", run ? { task: t.id, run: run.id } : { task: t.id })}>
                        <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${pill(t.status)}`}>{t.status}</span>
                        <span className="truncate text-[12px] text-zinc-200">{t.title}</span>
                        {run && <span className={`led shrink-0 ${run.status === "running" ? "led-run" : run.status === "done" ? "led-on" : "led-err"}`} title={`run ${run.id}: ${run.status}`} />}
                        <span className="ml-auto text-[10px] text-zinc-500"><HostLink host={t.host} /> · {t.worker}→{t.reviewer}</span>
                      </Row>
                    );
                  })}
                </Panel>

                <Panel title={`Sessions (${projSessions.length})`} right={<button onClick={() => navigate("agents", { q: current.slug })} className="text-[10px] text-zinc-500 hover:text-sky-400">search sessions →</button>}>
                  {projSessions.length === 0 && <Empty>No indexed sessions for this project.</Empty>}
                  {projSessions.slice(0, 15).map((s) => (
                    <Row key={`${s.host}-${s.id}`} onClick={() => onHost(s.host, resumeCmd(s.tool, s.id), `${s.tool} ${s.title.slice(0, 18)}`, s.cwd)}>
                      <span className="w-16 text-[11px] text-zinc-400"><HostLink host={s.host} /></span>
                      <span className={`rounded px-1 text-[10px] ${s.tool === "cc" ? "bg-orange-500/15 text-orange-300" : "bg-sky-500/15 text-sky-300"}`}>{s.tool}</span>
                      <span className="w-14 text-[10px] text-zinc-500">{isoAgo(s.updated)}</span>
                      <span className="truncate text-[12px] text-zinc-200" title={s.title}>{s.title}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        {s.host.toLowerCase() === me.toLowerCase() ? (
                          <button onClick={(e) => { e.stopPropagation(); navigate("files", { path: s.cwd }); }} className="hidden truncate font-mono text-[10px] text-zinc-600 hover:text-sky-400 sm:inline" title="browse this directory">{homePath(s.cwd)}</button>
                        ) : <span className="hidden truncate font-mono text-[10px] text-zinc-600 sm:inline">{homePath(s.cwd)}</span>}
                        <Action title={`resume in a terminal on ${s.host}`} tone="sky">resume</Action>
                      </span>
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

/** One probed service: LED, host, name, state. The row opens it on the Services page; the button tails its logs. */
export function ServiceLine({ row, onOpen, onLogs, onRestart, active, projects }: { row: ServiceRow; onOpen?: () => void; onLogs?: () => void; onRestart?: () => void; active?: boolean; projects?: { slug: string; name: string }[] }) {
  const logs = serviceLogCmd(row);
  return (
    <Row onClick={onOpen} active={active}>
      <span className={`led shrink-0 ${row.ok === true ? "led-on" : row.ok === false ? "led-err" : "led-off"}`} />
      {onOpen && <span className="w-16 shrink-0 text-[11px] text-zinc-400">{row.host}</span>}
      <span className="w-64 truncate font-mono text-[11px] text-zinc-200">{row.service}</span>
      <span className="hidden w-24 text-[10px] text-zinc-500 sm:inline">{row.type}</span>
      <span className={`hud-badge ${row.ok === true ? "neon-green" : row.ok === false ? "neon-red" : "text-zinc-500"}`}>{row.ok === true ? "online" : row.ok === false ? "down" : row.state || "unknown"}</span>
      {projects?.map((p) => (
        <button key={p.slug} onClick={(e) => { e.stopPropagation(); navigate("projects", { p: p.slug }); }} className="hidden rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300 hover:bg-violet-500/20 md:inline" title="open project" data-testid={`svc-project-${p.slug}`}>{p.name}</button>
      ))}
      {row.error && <span className="ml-auto hidden truncate text-[10px] text-zinc-500 lg:inline" title={row.error}>{row.error}</span>}
      <span className={`${row.error ? "" : "ml-auto"} flex shrink-0 items-center gap-1`}>
        {onLogs && logs && <Action onClick={onLogs} title="tail the logs in a terminal on its host">logs</Action>}
        {onRestart && <Action onClick={onRestart} title="restart in a terminal on its host" tone="amber">restart</Action>}
      </span>
    </Row>
  );
}

/** A host name that opens the Services page scrolled to that host. */
export const HostLink = ({ host }: { host: string }) => (
  <button onClick={(e) => { e.stopPropagation(); navigate("services", { host }); }} className="hover:text-sky-400 hover:underline" title={`services on ${host}`}>{host}</button>
);

const TONES = { zinc: "border-zinc-700 text-zinc-300 hover:bg-zinc-800", sky: "border-sky-500/30 text-sky-300 hover:bg-sky-500/10", orange: "border-orange-500/30 text-orange-300 hover:bg-orange-500/10", amber: "border-amber-500/30 text-amber-300 hover:bg-amber-500/10" };
/** Small inline action button; stops the row click. */
export const Action = ({ children, onClick, title, tone = "zinc", disabled }: { children: React.ReactNode; onClick?: () => void; title?: string; tone?: keyof typeof TONES; disabled?: boolean }) => (
  <button onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined} title={title} disabled={disabled} className={`shrink-0 rounded border px-2 py-0.5 text-[10px] disabled:opacity-40 ${TONES[tone]}`}>{children}</button>
);

export function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="hud-card p-4">
      <div className="flex items-center justify-between"><h3 className="hud-label neon">{title}</h3>{right}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
export const Row = ({ children, onClick, active, id }: { children: React.ReactNode; onClick?: () => void; active?: boolean; id?: string }) => (
  <div id={id} onClick={onClick} className={`hud-row flex items-center gap-2 border-b border-zinc-800/60 px-1 py-1.5 last:border-0 ${onClick ? "cursor-pointer" : ""} ${active ? "bg-sky-500/10 shadow-[inset_2px_0_0_#22d3ee]" : ""}`}>{children}</div>
);
export const Empty = ({ children }: { children: React.ReactNode }) => <div className="py-2 text-[11px] text-zinc-500">{children}</div>;
