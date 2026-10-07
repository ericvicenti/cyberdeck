import { useEffect, useMemo, useRef, useState } from "react";
import { api, post, wsUrl, activeNode, activeNodeName, ApiError } from "../lib/api";
import { openTerminal, launchCmd, resumeCmd, shq } from "../lib/terms";
import { type Overview, type Session, type Run, type Task, pill, isoAgo, duration } from "../lib/control";
import { Markdown } from "./Markdown";
import { Panel, Row, Empty } from "./Projects";

type Collab = { tasks: Task[]; runs: Run[]; auto: boolean; intervalMinutes?: number };
const LOGS = ["worker.log", "reviewer.log", "result.md"] as const;

export function Agents({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [collab, setCollab] = useState<Collab | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showHandoff, setShowHandoff] = useState(false);
  const [runId, setRunId] = useState<string>(params.get("run") ?? "");
  const [logFile, setLogFile] = useState<(typeof LOGS)[number]>("worker.log");
  const [log, setLog] = useState<{ text: string; size: number }>({ text: "", size: 0 });
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  // sessions
  const [q, setQ] = useState("");
  const [host, setHost] = useState("");
  const [tool, setTool] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  // add task form
  const [form, setForm] = useState({ title: "", project: "", host: "", worker: "cx", body: "" });
  // launch an agent in a terminal
  const [nodes, setNodes] = useState<{ id: string; name: string; online: boolean }[]>([]);
  const [launch, setLaunch] = useState({ node: activeNode(), cwd: "", tool: "cc" as "cc" | "cx", prompt: "" });
  useEffect(() => { fetch("/api/fleet/nodes", { headers: { authorization: `Bearer ${localStorage.getItem("cyberdeck-token") ?? ""}` } }).then((r) => r.json()).then((f) => setNodes(f.nodes ?? [])).catch(() => {}); }, []);
  const home = ov ? ov.fleetDir.replace(/\/Code\/[^/]+$/, "") : "";
  const dirs = useMemo(() => { const d = new Set<string>(); if (home) d.add(`${home}/Code`); for (const p of ov?.projects ?? []) for (const g of p.repos) if (!g.includes("*") && home) d.add(`${home}/Code/${g}`); return [...d]; }, [ov, home]);
  /** Node id for a fleet host name ("" = this node). */
  const nodeFor = (hostName: string) => (hostName.toLowerCase() === (ov?.status?.host ?? "").toLowerCase() ? { id: "", name: hostName } : nodes.find((n) => n.name.toLowerCase() === hostName.toLowerCase()));
  const openOn = (hostName: string, cwd: string, cmd: string, title: string) => {
    const n = nodeFor(hostName);
    if (!n) { setMsg(`${hostName} is not a paired node`); return; }
    if (n.id && !nodes.find((x) => x.id === n.id)?.online) { setMsg(`${hostName} is offline`); return; }
    openTerminal({ node: n.id, nodeName: n.name, cwd, cmd, title });
  };

  const load = async () => {
    try {
      const [o, c] = await Promise.all([api<Overview>("/api/control/overview"), api<Collab>("/api/control/collab")]);
      setOv(o);
      setCollab(c);
      setErr(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      else setErr(e instanceof ApiError && e.status === 404 ? "No fleet dir configured on this node (set fleetDir in ~/.cyberdeck/config.json)." : String(e instanceof Error ? e.message : e));
    }
  };
  useEffect(() => {
    load();
    const iv = setInterval(load, 20_000);
    if (activeNode()) return () => clearInterval(iv);
    const ws = new WebSocket(wsUrl("/api/events"));
    ws.onmessage = (m) => { try { const ev = JSON.parse(m.data); if (ev.kind === "collab" || ev.kind === "services") load(); } catch {} };
    return () => { clearInterval(iv); ws.close(); };
  }, []);

  const loadSessions = async () => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (host) p.set("host", host);
    if (tool) p.set("tool", tool);
    try { setSessions(await api<Session[]>(`/api/control/sessions?${p}`)); } catch {}
  };
  useEffect(() => { const t = setTimeout(loadSessions, 250); return () => clearTimeout(t); }, [q, host, tool, ov?.fleetDir]);

  const runs = collab?.runs ?? [];
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  useEffect(() => { if (run && run.id !== runId) setRunId(run.id); }, [run?.id]);
  useEffect(() => {
    if (!run) return;
    let alive = true;
    const fetchLog = async () => {
      try { const l = await api<{ text: string; size: number }>(`/api/control/collab/runs/${run.id}/log?file=${logFile}&tail=60000`); if (alive) setLog(l); } catch {}
    };
    fetchLog();
    const iv = setInterval(fetchLog, run.status === "running" ? 3000 : 30000);
    return () => { alive = false; clearInterval(iv); };
  }, [run?.id, run?.status, logFile]);
  useEffect(() => { if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log, follow]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setMsg(`${label}…`);
    try { const r: any = await fn(); setMsg(r?.reason ? `${label}: ${r.reason}` : r?.output ? String(r.output).split("\n").pop() ?? label : `${label}: ok`); load(); }
    catch (e) { setMsg(`${label} failed: ${e instanceof Error ? e.message : e}`); }
  };
  const hosts = useMemo(() => (ov?.status?.hosts ?? []).filter((h) => h.roles.includes("agents")).map((h) => h.name), [ov]);
  const sessionHosts = useMemo(() => Array.from(new Set(sessions.map((s) => s.host))).sort(), [sessions]);
  const me = ov?.status?.host ?? "";

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">Agents{activeNode() ? ` on ${activeNodeName()}` : ""}</h1>
            <p className="text-xs text-zinc-500">{ov ? `cc and cx collaboration on ${me} · ${runs.filter((r) => r.status === "running").length} running · ${(collab?.tasks ?? []).filter((t) => t.status === "open").length} open tasks · ${ov.status?.sessionsIndexed ?? 0} sessions indexed` : err ?? "loading…"}</p>
          </div>
          {msg && <span className="text-[11px] text-zinc-400" data-testid="agents-msg">{msg}</span>}
        </header>
        {err && !ov && <div className="mt-6 hud-card p-6 text-sm text-zinc-400">{err}</div>}
        {ov && (
          <div className="mt-5 space-y-4">
            {/* handoff notes */}
            <div className="hud-card p-4">
              <button onClick={() => setShowHandoff((v) => !v)} className="hud-label neon flex w-full items-center justify-between text-left">
                <span>Agent handoff notes ({ov.handoff.length})</span>
                <span className="text-[11px] text-zinc-500">{showHandoff ? "hide" : "show"}</span>
              </button>
              {showHandoff && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {ov.handoff.map((h) => (
                    <div key={h.file} className="rounded-lg bg-zinc-950/60 p-3">
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-400"><span className="font-mono text-zinc-200">{h.host}</span><span className={`rounded px-1 text-[10px] ${h.agent === "cc" ? "bg-orange-500/15 text-orange-300" : "bg-sky-500/15 text-sky-300"}`}>{h.agent}</span><span className="ml-auto font-mono text-[10px] text-zinc-600">{h.file}</span></div>
                      <Markdown text={h.text} />
                    </div>
                  ))}
                  {ov.handoff.length === 0 && <Empty>No handoff notes yet.</Empty>}
                </div>
              )}
            </div>

            {/* launch cc / cx */}
            <Panel title="Launch an agent">
              <form className="grid gap-2 sm:grid-cols-[150px_1fr_90px_1fr_auto]" onSubmit={(e) => { e.preventDefault(); const n = launch.node ? nodes.find((x) => x.id === launch.node) : null; openTerminal({ node: launch.node, nodeName: n?.name ?? "node", cwd: launch.cwd, cmd: launchCmd(launch.tool, launch.prompt.trim() || undefined), title: `${launch.tool} ${launch.cwd.split("/").pop() || "~"}` }); }}>
                <select value={launch.node} onChange={(e) => setLaunch({ ...launch, node: e.target.value })} data-testid="launch-node" className="rounded-sm border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
                  <option value="">{ov.status?.host ?? "this machine"} (local)</option>
                  {nodes.map((n) => <option key={n.id} value={n.id} disabled={!n.online}>{n.name}{n.online ? "" : " (offline)"}</option>)}
                </select>
                <input list="launch-dirs" value={launch.cwd} onChange={(e) => setLaunch({ ...launch, cwd: e.target.value })} placeholder="working directory (project repo)" data-testid="launch-cwd" className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
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
                  <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-zinc-400">
                    <input type="checkbox" checked={collab?.auto ?? false} disabled={!!activeNode() && false} data-testid="collab-auto" onChange={(e) => act(e.target.checked ? "Auto on" : "Auto off", () => post("/api/control/collab/auto", { auto: e.target.checked }))} />
                    Auto every {collab?.intervalMinutes ?? 30} min
                  </label>
                  <button onClick={() => act("Run next task", () => post("/api/control/collab/tick", {}))} data-testid="collab-tick" className="hud-badge neon-green px-3 py-1.5 hover:bg-lime-500/10">Run next task</button>
                </div>
              }
            >
              {(collab?.tasks ?? []).length === 0 && <Empty>No tasks in the queue. Add one below; the worker agent does it, the reviewer checks it, and you see both logs here.</Empty>}
              {(collab?.tasks ?? []).map((t) => (
                <Row key={t.id}>
                  <span className={`w-16 rounded px-1.5 py-0.5 text-center text-[9px] uppercase ${pill(t.status)}`}>{t.status}</span>
                  <span className="hidden w-20 shrink-0 font-mono text-[10px] text-zinc-500 sm:inline">{t.id}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200" title={t.body}>{t.title}</span>
                  <span className="hidden w-40 truncate text-[10px] text-zinc-500 sm:inline">{t.project}</span>
                  <span className="hidden w-16 text-[10px] text-zinc-500 sm:inline">{t.host}</span>
                  <span className="hidden w-14 text-[10px] text-zinc-500 sm:inline">{t.worker}→{t.reviewer}</span>
                  {t.status === "open" && (
                    <button onClick={() => act(`Run ${t.id}`, () => post("/api/control/collab/run", { id: t.id }))} className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800">Run</button>
                  )}
                </Row>
              ))}
              <form
                className="mt-3 grid gap-2 sm:grid-cols-[1fr_160px_110px_70px_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!form.title) return;
                  act("Add task", async () => { const r = await post("/api/control/collab/add", form); setForm({ ...form, title: "", body: "" }); return r; });
                }}
              >
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="New task title" data-testid="task-title" className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-zinc-500" />
                <select value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
                  <option value="">project…</option>
                  {ov.projects.map((p) => <option key={p.slug} value={p.slug}>{"  ".repeat(p.depth)}{p.name}</option>)}
                </select>
                <select value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
                  <option value="">{me || "host…"}</option>
                  {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
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
                        <div className="truncate text-[10px] text-zinc-500">{r.host} · {r.step} · {duration(r.startedAt, r.finishedAt)} · {isoAgo(r.startedAt)}{r.verdict ? ` · ${r.verdict}` : ""}</div>
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
                      <span className="ml-auto text-[10px] text-zinc-600">{run.id} · {(log.size / 1024).toFixed(0)} KB</span>
                      <label className="ml-2 flex items-center gap-1 text-[10px] text-zinc-500"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />follow</label>
                      <button onClick={() => openOn(run.host, run.dir, `tail -n 200 -f ${shq(`${run.dir}/${logFile === "result.md" ? "result.md" : logFile}`)}`, `log ${run.task}`)} className="ml-2 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800" title="tail this log in a terminal on the run's host">Open in terminal</button>
                    </div>
                    {logFile === "result.md" ? (
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
                  <select value={tool} onChange={(e) => setTool(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300"><option value="">cc + cx</option><option value="cc">cc</option><option value="cx">cx</option></select>
                </div>
              }
            >
              {sessions.length === 0 && <Empty>No sessions match.</Empty>}
              {sessions.slice(0, 80).map((s) => (
                <Row key={`${s.host}-${s.id}`}>
                  <span className="w-16 shrink-0 text-[11px] text-zinc-400">{s.host}</span>
                  <span className={`shrink-0 rounded px-1 text-[10px] ${s.tool === "cc" ? "bg-orange-500/15 text-orange-300" : "bg-sky-500/15 text-sky-300"}`}>{s.tool}</span>
                  <span className="w-14 shrink-0 text-[10px] text-zinc-500">{isoAgo(s.updated)}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200" title={s.title}>{s.title}</span>
                  <span className="hidden w-44 truncate font-mono text-[10px] text-zinc-600 md:inline">{s.cwd.replace(/^\/(Users|home)\/[^/]+/, "~")}</span>
                  <span className="hidden w-24 truncate font-mono text-[10px] text-zinc-700 lg:inline">{s.id}</span>
                  <button onClick={() => openOn(s.host, s.cwd, resumeCmd(s.tool, s.id), `${s.tool} ${s.title.slice(0, 18)}`)} className="shrink-0 rounded border border-sky-500/30 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/10" title={s.host === me ? "resume in a terminal here" : `resume in a terminal on ${s.host}`}>{s.host === me ? "Resume here" : "Resume there"}</button>
                  {s.host !== me && (
                    <button disabled={pulling === s.id} onClick={() => { setPulling(s.id); act(`Pull ${s.id.slice(0, 8)}`, () => post("/api/control/sessions/pull", { id: s.id })).finally(() => setPulling(null)); }} className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">{pulling === s.id ? "…" : "Pull here"}</button>
                  )}
                </Row>
              ))}
              {sessions.length > 80 && <div className="pt-2 text-[10px] text-zinc-600">showing 80 of {sessions.length}; narrow the search</div>}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
