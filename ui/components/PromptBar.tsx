// Sticky prompt bar: one line starts an agent session anywhere in the fleet. The
// harness planner (src/shared/harness.ts) reads the prompt plus where you are in the
// UI and proposes node / agent / directory / runner; every choice is shown as a chip
// you can override before sending. The strip above it lists live sessions on every
// node, which is the way back into them.
import { useEffect, useMemo, useRef, useState } from "react";
import { activeNode, api, type Route } from "../lib/api";
import { planHarness, shortCwd, type Caps, type PlanOverrides, type PlanRepo, type Runner, type Tool } from "../../src/shared/harness";
import { apiOn } from "../lib/sessions";
import { messageRequestId, createSession, getCaps, openSession, useLiveSessions, type LiveSession } from "../lib/sessions";
import { recentCwds, rememberCwd } from "../lib/terms";
import type { Overview } from "../lib/control";

const PREF_KEY = "cyberdeck-default-tool-v2";
const DRAFT_KEY = "cyberdeck-prompt-draft";
const readPref = (): "seed" | "cc" | "cx" => { try { const p = localStorage.getItem(PREF_KEY); return p === "cc" || p === "cx" ? p : "seed"; } catch { return "seed"; } };

/** What the current view says about where the user is. */
function contextFor(route: Route, sessions: LiveSession[]): { cwd?: string | null; project?: string | null } {
  const p = route.params;
  if (route.view === "files" && p.get("path")) return { cwd: p.get("path") };
  if (route.view === "edit" && p.get("path")) return { cwd: p.get("path")!.replace(/\/[^/]*$/, "") || "/" };
  if (route.view === "projects" && p.get("p")) return { project: p.get("p") };
  if (route.view === "term" && p.get("session")) { const s = sessions.find((x) => x.id === p.get("session") && x.node === activeNode()); if (s && s.tool !== "seed") return { cwd: s.cwd }; }
  return {};
}

