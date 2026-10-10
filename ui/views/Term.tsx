import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { activeNode, activeNodeName, navigate, api, wsUrl } from "../lib/api";
import { recentCwds, rememberCwd, shortCwd } from "../lib/terms";
import { messageRequestId, apiOn, attachUrl, createSession, getCaps, removeSession, renameSession, type LiveSession } from "../lib/sessions";
import type { Overview } from "../lib/control";
import "@xterm/xterm/css/xterm.css";

// Seed sessions on this node render with Seed's own agents UI (see SeedAgents.tsx); loaded on first use.
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

type QueryEvent = { seq: number; event: { type?: string; role?: string; content?: string; message?: string } };
type QueryTranscript = { session: { status: string; continuedTo?: { sessionId: string } }; events: QueryEvent[]; hasMoreBefore?: boolean };

/** A Seed session on this node, in Seed's agents UI: tool calls, runs, plan, sub-sessions, model and stop/retry. */
function NativeSeedSession({ id }: { id: string }) {
  const sessionId = id.replace(/^seed-/, "");
  return (
    <Suspense fallback={<div className="p-6 text-xs text-zinc-500">Loading Seed agents…</div>}>
      <SeedAgentsEmbed
        route={{ key: "agent-session", sessionId }}
        onRouteChange={(next, _mode, path) => {
          // Stay in Sessions for this session; anything else (the agent, a run, another session) opens the Seed view.
          if (next.key === "agent-session" && next.sessionId === sessionId) return;
          navigate("seed", { r: path });
        }}
      />
    </Suspense>
  );
}

