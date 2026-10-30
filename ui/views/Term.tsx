import { lazy, Suspense } from "react";
import { updateParams, useRouteTitle, routeHash } from "../lib/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { navigate, routeNode } from "../lib/api";
import { recentCwds, rememberCwd, shortCwd } from "../lib/terms";
import { attachUrl, createSession, getCaps, removeSession, renameSession, useLiveSessions, type LiveSession } from "../lib/sessions";
import { useOverview, projectDirs, targetsOf } from "../lib/fleet";
import { NodePicker, NodeTag } from "../components/NodePicker";
import { confirmAction } from "../lib/tv/confirm";
import "@xterm/xterm/css/xterm.css";

// Local and paired-node Seed sessions render Seed's own UI, loaded on first use.
const SeedAgentsEmbed = lazy(() => import("./SeedAgents").then((m) => ({ default: m.SeedAgentsEmbed })));

type Status = "connecting" | "live" | "exited" | "closed";

/** One attached session. Remounts (new socket + replay) when the session id changes. */
function TermPane({ session, onStatus, onRemove }: { session: LiveSession; onStatus: (s: Status) => void; onRemove: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<Status>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctrl = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#07080c", foreground: "#d4d4d8", cursor: "#22d3ee", selectionBackground: "#164e63" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    fit.fit();

    const ws = new WebSocket(attachUrl(session.node, session.id, { cols: term.cols, rows: term.rows }));
    wsRef.current = ws;
    const set = (s: Status) => { setStatus(s); onStatus(s); };
    set("connecting");
    let exited = false;
    ws.onopen = () => { set("live"); ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows })); term.focus(); };
    ws.onmessage = (msg) => {
      try {
        const m = JSON.parse(msg.data);
        if (m.t === "data") term.write(m.data);
        if (m.t === "exit") { exited = true; setExitCode(m.code); term.write(`\r\n\x1b[90m[session exited ${m.code}]\x1b[0m\r\n`); set("exited"); }
      } catch {}
    };
    ws.onclose = () => { if (!exited) set("closed"); };
    ws.onerror = () => { if (!exited) set("closed"); };
    const inputSub = term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "input", data })); });
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.offsetParent === null) return;
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    });
    ro.observe(host.current);
    return () => { ro.disconnect(); inputSub.dispose(); ws.close(); term.dispose(); termRef.current = null; wsRef.current = null; };
  }, [session.id, session.node, generation]);

  const sendKey = (seq: string) => { const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "input", data: seq })); termRef.current?.focus(); };
  const key = (label: string, seq: string) => (
    <button key={label} onPointerDown={(e) => { e.preventDefault(); if (ctrl.current && seq.length === 1) { sendKey(String.fromCharCode(seq.toUpperCase().charCodeAt(0) - 64)); ctrl.current = false; } else sendKey(seq); }} className="rounded-sm border border-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-300 active:bg-zinc-800">{label}</button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={host} className="min-h-0 flex-1 bg-[#07080c] p-2" data-testid="terminal-host" />
      {status === "closed" && (
        <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
          disconnected (the session is still running on {session.nodeName})
          <button onClick={() => setGeneration((g) => g + 1)} className="hud-badge neon px-2 py-0.5 hover:bg-sky-500/10">Reconnect</button>
        </div>
      )}
      {status === "exited" && (
        <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500" data-testid="term-exited">
          session exited{exitCode != null ? ` (${exitCode})` : ""}
          <button onClick={onRemove} className="hud-badge px-2 py-0.5 text-zinc-300 hover:text-zinc-100">Remove</button>
        </div>
      )}
      {/* mobile key toolbar */}
      <div className="flex gap-1 overflow-x-auto border-t border-zinc-800 px-2 py-1.5 sm:hidden">
        {key("esc", "\x1b")}{key("tab", "\t")}
        <button onPointerDown={(e) => { e.preventDefault(); ctrl.current = !ctrl.current; }} className="rounded-sm border border-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-300 active:bg-zinc-800">ctrl</button>
        {key("^c", "\x03")}{key("^d", "\x04")}{key("↑", "\x1b[A")}{key("↓", "\x1b[B")}{key("←", "\x1b[D")}{key("→", "\x1b[C")}{key("enter", "\r")}
      </div>
    </div>
  );
}
/** A Seed session in Seed's UI: tool calls, runs, plan, sub-sessions, model and stop/retry. */
function NativeSeedSession({ id, node }: { id: string; node: string }) {
  const sessionId = id.replace(/^seed-/, "");
  return (
    <Suspense fallback={<div className="p-6 text-xs text-zinc-500">Loading Seed agents…</div>}>
      <SeedAgentsEmbed
        node={node}
        title={`${sessionId} · Seed session`}
        route={{ key: "agent-session", sessionId }}
        onRouteChange={(next, mode, path) => {
          // Stay in Sessions for this session; anything else (the agent, a run, another session) opens the Seed view on the same machine.
          if (next.key === "agent-session" && next.sessionId === sessionId) return;
          navigate("seed", { r: path, node: node || undefined }, mode);
        }}
      />
    </Suspense>
  );
}