export function PromptBar({ route, nodeName }: { route: Route; nodeName: string }) {
  const { sessions, nodes } = useLiveSessions();
  const [text, setText] = useState(() => { try { return localStorage.getItem(DRAFT_KEY) ?? ""; } catch { return ""; } });
  const [overrides, setOverrides] = useState<PlanOverrides>({});
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [caps, setCaps] = useState<Record<string, Caps | null>>({});
  const [repos, setRepos] = useState<Record<string, PlanRepo[]>>({});
  const [editCwd, setEditCwd] = useState(false);
  const [pref, setPref] = useState<"seed" | "cc" | "cx">(readPref);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { api<Overview>("/api/control/overview").then(setOverview).catch(() => setOverview(null)); }, []);
  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, text); } catch {} }, [text]);
  // Capabilities for every reachable node (cached per page).
  const nodeIds = useMemo(() => ["", ...(nodes?.nodes.filter((n) => n.online).map((n) => n.id) ?? [])], [nodes]);
  useEffect(() => { for (const id of nodeIds) if (!(id in caps)) getCaps(id).then((c) => setCaps((m) => ({ ...m, [id]: c }))); }, [nodeIds]);
  // Every indexed checkout on every online node is a possible destination (refreshed every 5 min).
  useEffect(() => {
    let alive = true;
    const load = () => { for (const id of nodeIds) apiOn<{ path: string; name: string }[]>(id, "/api/repos").then((rows) => { if (alive) setRepos((m) => ({ ...m, [id]: rows.map((r) => ({ node: id, name: r.path.split("/").pop() || r.name, path: r.path })) })); }).catch(() => {}); };
    load();
    const iv = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, [nodeIds]);
  const allRepos = useMemo(() => nodeIds.flatMap((id) => repos[id] ?? []), [repos, nodeIds]);
  useEffect(() => { if (note?.kind === "ok") { const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); } }, [note]);

  const planNodes = useMemo(() => [{ id: "", name: nodes?.self.name ?? nodeName, online: true, caps: caps[""] ?? null }, ...(nodes?.nodes ?? []).map((n) => ({ id: n.id, name: n.name, online: n.online, caps: caps[n.id] ?? null }))], [nodes, caps, nodeName]);
  const projects = useMemo(() => (overview?.projects ?? []).map((p) => ({ slug: p.slug, name: p.name, repos: p.repos, hosts: p.hosts })), [overview]);
  const context = useMemo(() => ({ node: activeNode(), ...contextFor(route, sessions) }), [route, sessions]);
  const plan = useMemo(() => planHarness({ prompt: text, context, nodes: planNodes, projects, repos: allRepos, overrides, defaultTool: pref }), [text, context, planNodes, projects, allRepos, overrides, pref]);
  const home = overview ? overview.fleetDir.replace(/\/Code\/[^/]+$/, "") : "";
  const cwdOptions = useMemo(() => Array.from(new Set([...recentCwds(), ...(home ? [`${home}/Code`] : []), ...(repos[plan.node] ?? []).map((r) => r.path), ...projects.flatMap((p) => p.repos.filter((r) => !r.includes("*")).map((r) => `~/Code/${r.replace(/\/.*$/, "")}`))])), [projects, home, focused, repos, plan.node]);

  const send = async (background: boolean) => {
    const t = text.trim();
    if (!t || sending || plan.error) return;
    if (plan.tool !== "shell" && !plan.prompt) { setNote({ text: "that only routes; add what the agent should do", kind: "err" }); return; }
    setSending(true);
    try {
      const s = await createSession(plan.node, plan.nodeName, { cwd: plan.cwd, cmd: plan.cmd || undefined, title: plan.title, tool: plan.tool, prompt: plan.prompt || undefined, runner: plan.runner });
      if (plan.tool === "seed") {
        try { await apiOn(plan.node, `/api/sessions/${s.id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: plan.prompt, cwd: plan.cwd, nodeName: plan.contextNodeName, clientMessageId: messageRequestId() }) }); }
        catch (e) { openSession(s); throw new Error(`Session created; first message could not be confirmed. Check the conversation before retrying: ${e instanceof Error ? e.message : e}`); }
      }
      rememberCwd(plan.cwd);
      setText(""); setOverrides({}); setEditCwd(false);
      setNote({ text: `started ${s.title} on ${plan.nodeName}`, kind: "ok" });
      if (!background) openSession(s);
    } catch (e) {
      setNote({ text: `could not start: ${e instanceof Error ? e.message : e}`, kind: "err" });
    } finally { setSending(false); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e.metaKey || e.ctrlKey); }
    if (e.key === "Escape") { (e.target as HTMLTextAreaElement).blur(); }
  };
  const cycleTool = () => { const order: Tool[] = ["seed", "cc", "cx", "shell"]; const next = order[(order.indexOf(plan.tool) + 1) % order.length]; setOverrides({ ...overrides, tool: next }); };
  const cycleRunner = () => setOverrides({ ...overrides, runner: (plan.runner === "tmux" ? "pty" : "tmux") as Runner });
  const unpin = (k: keyof PlanOverrides) => { const o = { ...overrides }; delete o[k]; setOverrides(o); };
  const live = useMemo(() => [...sessions].sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || b.createdAt - a.createdAt), [sessions]);
  const currentId = route.view === "term" ? route.params.get("session") : null;
  const showPlan = focused || text.length > 0;
  const chip = (label: string, opts: { pinned?: boolean; onClick?: () => void; title?: string; testid?: string; tone?: string }) => (
    <button type="button" onClick={opts.onClick} title={opts.title} data-testid={opts.testid} className={`hud-chip shrink-0 normal-case tracking-normal ${opts.pinned ? "border-sky-400/60 text-sky-200" : opts.tone ?? "text-zinc-300"} hover:text-zinc-100`}>{label}{opts.pinned ? " ●" : ""}</button>
  );

  return (
    <div className="hud-chrome shrink-0 border-t" data-testid="prompt-bar">
      {/* live sessions: the way back in */}
      {live.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto px-2 pt-1.5" data-testid="session-strip">
          <span className="hud-label mr-1 hidden shrink-0 sm:inline">live</span>
          {live.slice(0, 24).map((s) => (
            <button key={`${s.node}:${s.id}`} onClick={() => openSession(s)} data-testid="session-chip" title={`${s.title} · ${s.nodeName} · ${shortCwd(s.cwd)} · ${s.state}${s.bells ? ` · ${s.bells} bell` : ""}`}
              className={`flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] ${currentId === s.id && s.node === activeNode() ? "border-sky-500/50 bg-sky-500/10 text-zinc-100" : "border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-100"}`}>
              <span className={`led ${s.state !== "running" ? "led-off" : s.busy ? "led-run" : s.bells ? "led-warn" : "led-on"}`} />
              {s.tool !== "shell" && <span className={`rounded px-1 text-[9px] ${s.tool === "cc" ? "bg-orange-500/15 text-orange-300" : "bg-sky-500/15 text-sky-300"}`}>{s.tool}</span>}
              <span className="max-w-[160px] truncate font-mono">{s.title}</span>
              {s.node !== "" && <span className="text-[9px] uppercase tracking-wider text-zinc-600">{s.nodeName}</span>}
            </button>
          ))}
          {live.length > 24 && <span className="text-[10px] text-zinc-600">+{live.length - 24}</span>}
        </div>
      )}
      {/* plan chips */}
      {showPlan && (
        <div className="flex flex-wrap items-center gap-1 px-2 pt-1.5 text-[10px]" data-testid="plan-chips">
          <span className="hud-label mr-1 hidden sm:inline">{plan.pinned.length ? "plan (pinned ●)" : "auto"}</span>
          <select value={plan.node} onChange={(e) => setOverrides({ ...overrides, node: e.target.value })} data-testid="plan-node" title={plan.tool === "seed" ? "Agent server node" : "machine"} className={`hud-chip cursor-pointer appearance-none bg-transparent normal-case tracking-normal ${plan.pinned.includes("node") ? "border-sky-400/60 text-sky-200" : "text-zinc-300"}`}>
            {planNodes.map((n) => <option key={n.id} value={n.id} disabled={!n.online}>{n.name}{n.online ? "" : " (offline)"}</option>)}
          </select>
          {chip(plan.tool === "seed" ? "Seed agents" : plan.tool === "cc" ? "cc · Claude" : plan.tool === "cx" ? "cx · Codex" : "$ shell", { pinned: plan.pinned.includes("tool"), onClick: cycleTool, title: "agent (click to cycle)", testid: "plan-tool", tone: plan.tool === "cc" ? "text-orange-300" : plan.tool === "cx" ? "text-sky-300" : "text-zinc-300" })}
          {editCwd ? (
            <input autoFocus list="prompt-cwd-options" defaultValue={plan.cwd} onBlur={(e) => { const v = e.target.value.trim(); setEditCwd(false); if (v) setOverrides({ ...overrides, cwd: v }); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditCwd(false); }} className="w-56 rounded-sm border border-sky-500/40 bg-zinc-950 px-2 py-0.5 font-mono text-[10px] text-zinc-100 outline-none" />
          ) : chip(shortCwd(plan.cwd), { pinned: plan.pinned.includes("cwd"), onClick: () => setEditCwd(true), title: "working directory (click to edit)", testid: "plan-cwd" })}
          <datalist id="prompt-cwd-options">{cwdOptions.map((c) => <option key={c} value={c} />)}</datalist>
          {plan.tool !== "seed" && chip(plan.runner, { pinned: plan.pinned.includes("runner"), onClick: cycleRunner, title: plan.runner === "tmux" ? "tmux: survives daemon restarts; `tmux attach -t cd-<id>` from any terminal" : "plain pty: ends if the daemon restarts", testid: "plan-runner", tone: "text-zinc-400" })}
          {plan.pinned.length > 0 && <button type="button" onClick={() => { setOverrides({}); setEditCwd(false); }} className="text-zinc-500 hover:text-zinc-200" title="back to automatic">reset</button>}
          <span className="ml-auto hidden truncate text-zinc-600 md:inline" title={plan.reasons.join("\n")} data-testid="plan-reasons">{plan.reasons.filter((r) => !r.startsWith("default")).slice(0, 3).join(" · ")}</span>
        </div>
      )}
      {/* the input */}
      <form className="flex items-end gap-2 px-2 py-1.5" onSubmit={(e) => { e.preventDefault(); send(false); }}>
        <span className={`mb-1.5 hidden font-mono text-sm sm:inline ${sending ? "text-zinc-600" : "neon"}`}>›</span>
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          rows={1}
          disabled={sending}
          data-testid="prompt-input"
          placeholder={`Start a session: describe the task… (@node, #project, seed:/cc:/cx:, or $ for a shell command; Enter starts, ${/Mac/.test(navigator.platform) ? "⌘" : "Ctrl+"}Enter starts in the background)`}
          className="max-h-32 min-h-[34px] flex-1 resize-none rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-[12px] leading-5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500/60 disabled:opacity-60"
          style={{ height: "auto" }}
          onInput={(e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = `${Math.min(128, el.scrollHeight)}px`; }}
        />
        <button type="button" onClick={() => { const n = pref === "seed" ? "cc" : pref === "cc" ? "cx" : "seed"; setPref(n); try { localStorage.setItem(PREF_KEY, n); } catch {} }} title={`default agent when nothing decides: ${pref} (click to switch)`} className="mb-0.5 hidden text-[9px] uppercase tracking-widest text-zinc-600 hover:text-zinc-300 sm:inline" data-testid="prompt-pref">{pref}</button>
        <button disabled={!text.trim() || sending || !!plan.error} data-testid="prompt-go" className="hud-badge neon-green mb-0.5 px-3 py-1.5 hover:bg-lime-500/10 disabled:opacity-40">{sending ? "…" : "Start"}</button>
      </form>
      {plan.error && showPlan && <div role="status" className="px-3 pb-1 text-xs text-amber-300">{plan.error}</div>}
      {note && <div className={`px-3 pb-1 text-[10px] ${note.kind === "err" ? "text-red-300" : "text-zinc-400"}`} data-testid="prompt-note">{note.text}</div>}
    </div>
  );
}