/** Persistent Seed conversation on a remote node, with transcript history and follow-up messages. */
function SeedPane({ session }: { session: LiveSession }) {
  const [data, setData] = useState<QueryTranscript | null>(null);
  const [events, setEvents] = useState<QueryEvent[]>([]);
  const [more, setMore] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const requestId = useRef<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const path = `/api/sessions/${session.id}`;
  const mergeEvents = (incoming: QueryEvent[]) => setEvents((prev) => [...new Map([...prev, ...incoming].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq));
  useEffect(() => {
    let alive = true;
    let pending = false;
    let initialized = false;
    const load = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const r = await apiOn<QueryTranscript>(session.node, `${path}/transcript`);
        if (alive) { setData(r); mergeEvents(r.events); if (!initialized) { setMore(!!r.hasMoreBefore); initialized = true; } }
      } catch (e) { if (alive) setError(`Could not refresh: ${e instanceof Error ? e.message : e}`); }
      finally { pending = false; }
    };
    load();
    const timer = setInterval(load, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [session.node, path]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [events]);
  const post = (suffix: string, body: unknown) => apiOn(session.node, `${path}/${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true); setError(null);
    requestId.current ??= messageRequestId();
    try {
      await post("message", { text, clientMessageId: requestId.current });
      setText(""); requestId.current = null; follow.current = true;
      const r = await apiOn<QueryTranscript>(session.node, `${path}/transcript`); setData(r); mergeEvents(r.events);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); }
  };
  const earlier = async () => {
    setLoadingEarlier(true);
    try { const r = await apiOn<QueryTranscript>(session.node, `${path}/transcript?beforeSeq=${events[0]?.seq ?? 1}`); follow.current = false; mergeEvents(r.events); setMore(!!r.hasMoreBefore); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoadingEarlier(false); }
  };
  const busy = data?.session.status === "streaming";
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="seed-conversation">
    <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
      <span className="text-emerald-300">Seed agents</span><span>on {session.nodeName}</span>
      <span className="ml-auto" role="status">{data?.session.status ?? "Connecting…"}</span>
      {busy && <button className="hud-badge px-2 py-1 text-red-300" onClick={() => post("stop", {}).catch((e) => setError(e.message))}>Stop</button>}
    </div>
    <div ref={scroll} onScroll={() => { const el = scroll.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        {more && <button disabled={loadingEarlier} onClick={earlier} className="text-xs text-sky-300">{loadingEarlier ? "Loading…" : "Load earlier messages"}</button>}
        {events.filter((e) => e.event.type === "message" && ["user", "assistant"].includes(e.event.role ?? "") && typeof e.event.content === "string").map((e) => <article key={e.seq} className={`rounded-sm border p-4 ${e.event.role === "user" ? "border-zinc-800 bg-zinc-900/50" : "border-emerald-900/50"}`}>
          <div className="mb-2 text-xs uppercase tracking-widest text-zinc-500">{e.event.role === "user" ? "You" : "Seed"}</div>
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">{e.event.content}</div>
        </article>)}
        {!events.length && <div className="py-8 text-center text-sm text-zinc-500">{data ? "Send a message to begin this conversation." : "Loading conversation…"}</div>}
        {busy && <div className="text-xs text-emerald-300" role="status">Seed is working…</div>}
        {events.filter((e) => e.event.type === "error").map((e) => <div key={e.seq} role="alert" className="text-sm text-red-300">{e.event.message}</div>)}
        {data?.session.continuedTo && <button className="text-left text-sm text-sky-300" onClick={() => navigate("term", { session: `seed-${data.session.continuedTo!.sessionId}` })}>Open continued conversation →</button>}
      </div>
    </div>
    {error && <div role="alert" className="px-4 py-2 text-xs text-red-300">{error}</div>}
    <form className="flex items-end gap-2 border-t border-zinc-800 p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <textarea aria-label="Reply to Seed" value={text} maxLength={8000} disabled={sending || !!data?.session.continuedTo} onChange={(e) => { setText(e.target.value); requestId.current = null; }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} rows={2} placeholder="Continue this conversation…" className="min-w-0 flex-1 resize-none rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
      <button disabled={!text.trim() || sending || !!data?.session.continuedTo} className="hud-badge px-3 py-2 text-emerald-300 disabled:opacity-40">{sending ? "Sending…" : "Send"}</button>
    </form>
  </div>;
}

export function Term({ params }: { params: URLSearchParams }) {
  const node = activeNode();
  const nodeName = node ? activeNodeName() : "local";
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [adding, setAdding] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [newCmd, setNewCmd] = useState("");
  const [projectDirs, setProjectDirs] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const active = params.get("session") ?? "";

  const load = async () => {
    try {
      const r = await apiOn<{ sessions: Omit<LiveSession, "node" | "nodeName">[]; seedError?: string }>(node, "/api/sessions");
      setSessions(r.sessions.map((s) => ({ ...s, node, nodeName })).reverse());
      setErr(r.seedError ? `Seed server: ${r.seedError}` : null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSessions([]); }
  };
  useEffect(() => {
    load();
    const iv = setInterval(load, 4000);
    if (node) return () => clearInterval(iv);
    // local sessions also push changes over the event bus (remote ones rely on the poll)
    const ws = new WebSocket(wsUrl("/api/events"));
    ws.onmessage = (m) => { try { if (JSON.parse(m.data).kind === "sessions") load(); } catch {} };
    return () => { clearInterval(iv); ws.close(); };
  }, [node]);

  const create = async (cwd: string, cmd?: string) => {
    try {
      const caps = await getCaps(node);
      const s = await createSession(node, nodeName, { cwd: cwd || undefined, cmd: cmd || undefined, runner: caps?.tmux ? "tmux" : "pty" });
      rememberCwd(s.cwd);
      setAdding(false); setNewCmd("");
      await load();
      navigate("term", { session: s.id });
    } catch (e) { setErr(`could not start: ${e instanceof Error ? e.message : e}`); }
  };

  // Deep links: #/term?cwd=… opens a shell there; no session selected → pick the newest, or offer the form.
  useEffect(() => {
    const cwd = params.get("cwd");
    if (cwd && !active) { create(cwd); return; }
  }, [params]);
  useEffect(() => {
    if (!sessions) return;
    if (active && sessions.some((s) => s.id === active)) { setAdding(false); return; }
    if (!active && sessions.length && !params.get("cwd")) { navigate("term", { session: sessions[0].id }); return; }
    if (!sessions.length && !params.get("cwd")) setAdding(true);
  }, [sessions, active]);

  useEffect(() => {
    api<Overview>("/api/control/overview").then((o) => {
      const home = o.fleetDir.replace(/\/Code\/[^/]+$/, "");
      const dirs = new Set<string>([`${home}/Code`]);
      for (const p of o.projects) for (const g of p.repos) if (!g.includes("*")) dirs.add(`${home}/Code/${g}`);
      setProjectDirs([...dirs]);
    }).catch(() => {});
  }, []);

  const close = async (s: LiveSession) => {
    if (s.state === "running" && !confirm(s.tool === "seed" ? `Delete conversation “${s.title}” and its messages?` : `Kill session “${s.title}”? Anything running in it stops.`)) return;
    try { await removeSession(node, s.id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return; }
    const rest = (sessions ?? []).filter((x) => x.id !== s.id);
    setSessions(rest);
    if (active === s.id) { if (rest[0]) navigate("term", { session: rest[0].id }); else { navigate("term"); setAdding(true); } }
  };
  const cwdOptions = useMemo(() => Array.from(new Set([...recentCwds(), ...projectDirs])), [projectDirs, adding]);
  const current = sessions?.find((s) => s.id === active) ?? null;
  const led = (s: LiveSession) => (s.state !== "running" ? "led-off" : statuses[s.id] === "connecting" ? "led-warn" : s.busy ? "led-run" : "led-on");

  return (
    <div className="flex h-full flex-col">
      <div className="hud-chrome flex items-center gap-1 overflow-x-auto border-b px-2 py-1">
        <span className="hud-label neon mr-2 hidden whitespace-nowrap sm:inline">Sessions{node ? ` @ ${activeNodeName()}` : ""}</span>
        {(sessions ?? []).map((t) => (
          <div key={t.id} className={`group flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] ${active === t.id && !adding ? "border-sky-500/40 bg-sky-500/10 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-200"}`} data-testid="term-tab" data-session={t.id}>
            <span className={`led ${led(t)}`} />
            {t.tool !== "shell" && <span className={`rounded px-1 text-[9px] ${t.tool === "cc" ? "bg-orange-500/15 text-orange-300" : "bg-sky-500/15 text-sky-300"}`}>{t.tool}</span>}
            {editing === t.id ? (
              <input autoFocus defaultValue={t.title} onBlur={async (e) => { const v = e.target.value.trim(); setEditing(null); if (v && v !== t.title) { try { await renameSession(node, t.id, v); } catch {} load(); } }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="w-32 bg-transparent font-mono outline-none" />
            ) : (
              <button onClick={() => { setAdding(false); navigate("term", { session: t.id }); }} onDoubleClick={() => setEditing(t.id)} className="max-w-[180px] truncate font-mono" title={`${shortCwd(t.cwd)}${t.cmd ? ` · ${t.cmd}` : ""} · ${t.runner}${t.state !== "running" ? ` · ${t.state}` : ""}`}>{t.title}</button>
            )}
            <button onClick={() => close(t)} className="text-zinc-600 hover:text-red-400" title={t.state === "running" ? "kill session" : "remove"}>×</button>
          </div>
        ))}
        <button onClick={() => setAdding(true)} data-testid="term-new" className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[12px] ${adding ? "border-sky-500/40 text-sky-300" : "border-zinc-800 text-zinc-400 hover:text-zinc-100"}`} title="new session">+</button>
        {current && <span className="ml-auto hidden shrink-0 pl-3 font-mono text-[10px] text-zinc-600 md:inline" title="this session's working directory" data-testid="term-status">{shortCwd(current.cwd)} · {current.runner}{current.clients > 1 ? ` · ${current.clients} viewers` : ""} · <span className={statuses[current.id] === "live" ? "text-emerald-400" : ""}>{current.state !== "running" ? current.state : (current.tool === "seed" ? current.busy ? "working" : "ready" : statuses[current.id] ?? "connecting")}</span></span>}
      </div>
      {err && <div className="border-b border-red-500/20 bg-red-500/5 px-3 py-1 text-[11px] text-red-300">{err}</div>}
      {adding && (
        <div className="hud-card m-3 p-4" data-testid="term-new-form">
          <div className="hud-label neon">New session{node ? ` on ${activeNodeName()}` : ""}</div>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); create(newCwd.trim(), newCmd.trim()); }}>
            <input list="cwd-options" value={newCwd} onChange={(e) => setNewCwd(e.target.value)} placeholder="working directory (default: home)" className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
            <datalist id="cwd-options">{cwdOptions.map((c) => <option key={c} value={c} />)}</datalist>
            <input value={newCmd} onChange={(e) => setNewCmd(e.target.value)} placeholder="startup command (optional), e.g. claude --dangerously-skip-permissions" className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
            <button className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10">Open</button>
            {(sessions?.length ?? 0) > 0 && <button type="button" onClick={() => setAdding(false)} className="rounded-sm border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">Cancel</button>}
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
      {/* A local Seed session opens before the session list has caught up with it: Seed's view only needs the id. */}
      {!adding && !node && active.startsWith("seed-") && <NativeSeedSession key={active} id={active} />}
      {!adding && current && !(current.tool === "seed" && !current.node) && (
        current.tool === "seed" ? <SeedPane key={`${current.node}:${current.id}`} session={current} /> : <TermPane key={`${current.node}:${current.id}`} session={current} onStatus={(s) => setStatuses((m) => (m[current.id] === s ? m : { ...m, [current.id]: s }))} onRemove={() => close(current)} />
      )}
      {!adding && !current && sessions && sessions.length > 0 && active && !(!node && active.startsWith("seed-")) && <div className="p-6 text-xs text-zinc-500">No session {active} on {nodeName}. Pick one above.</div>}
    </div>
  );
}