/** Sessions on every machine in one tab strip; a tab is `${node}:${id}` and the URL names both
 *  (`#/term?session=<id>&node=<id>`, no node = this machine). New sessions pick their machine in the form.
 *  A URL describes content and never replays a command: `#/term?cwd=<dir>[&node=<id>]` (or `?new=1`) opens
 *  the New session form prefilled for that machine; only Open starts the process (docs/NAVIGATION contract). */
export type SessionDraftStore = {
  values: Map<string, { cwd: string; cmd: string }>;
  pending: Set<string>;
  generation: number;
};

export function Term({ params, onLocked, drafts }: { params: URLSearchParams; onLocked?: () => void; drafts: SessionDraftStore }) {
  const { sessions: all, nodes, states, fleetError, refresh, replace } = useLiveSessions(4000);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const adding = params.get("new") === "1" || (!!params.get("cwd") && !params.get("session"));
  const [, renderDraft] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const filter = params.get("filter") || "";
  const filterNode = filter === "self" ? "" : filter || "*";
  const active = params.get("session") ?? "";
  const activeNode = routeNode(params);
  const { overview } = useOverview();
  const targets = useMemo(() => targetsOf(nodes), [nodes]);
  const nameOf = (id: string) => targets.find((t) => t.id === id)?.name ?? (id || "local");

  // newest first, every machine
  const sessions = useMemo(() => [...all].sort((a, b) => b.createdAt - a.createdAt), [all]);
  const shown = useMemo(() => (filterNode === "*" ? sessions : sessions.filter((s) => s.node === filterNode)), [sessions, filterNode]);
  const current = sessions.find((s) => s.id === active && s.node === activeNode) ?? null;
  // An unselected filtered link defaults within that machine. An explicit
  // session/node still names its own content independently of the tab filter.
  const defaultNode = params.has("node") ? activeNode : filterNode !== "*" ? filterNode : null;
  const selectionNode = !active && !adding && defaultNode !== null ? defaultNode : activeNode;
  const selectedState = states.find(s => s.node === selectionNode);
  const unknownNode = !!selectionNode && !!nodes && !nodes.nodes.some(n => n.id === selectionNode);
  const unknownFilter = filterNode !== "*" && !!filterNode && !!nodes && !nodes.nodes.some(n => n.id === filterNode);
  const selectedReady = unknownNode || !!fleetError && !!selectionNode && !nodes || !!selectedState && (selectedState.answered || !selectedState.online);
  const allReady = states.length >= (nodes ? nodes.nodes.length + 1 : 1) && states.every(s => s.answered || !s.online);
  const selectionError = !current && selectedReady && (unknownNode ? "Machine not found" : selectedState?.errorStatus === 401 || selectedState?.errorStatus === 403 ? "Access denied"
    : selectedState?.error || !active && selectedState?.seedError || !!selectionNode && !nodes && fleetError ? "Sessions unavailable" : "");
  const defaultUnavailable = !active && !adding && defaultNode === null && allReady && !sessions.length && (!!fleetError || states.some(s => s.error || s.seedError));
  const seedSelected = !adding && active.startsWith("seed-") && !unknownNode;
  const local401 = states.find((s) => s.node === "")?.errorStatus === 401 || fleetError?.status === 401;
  useEffect(() => { if (local401) onLocked?.(); }, [local401, onLocked]);
  // the machine the new-session form targets: the one chosen, else the current session's, else the URL's (= this one
  // when absent). Never a fallback to another machine: an unknown node id fails at the daemon, not silently elsewhere.
  const target = params.get("target");
  const formNode = target === "self" ? "" : target || activeNode;
  const formTarget = targets.find((t) => t.id === formNode) ?? { id: formNode, name: nameOf(formNode), online: !nodes, self: formNode === "" };

  // Drafts describe a pending operation, not navigable content. Keep them in
  // the authenticated shell, scoped to machine and the link's cwd prefill.
  // They never enter URLs, history state, browser storage or another machine.
  const draftKey = JSON.stringify([formNode, params.get("cwd") ?? ""]);
  const draft = drafts.values.get(draftKey) ?? { cwd: params.get("cwd") ?? "", cmd: "" };
  const newCwd = draft.cwd, newCmd = draft.cmd;
  const setDraft = (patch: Partial<typeof draft>) => {
    drafts.values.set(draftKey, { ...draft, ...patch });
    renderDraft(n => n + 1);
  };
  const setNewCwd = (cwd: string) => setDraft({ cwd });
  const setNewCmd = (cmd: string) => setDraft({ cmd });

  // Defaults have one spelling; preserve unknown machine IDs so errors stay shareable.
  useEffect(() => {
    const canonical: Record<string, string | null> = {};
    if (filter === "*" || params.has("filter") && !filter) canonical.filter = null;
    if (target !== null && (!adding || !target || (target === "self" ? "" : target) === activeNode)) canonical.target = null;
    if (Object.keys(canonical).length) updateParams(canonical, "replace");
  }, [filter, target, adding, activeNode]);
  const openForm = () => updateParams({ new: "1", cwd: null, target: null });
  const closeForm = () => updateParams({ new: null, cwd: null, target: null });
  const selectSession = (session: LiveSession, mode: "push" | "replace" = "push") => navigate("term", {
    session: session.id, node: session.node || undefined, filter: filter || undefined,
  }, mode);
  const create = async (cwd: string, cmd?: string, node: string = formNode) => {
    if (drafts.pending.has(draftKey)) return;
    const nodeName = nameOf(node), requestedHash = routeHash("term", params);
    const submittedDraft = drafts.values.get(draftKey), generation = drafts.generation;
    drafts.pending.add(draftKey); renderDraft(n => n + 1);
    const stillHere = () => drafts.generation === generation && location.hash === requestedHash;
    try {
      const caps = await getCaps(node);
      const s = await createSession(node, nodeName, { cwd: cwd || undefined, cmd: cmd || undefined, runner: caps?.tmux ? "tmux" : "pty" });
      rememberCwd(s.cwd);
      // Do not erase text typed while the explicit Open request was pending.
      if (drafts.generation === generation && drafts.values.get(draftKey) === submittedDraft) drafts.values.delete(draftKey);
      replace(node, [...all.filter((x) => x.node === node), s]);
      if (stillHere()) navigate("term", { session: s.id, node: node || undefined, filter: filter || undefined });
    } catch (e) {
      if (stillHere()) {
        if ((e as { status?: number }).status === 401 && !node) onLocked?.();
        setErr(`could not start on ${nodeName}: ${e instanceof Error ? e.message : e}`);
      }
    } finally {
      if (drafts.generation === generation) { drafts.pending.delete(draftKey); renderDraft(n => n + 1); }
    }
  };

  // A shareable URL describes a view; opening/reloading it must never create a process: `cwd` only prefills the form.
  useEffect(() => {
    if (active || adding || local401) return;
    // A fast local answer cannot decide that a slower selected peer is empty.
    if (defaultNode !== null ? !selectedReady || !!selectionError : !allReady || defaultUnavailable) return;
    // `#/term?node=<id>` without a session: that machine's newest session, else a new one there
    const pool = defaultNode !== null ? sessions.filter((s) => s.node === defaultNode) : sessions;
    if (pool.length) selectSession(pool[0], "replace");
    else updateParams({ new: "1", target: defaultNode !== null && defaultNode !== activeNode ? defaultNode || "self" : null }, "replace");
  }, [allReady, selectedReady, selectionError, defaultUnavailable, sessions, active, adding, activeNode, defaultNode, local401]);

  const close = async (s: LiveSession) => {
    if (s.state === "running" && !(await confirmAction(s.tool === "seed" ? `Delete conversation “${s.title}” on ${s.nodeName} and its messages?` : `Kill session “${s.title}” on ${s.nodeName}? Anything running in it stops.`))) return;
    try { await removeSession(s.node, s.id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return; }
    const rest = sessions.filter((x) => !(x.id === s.id && x.node === s.node));
    replace(s.node, all.filter((x) => x.node === s.node && x.id !== s.id));
    if (current && current.id === s.id && current.node === s.node) { if (rest[0]) navigate("term", { session: rest[0].id, node: rest[0].node || undefined }); else { navigate("term", { new: "1" }); } }
  };
  const cwdOptions = useMemo(() => Array.from(new Set([...recentCwds(), ...projectDirs(overview)])), [overview, adding]);
  const currentKey = current ? `${current.node}:${current.id}` : "";
  const currentStateTitle = current?.state === "lost" ? "Lost · "
    : current?.state === "exited" || statuses[currentKey] === "exited" ? "Exited · "
    : statuses[currentKey] === "closed" ? "Disconnected · " : "";
  useRouteTitle(adding ? `New session on ${formTarget.name}` : unknownNode ? `Machine not found · Sessions`
    : seedSelected ? undefined : current ? `${currentStateTitle}${current.title} · ${current.nodeName} · Sessions`
    : defaultUnavailable ? "Sessions unavailable"
    : selectionError ? `${selectionError} · ${nameOf(selectionNode)}`
    : selectedReady && active ? "Session not found" : active || defaultNode !== null ? `Loading sessions · ${nameOf(selectionNode)}` : undefined);
  const led = (s: LiveSession) => (s.state !== "running" ? "led-off" : statuses[`${s.node}:${s.id}`] === "connecting" ? "led-warn" : s.busy ? "led-run" : "led-on");
  const problems = states.filter((s) => s.error || s.seedError);

  return (
    <div className="flex h-full flex-col">
      <div className="hud-chrome flex items-center gap-1 overflow-x-auto border-b px-2 py-1">
        <span className="hud-label neon mr-2 hidden whitespace-nowrap sm:inline">Sessions</span>
        {(targets.length > 1 || unknownFilter) && <NodePicker value={filterNode} onChange={node => updateParams({ filter: node === "*" ? null : node || "self" })} targets={targets} all="every machine" testId="term-filter-node" title="show sessions on" className="mr-1 hidden sm:inline" />}
        {shown.map((t) => (
          <div key={`${t.node}:${t.id}`} className={`group flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] ${current === t && !adding ? "border-sky-500/40 bg-sky-500/10 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-200"}`} data-testid="term-tab" data-session={t.id} data-node={t.node}>
            <span className={`led ${led(t)}`} />
            {t.tool !== "shell" && <span className={`rounded px-1 text-[9px] ${t.tool === "cc" ? "bg-orange-500/15 text-orange-300" : "bg-sky-500/15 text-sky-300"}`}>{t.tool}</span>}
            {editing === `${t.node}:${t.id}` ? (
              <input autoFocus defaultValue={t.title} onBlur={async (e) => { const v = e.target.value.trim(); setEditing(null); if (v && v !== t.title) { try { await renameSession(t.node, t.id, v); } catch {} } }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="w-32 bg-transparent font-mono outline-none" />
            ) : (
              <button onClick={() => { selectSession(t); }} onDoubleClick={() => setEditing(`${t.node}:${t.id}`)} className="max-w-[180px] truncate font-mono" title={`${t.nodeName} · ${shortCwd(t.cwd)}${t.cmd ? ` · ${t.cmd}` : ""} · ${t.runner}${t.state !== "running" ? ` · ${t.state}` : ""}`}>{t.title}</button>
            )}
            {t.node !== "" && <NodeTag name={t.nodeName} />}
            <button onClick={() => close(t)} className="text-zinc-600 hover:text-red-400" title={t.state === "running" ? `kill session on ${t.nodeName}` : "remove"}>×</button>
          </div>
        ))}
        <button onClick={openForm} data-testid="term-new" className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[12px] ${adding ? "border-sky-500/40 text-sky-300" : "border-zinc-800 text-zinc-400 hover:text-zinc-100"}`} title="new session">+</button>
        {current && <span className="ml-auto hidden shrink-0 pl-3 font-mono text-[10px] text-zinc-600 md:inline" title="this session's machine and working directory" data-testid="term-status">{current.nodeName} · {shortCwd(current.cwd)} · {current.runner}{current.clients > 1 ? ` · ${current.clients} viewers` : ""} · <span className={statuses[currentKey] === "live" ? "text-emerald-400" : ""}>{current.state !== "running" ? current.state : (current.tool === "seed" ? current.busy ? "working" : "ready" : statuses[currentKey] ?? "connecting")}</span></span>}
      </div>
      {unknownFilter && <div role="alert" className="border-b border-amber-500/20 px-3 py-2 text-xs text-amber-300" data-testid="term-filter-error">No paired machine {filterNode} for this session filter.</div>}
      {fleetError && <div role="alert" className="border-b border-amber-500/20 px-3 py-2 text-xs text-amber-300" data-testid="term-fleet-error">Cannot read the fleet. {fleetError.message}</div>}
      {err && <div className="border-b border-red-500/20 bg-red-500/5 px-3 py-1 text-[11px] text-red-300">{err}</div>}
      {problems.length > 0 && (
        <div className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-200/80" data-testid="term-node-errors">
          {problems.map((p) => <span key={p.node} className="mr-3">{p.nodeName}: {p.error ?? `Seed server: ${p.seedError}`}{p.error && all.some((s) => s.node === p.node) ? " (showing its last known sessions)" : ""}</span>)}
        </div>
      )}
      {adding && (
        <div className="hud-card m-3 p-4" data-testid="term-new-form">
          <div className="flex flex-wrap items-center gap-2">
            <div className="hud-label neon">New session on</div>
            <NodePicker value={formNode} onChange={node => updateParams({ target: node === activeNode ? null : node || "self" })} targets={targets} testId="term-new-node" title="which machine runs this session" />
          </div>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); create(newCwd.trim(), newCmd.trim()); }}>
            <input list="cwd-options" value={newCwd} onChange={(e) => setNewCwd(e.target.value)} placeholder={`working directory on ${formTarget.name} (default: home)`} className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
            <datalist id="cwd-options">{cwdOptions.map((c) => <option key={c} value={c} />)}</datalist>
            <input value={newCmd} onChange={(e) => setNewCmd(e.target.value)} placeholder="startup command (optional), e.g. claude --dangerously-skip-permissions" className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
            <button className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10" disabled={!formTarget.online || drafts.pending.has(draftKey)} data-testid="term-new-open">Open</button>
            {sessions.length > 0 && <button type="button" onClick={closeForm} className="rounded-sm border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">Cancel</button>}
          </form>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {cwdOptions.slice(0, 10).map((c) => <button key={c} onClick={() => setNewCwd(c)} className="rounded-sm border border-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400 hover:text-zinc-100">{shortCwd(c)}</button>)}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-zinc-500">
            quick: <button onClick={() => setNewCmd("claude --dangerously-skip-permissions")} className="neon">cc</button> · <button onClick={() => setNewCmd("codex --yolo")} className="neon">cx</button> · <button onClick={() => setNewCmd("")} className="text-zinc-400">plain shell</button>
            <span className="ml-auto text-zinc-600">sessions keep running when you leave this view; tip: the prompt bar below starts agents with one line</span>
          </div>
        </div>
      )}
      {/* Seed's view needs only the id, so it opens before the session list catches up. */}
      {seedSelected && <NativeSeedSession key={`${activeNode}:${active}`} id={active} node={activeNode} />}
      {!adding && current && current.tool !== "seed" && (
        <TermPane key={currentKey} session={current} onStatus={(s) => setStatuses((m) => (m[currentKey] === s ? m : { ...m, [currentKey]: s }))} onRemove={() => close(current)} />
      )}
      {!adding && !current && !seedSelected && (selectionError || defaultUnavailable) && <div role="alert" className="p-6 text-xs text-amber-300" data-testid="term-unavailable">{unknownNode ? `No paired machine ${selectionNode}.` : defaultUnavailable ? "Cannot read sessions. Retry when a machine is available." : `Cannot read sessions on ${nameOf(selectionNode)}. ${selectedState?.error ?? fleetError?.message ?? ""}`}<button className="hud-badge ml-3 px-2 py-1" onClick={refresh}>Retry</button></div>}
      {!adding && !current && !seedSelected && !selectionError && selectedReady && active && <div className="p-6 text-xs text-zinc-500" data-testid="term-missing">No session {active} on {nameOf(activeNode)}. Pick one above.</div>}
      {!adding && !current && !seedSelected && !selectedReady && active && <div role="status" className="p-6 text-xs text-zinc-500">Reading sessions on {nameOf(activeNode)}…</div>}
    </div>
  );
}
