import { routeHash, updateParams, useRouteTitle } from "../lib/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiOn, postOn, wsUrl, navigate, ApiError } from "../lib/api";
import { openTerminal, launchCmd, resumeCmd, shq } from "../lib/terms";
import { type Session, type Run, type Task, pill, isoAgo, duration, fleetPath, homePath } from "../lib/control";
import { useHostTargets, openOnHost, resolveHost } from "../lib/hosts";
import { useFleet, useOverview, projectDirs } from "../lib/fleet";
import { NodePicker } from "../components/NodePicker";
import { Markdown } from "./Markdown";
import { Panel, Row, Empty, HostLink, Action } from "./Projects";

type Collab = { tasks: Task[]; runs: Run[]; auto: boolean; intervalMinutes?: number };
const LOGS = ["worker.log", "reviewer.log", "result.md"] as const;

/** Collaboration between cc and cx across the fleet. The queue, the handoff and the session index are
 *  Deck data (read from this node, or from a peer when this node has no checkout). A task runs on the
 *  host it names, so Run goes to that machine; the runner here ("Run next task", auto) is this node's. */
export function Agents({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const { overview: ov, source, error: err, refresh } = useOverview(onLocked, 20_000);
  const { targets } = useFleet();
  const deckNode = source?.node ?? "";
  const deckName = source?.node ? source.nodeName : (targets[0]?.name ?? "this machine");
  const [collab, setCollab] = useState<Collab | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const showHandoff = params.get("handoff") === "1";
  const runId = params.get("run") ?? "";
  const setRunId = (run: string) => updateParams({ run });
  const focusTask = params.get("task") ?? "";
  const logFile = LOGS.find(f => f === params.get("log")) ?? "worker.log";
  const setLogFile = (log: string) => updateParams({ log: log === "worker.log" ? null : log });
  const [logResult, setLogResult] = useState({ key: "", text: "", size: 0, error: "" });
  const routeKey = routeHash("agents", params);
  useEffect(() => {
    const raw = params.get("log");
    if (location.hash === routeKey && raw !== null && (raw === "worker.log" || !LOGS.some(file => file === raw))) updateParams({ log: null }, "replace");
  }, [routeKey]);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  // sessions
  const q = params.get("q") ?? "", host = params.get("host") ?? "", tool = params.get("tool") ?? "";
  const setQ = (q: string) => updateParams({ q }, "edit");
  const setHost = (host: string) => updateParams({ host });
  const setTool = (tool: string) => updateParams({ tool });
  const sessionsRequest = useRef(0);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  // add task form
  const [form, setForm] = useState({ title: "", project: params.get("project") ?? "", host: "", worker: "cx", body: "" });
  useEffect(() => { setForm(f => ({ ...f, project: params.get("project") ?? "" })); }, [params.get("project")]);
  // launch an agent in a terminal: the machine is picked in the form
  const { me, hosts, nodes } = useHostTargets(ov, source);
  const [launch, setLaunch] = useState({ node: "", cwd: "", tool: "cc" as "cc" | "cx", prompt: "" });
  const home = ov ? ov.fleetDir.replace(/\/Code\/[^/]+$/, "") : "";
  const dirs = useMemo(() => projectDirs(ov), [ov]);
  /** Run a command in a terminal on a fleet host: natively when it is this node or a paired node, else over ssh. */
  const openOn = (hostName: string, cwd: string, cmd: string, title: string) => {
    const e = openOnHost({ host: hostName, me, hosts, nodes, cwd, cmd, title });
    if (e) setMsg(e);
  };
  /** The node that answers for a fleet host: "" here, a paired node id, or null (ssh only / unreachable). */
  const nodeFor = (hostName: string): string | null => { const r = resolveHost({ host: hostName, me, hosts, nodes }); return r.kind === "local" ? "" : r.kind === "node" ? r.id : null; };

  const loadCollab = async () => {
    if (!source) return;
    try { setCollab(await apiOn<Collab>(deckNode, "/api/control/collab")); } catch (e) { if (e instanceof ApiError && e.status === 401) onLocked(); }
  };
  useEffect(() => {
    loadCollab();
    const iv = setInterval(loadCollab, 20_000);
    if (deckNode !== "" || !source) return () => clearInterval(iv);
    const ws = new WebSocket(wsUrl("/api/events"));
    ws.onmessage = (m) => { try { const ev = JSON.parse(m.data); if (ev.kind === "collab" || ev.kind === "services") { refresh(); loadCollab(); } } catch {} };
    return () => { clearInterval(iv); ws.close(); };
  }, [source?.node]);
  const load = () => { refresh(); loadCollab(); };

  const loadSessions = async () => {
    if (!source) return;
    const request = ++sessionsRequest.current;
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (host) p.set("host", host);
    if (tool && tool !== "cloud") p.set("tool", tool);
    let rows: Session[] = [];
    if (tool !== "cloud") { try { rows = await apiOn<Session[]>(deckNode, `/api/control/sessions?${p}`); } catch {} }
    if (!tool || tool === "cloud") {
      // archived cloud conversations (chatgpt / claude.ai) live beside the cc/cx index
      for (const prov of ["chatgpt", "claude"]) { try { const c = await apiOn<Session[]>(deckNode, `/api/cloud/${prov}/conversations?q=${encodeURIComponent(q)}`); rows.push(...c.filter((s) => !host || s.host === host)); } catch {} }
      rows.sort((a, b) => b.updated.localeCompare(a.updated));
    }
    if (request === sessionsRequest.current) setSessions(rows);
  };
  useEffect(() => { const t = setTimeout(loadSessions, 250); return () => { clearTimeout(t); sessionsRequest.current++; }; }, [q, host, tool, ov?.fleetDir, source?.node]);

  const runs = collab?.runs ?? [];
  const run = runId ? runs.find((r) => r.id === runId) : (focusTask ? runs.find(r => r.task === focusTask) : runs[0]);
  const missingTask = collab && focusTask && !collab.tasks.some(t => t.id === focusTask) && !runs.some(r => r.task === focusTask);
  const logKey = `${run?.id || ""}:${logFile}`;
  const log = logResult.key === logKey ? logResult : { key: "", text: "", size: 0, error: "" };
  useEffect(() => { if (location.hash === routeKey && run && !runId) updateParams({ run: run.id }, "replace"); }, [run?.id, runId, routeKey]);
  useRouteTitle(location.hash !== routeKey ? undefined : err && !ov ? "Agents unavailable" : missingTask ? "Task not found · Agents" : collab && runId && !run ? "Run not found · Agents" : run ? `${run.id} · ${log.error || logFile} · Agents` : undefined);
  useEffect(() => {
    if (location.hash !== routeKey || !focusTask || !collab) return;
    const r = runs.find((x) => x.task === focusTask);
    if (r && !params.get("run")) updateParams({ run: r.id }, "replace");
    document.getElementById(`task-${focusTask}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusTask, collab?.tasks.length]);
  // Run logs live in ~/.fleet/runs on the host that ran the task: read them from that machine
  // when it is reachable, else from wherever the Deck was read (which may only have the index).
  const logNode = run ? (nodeFor(run.host) ?? deckNode) : deckNode;
  useEffect(() => {
    if (!run) return;
    let alive = true, request = 0;
    const fetchLog = async () => {
      const current = ++request;
      try { const l = await apiOn<{ text: string; size: number }>(logNode, `/api/control/collab/runs/${run.id}/log?file=${logFile}&tail=60000`); if (alive && current === request) setLogResult({ ...l, key: logKey, error: "" }); } catch (e) { if (alive && current === request) { if (e instanceof ApiError && e.status === 401) onLocked(); setLogResult({ key: logKey, text: "", size: 0, error: e instanceof ApiError && e.status === 404 ? "Log not found" : "Log unavailable" }); } }
    };
    fetchLog();
    const iv = setInterval(fetchLog, run.status === "running" ? 3000 : 30000);
    return () => { alive = false; clearInterval(iv); };
  }, [run?.id, run?.status, logFile, logNode]);
  useEffect(() => { if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log, follow]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setMsg(`${label}…`);
    try { const r: any = await fn(); setMsg(r?.reason ? `${label}: ${r.reason}` : r?.output ? String(r.output).split("\n").pop() ?? label : `${label}: ok`); load(); }
    catch (e) { setMsg(`${label} failed: ${e instanceof Error ? e.message : e}`); }
  };
  /** Start a queued task where it belongs: the daemon on the task's host runs `deck collab run`. */
  const runTask = (t: Task) => {
    const node = nodeFor(t.host);
    if (node !== null) return act(`Run ${t.id} on ${t.host}`, () => postOn(node, "/api/control/collab/run", { id: t.id }));
    const r = resolveHost({ host: t.host, me, hosts, nodes });
    if (r.kind === "ssh") { openOn(t.host, "", `deck collab run ${shq(t.id)}`, `run ${t.id}`); return; }
    setMsg(`Cannot run ${t.id}: ${r.kind === "none" ? r.reason : `${t.host} is not reachable`}`);
  };
  const agentHosts = useMemo(() => (ov?.status?.hosts ?? []).filter((h) => h.roles.includes("agents")).map((h) => h.name), [ov]);
  const sessionHosts = useMemo(() => Array.from(new Set(sessions.map((s) => s.host))).sort(), [sessions]);
  const runnerName = deckName;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">Agents</h1>
            <p className="text-xs text-zinc-500">{ov ? <>cc and cx collaboration across the fleet · {runs.filter((r) => r.status === "running").length} running · {(collab?.tasks ?? []).filter((t) => t.status === "open").length} open tasks · {ov.status?.sessionsIndexed ?? 0} sessions indexed{source?.node ? <span data-testid="overview-source"> · Deck read from {source.nodeName}</span> : null}</> : err ?? "loading…"}</p>
          </div>
          {msg && <span className="text-[11px] text-zinc-400" data-testid="agents-msg">{msg}</span>}
        </header>
        {collab && runId && !run && <p role="alert">Run not found: {runId}</p>}
        {missingTask && <p role="alert">Task not found: {focusTask}</p>}
        {err && !ov && <div className="mt-6 hud-card p-6 text-sm text-zinc-400">{err}</div>}
        {ov && (
          <div className="mt-5 space-y-4">
            {/* handoff notes */}
            <div className="hud-card p-4">
              <button onClick={() => updateParams({ handoff: showHandoff ? null : "1" })} className="hud-label neon flex w-full items-center justify-between text-left">
                <span>Agent handoff notes ({ov.handoff.length})</span>
                <span className="text-[11px] text-zinc-500">{showHandoff ? "hide" : "show"}</span>
              </button>
              {showHandoff && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {ov.handoff.map((h) => (
                    <div key={h.file} className="rounded-lg bg-zinc-950/60 p-3">
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-400"><span className="font-mono text-zinc-200"><HostLink host={h.host} /></span><span className={`rounded px-1 text-[10px] ${h.agent === "cc" ? "bg-orange-500/15 text-orange-300" : "bg-sky-500/15 text-sky-300"}`}>{h.agent}</span><button onClick={() => navigate("edit", { path: fleetPath(ov.fleetDir, h.file), node: deckNode || undefined })} className="ml-auto font-mono text-[10px] text-zinc-600 hover:text-sky-400" title={`edit this note on ${deckName}`}>{h.file} ✎</button></div>
                      <Markdown text={h.text} />
                    </div>
                  ))}
                  {ov.handoff.length === 0 && <Empty>No handoff notes yet.</Empty>}
                </div>
              )}
            </div>

            {/* launch cc / cx */}
            <Panel title="Launch an agent">
              <form className="grid gap-2 sm:grid-cols-[auto_1fr_90px_1fr_auto]" onSubmit={(e) => { e.preventDefault(); const n = targets.find((x) => x.id === launch.node); openTerminal({ node: launch.node, nodeName: n?.name ?? (launch.node ? "node" : "local"), cwd: launch.cwd, cmd: launchCmd(launch.tool, launch.prompt.trim() || undefined), title: `${launch.tool} ${launch.cwd.split("/").pop() || "~"}` }); }}>
                <NodePicker value={launch.node} onChange={(node) => setLaunch({ ...launch, node })} targets={targets} testId="launch-node" title="which machine runs the agent" />
                <input list="launch-dirs" value={launch.cwd} onChange={(e) => setLaunch({ ...launch, cwd: e.target.value })} placeholder={`working directory on ${targets.find((x) => x.id === launch.node)?.name ?? "that machine"} (project repo)`} data-testid="launch-cwd" className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
                <datalist id="launch-dirs">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
                <select value={launch.tool} onChange={(e) => setLaunch({ ...launch, tool: e.target.value as "cc" | "cx" })} className="rounded-sm border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
                  <option value="cc">cc · Claude</option>
                  <option value="cx">cx · Codex</option>
                </select>
                <input value={launch.prompt} onChange={(e) => setLaunch({ ...launch, prompt: e.target.value })} placeholder="first prompt (optional)" className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
                <button data-testid="launch-go" className="hud-badge neon-green px-3 py-1.5 hover:bg-lime-500/10">Launch in terminal</button>
              </form>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {dirs.slice(0, 8).map((d) => <button key={d} onClick={() => setLaunch({ ...launch, cwd: d })} className="rounded-sm border border-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400 hover:text-zinc-100">{d.replace(home, "~")}</button>)}
              </div>
            </Panel>

            {/* collaboration */}
            <Panel
              title="Collaboration"
              right={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-zinc-400" title={`the collab runner on ${runnerName}`}>
                    <input type="checkbox" checked={collab?.auto ?? false} data-testid="collab-auto" onChange={(e) => act(e.target.checked ? `Auto on (${runnerName})` : `Auto off (${runnerName})`, () => postOn(deckNode, "/api/control/collab/auto", { auto: e.target.checked }))} />
                    Auto every {collab?.intervalMinutes ?? 30} min on {runnerName}
                  </label>
                  <button onClick={() => act(`Run next task on ${runnerName}`, () => postOn(deckNode, "/api/control/collab/tick", {}))} data-testid="collab-tick" className="hud-badge neon-green px-3 py-1.5 hover:bg-lime-500/10" title={`run the next open task queued for ${runnerName}`}>Run next task on {runnerName}</button>
                </div>
              }
            >
              {(collab?.tasks ?? []).length === 0 && <Empty>No tasks in the queue. Add one below; the worker agent does it, the reviewer checks it, and you see both logs here.</Empty>}
              {(collab?.tasks ?? []).map((t) => {
                const tr = runs.find((r) => r.task === t.id);
                const proj = ov.projects.find((p) => p.slug === t.project);
                return (
                  <Row key={t.id} id={`task-${t.id}`} active={focusTask === t.id} onClick={tr ? () => setRunId(tr.id) : undefined}>
                    <span className={`w-16 rounded px-1.5 py-0.5 text-center text-[9px] uppercase ${pill(t.status)}`}>{t.status}</span>
                    <span className="hidden w-20 shrink-0 font-mono text-[10px] text-zinc-500 sm:inline">{t.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200" title={t.body || (tr ? `run ${tr.id}: ${tr.status}` : undefined)}>{t.title}</span>
                    {t.project && <button onClick={(e) => { e.stopPropagation(); navigate("projects", { p: t.project }); }} className="hidden w-40 truncate text-left text-[10px] text-zinc-500 hover:text-sky-400 sm:inline" title="open project" data-testid={`task-project-${t.id}`}>{proj?.name ?? t.project}</button>}
                    <span className="hidden w-16 text-[10px] text-zinc-500 sm:inline"><HostLink host={t.host} /></span>
                    <span className="hidden w-14 text-[10px] text-zinc-500 sm:inline">{t.worker}→{t.reviewer}</span>
                    {tr && <span className={`led shrink-0 ${tr.status === "running" ? "led-run" : tr.status === "done" ? "led-on" : "led-err"}`} title={`run ${tr.id}: ${tr.status} (click row to open the log)`} />}
                    {t.status === "open" && (
                      <Action onClick={() => runTask(t)} title={`run on ${t.host}`} data-testid={`task-run-${t.id}`}>Run on {t.host}</Action>
                    )}
                  </Row>
                );
              })}
              <form
                className="mt-3 grid gap-2 sm:grid-cols-[1fr_160px_110px_70px_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!form.title) return;
                  act("Add task", async () => { const r = await postOn(deckNode, "/api/control/collab/add", form); setForm({ ...form, title: "", body: "" }); return r; });
                }}
              >
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="New task title" data-testid="task-title" className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-zinc-500" />
                <select value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
                  <option value="">project…</option>
                  {ov.projects.map((p) => <option key={p.slug} value={p.slug}>{"  ".repeat(p.depth)}{p.name}</option>)}
                </select>
                <select value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300" title="the host that runs this task">
                  <option value="">{me || deckName || "host…"}</option>
                  {agentHosts.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
                <select value={form.worker} onChange={(e) => setForm({ ...form, worker: e.target.value })} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
                  <option value="cx">cx</option>
                  <option value="cc">cc</option>
                </select>
                <button disabled={!form.title} data-testid="task-add" className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10 disabled:opacity-40">Add task</button>
                <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Details for the worker agent (optional): what done looks like, constraints, links" rows={2} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-zinc-500 sm:col-span-5" />
              </form>
            </Panel>

            {/* runs */}
            <Panel title={`Runs (${runs.length})`}>
              {runs.length === 0 && <Empty>No runs yet.</Empty>}
              <div className="grid gap-3 md:grid-cols-[320px_1fr]">
                <div className="max-h-[420px] overflow-auto">
                  {runs.map((r) => (
                    <Row key={r.id} onClick={() => setRunId(r.id)} active={run?.id === r.id}>
                      <span className={`led shrink-0 ${r.status === "running" ? "led-run" : r.status === "done" ? "led-on" : "led-err"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] text-zinc-200">{r.title}</div>
                        <div className="truncate text-[10px] text-zinc-500"><HostLink host={r.host} /> · {r.step} · {duration(r.startedAt, r.finishedAt)} · {isoAgo(r.startedAt)}{r.verdict ? ` · ${r.verdict}` : ""}</div>
                        {r.status === "running" && <div className="hud-progress mt-1"><span /></div>}
                      </div>
                    </Row>
                  ))}
                </div>
                {run && (
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      {LOGS.map((f) => (
                        <button key={f} onClick={() => setLogFile(f)} className={`rounded-md px-2 py-1 text-[11px] ${logFile === f ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>{f}</button>
                      ))}
                      <span className="ml-auto text-[10px] text-zinc-600" title={`log read from ${targets.find((t) => t.id === logNode)?.name ?? run.host}`}>{run.id} · {(log.size / 1024).toFixed(0)} KB</span>
                      <label className="ml-2 flex items-center gap-1 text-[10px] text-zinc-500"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />follow</label>
                      <button onClick={() => openOn(run.host, run.dir, `tail -n 200 -f ${shq(`${run.dir}/${logFile === "result.md" ? "result.md" : logFile}`)}`, `log ${run.task}`)} className="ml-2 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800" title={`tail this log in a terminal on ${run.host}`}>Open in terminal on {run.host}</button>
                    </div>
                    {log.error ? <p role="alert" className="mt-2">{log.error}: {logFile}</p> : log.key !== logKey ? <p role="status" className="mt-2">Loading log…</p> : logFile === "result.md" ? (
                      <div className="mt-2 max-h-[380px] overflow-auto rounded-lg bg-zinc-950 p-3"><Markdown text={log.text || "(no result yet)"} /></div>
                    ) : (
                      <pre ref={logRef} className={`mt-2 max-h-[380px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-sky-500/10 bg-zinc-950 p-3 font-mono text-[11px] leading-snug text-zinc-300 ${run.status === "running" ? "hud-cursor" : ""}`} data-testid="run-log">{log.text || "(empty)"}</pre>
                    )}
                  </div>
                )}
              </div>
            </Panel>

            {/* sessions */}
            <Panel
              title={`Sessions (${sessions.length})`}
              right={
                <div className="flex items-center gap-2">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search title, path, id" data-testid="session-search" className="w-48 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-zinc-500" />
                  <select value={host} onChange={(e) => setHost(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300"><option value="">all hosts</option>{sessionHosts.map((h) => <option key={h} value={h}>{h}</option>)}</select>
                  <select value={tool} onChange={(e) => setTool(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300"><option value="">cc + cx + cloud</option><option value="cc">cc</option><option value="cx">cx</option><option value="cloud">cloud (chatgpt, claude)</option></select>
                </div>
              }
            >
              {sessions.length === 0 && <Empty>No sessions match.</Empty>}
              {sessions.slice(0, 80).map((s) => {
                const here = s.host.toLowerCase() === me.toLowerCase();
                const browseNode = here ? "" : nodeFor(s.host);
                return (
                <Row key={`${s.host}-${s.id}`}>
                  <span className="w-16 shrink-0 text-[11px] text-zinc-400"><HostLink host={s.host} /></span>
                  <span className={`shrink-0 rounded px-1 text-[10px] ${s.tool === "cc" ? "bg-orange-500/15 text-orange-300" : s.tool === "cx" ? "bg-sky-500/15 text-sky-300" : (s.tool as string) === "chatgpt" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>{(s.tool as string) === "claude-web" ? "claude" : s.tool}</span>
                  <span className="w-14 shrink-0 text-[10px] text-zinc-500">{isoAgo(s.updated)}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200" title={s.title}>{s.title}</span>
                  {browseNode !== null ? (
                    <button onClick={() => navigate("files", { path: s.cwd, node: browseNode })} className="hidden w-44 truncate text-left font-mono text-[10px] text-zinc-600 hover:text-sky-400 md:inline" title={`browse this directory on ${s.host}`}>{homePath(s.cwd)}</button>
                  ) : <span className="hidden w-44 truncate font-mono text-[10px] text-zinc-600 md:inline">{homePath(s.cwd)}</span>}
                  <span className="hidden w-24 truncate font-mono text-[10px] text-zinc-700 lg:inline">{s.id}</span>
                  {s.tool !== "cc" && s.tool !== "cx" ? (
                    <button onClick={() => navigate("cloud", { profile: (s.tool as string) === "chatgpt" ? "chatgpt" : "claude", url: (s as Session & { url?: string }).url ?? "", node: deckNode || undefined })} className="shrink-0 rounded border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10" title={`open the archived conversation live in ${deckName}'s browser`}>Open in Cloud</button>
                  ) : (
                  <button onClick={() => openOn(s.host, s.cwd, resumeCmd(s.tool, s.id), `${s.tool} ${s.title.slice(0, 18)}`)} data-testid="session-resume" className="shrink-0 rounded border border-sky-500/30 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/10" title={here ? "resume in a terminal here" : `resume in a terminal on ${s.host} (natively on a paired node, else over ssh)`}>{here ? "Resume here" : `Resume on ${s.host}`}</button>
                  )}
                  {!here && s.tool !== "chatgpt" as string && (s.tool as string) !== "claude-web" && (
                    <button disabled={pulling === s.id} onClick={() => { setPulling(s.id); act(`Pull ${s.id.slice(0, 8)} to ${targets[0]?.name ?? "this machine"}`, () => postOn("", "/api/control/sessions/pull", { id: s.id })).finally(() => setPulling(null)); }} className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40" title={`copy the transcript to ${targets[0]?.name ?? "this machine"} so it can be resumed here`}>{pulling === s.id ? "…" : "Pull here"}</button>
                  )}
                </Row>
                );
              })}
              {sessions.length > 80 && <div className="pt-2 text-[10px] text-zinc-600">showing 80 of {sessions.length}; narrow the search</div>}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
