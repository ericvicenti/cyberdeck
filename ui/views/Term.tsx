import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { termWsUrl, activeNode, activeNodeName, navigate, api } from "../lib/api";
import { listTabs, addTab, removeTab, renameTab, recentCwds, type TermTab } from "../lib/terms";
import type { Overview } from "../lib/control";
import "@xterm/xterm/css/xterm.css";

/** One PTY session. Stays mounted while hidden so the shell survives tab switches. */
function TermPane({ tab, visible, onStatus }: { tab: TermTab; visible: boolean; onStatus: (s: "connecting" | "live" | "closed") => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctrl = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#07080c", foreground: "#d4d4d8", cursor: "#22d3ee", selectionBackground: "#164e63" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    fitRef.current = fit;
    fit.fit();

    const ws = new WebSocket(termWsUrl(tab.cwd ? { cwd: tab.cwd } : {}));
    wsRef.current = ws;
    const set = (s: "connecting" | "live" | "closed") => { setStatus(s); onStatus(s); };
    set("connecting");
    ws.onopen = () => {
      set("live");
      ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      // Startup command: typed into the new shell as its first input (works through the node proxy).
      if (tab.cmd) ws.send(JSON.stringify({ t: "input", data: `${tab.cmd}\n` }));
      if (visible) term.focus();
    };
    ws.onmessage = (msg) => {
      try {
        const m = JSON.parse(msg.data);
        if (m.t === "data") term.write(m.data);
        if (m.t === "exit") term.write(`\r\n\x1b[90m[process exited ${m.code}]\x1b[0m\r\n`);
      } catch {}
    };
    ws.onclose = () => set("closed");
    ws.onerror = () => set("closed");
    const inputSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "input", data }));
    });
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.offsetParent === null) return; // hidden
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    });
    ro.observe(host.current);
    return () => { ro.disconnect(); inputSub.dispose(); ws.close(); term.dispose(); termRef.current = null; wsRef.current = null; };
  }, [tab.id, generation]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      fitRef.current?.fit();
      const term = termRef.current, ws = wsRef.current;
      if (term && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      term?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [visible]);

  const sendKey = (seq: string) => { const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "input", data: seq })); termRef.current?.focus(); };
  const key = (label: string, seq: string) => (
    <button key={label} onPointerDown={(e) => { e.preventDefault(); if (ctrl.current && seq.length === 1) { sendKey(String.fromCharCode(seq.toUpperCase().charCodeAt(0) - 64)); ctrl.current = false; } else sendKey(seq); }} className="rounded-sm border border-zinc-800 px-2 py-1 font-mono text-[11px] text-zinc-300 active:bg-zinc-800">{label}</button>
  );

  return (
    <div className={`${visible ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
      <div ref={host} className="min-h-0 flex-1 bg-[#07080c] p-2" data-testid="terminal-host" />
      {status === "closed" && (
        <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
          session closed
          <button onClick={() => setGeneration((g) => g + 1)} className="hud-badge neon px-2 py-0.5 hover:bg-sky-500/10">Reconnect</button>
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

export function Term({ params }: { params: URLSearchParams }) {
  const node = activeNode();
  const [tabs, setTabs] = useState<TermTab[]>(() => listTabs(node));
  const [active, setActive] = useState<string>(params.get("tab") ?? tabs[0]?.id ?? "");
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(tabs.length === 0 && !params.get("cwd"));
  const [newCwd, setNewCwd] = useState("");
  const [newCmd, setNewCmd] = useState("");
  const [projectDirs, setProjectDirs] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);

  // Legacy deep links (#/term?cwd=...) become a tab.
  useEffect(() => {
    const cwd = params.get("cwd");
    if (cwd && !params.get("tab")) { const t = addTab(node, { cwd }); setTabs(listTabs(node)); setActive(t.id); navigate("term", { tab: t.id }); }
  }, []);
  useEffect(() => { const t = params.get("tab"); if (t) setActive(t); setTabs(listTabs(node)); }, [params]);
  useEffect(() => {
    api<Overview>("/api/control/overview").then((o) => {
      const home = o.fleetDir.replace(/\/Code\/[^/]+$/, "");
      const dirs = new Set<string>([`${home}/Code`]);
      for (const p of o.projects) for (const g of p.repos) if (!g.includes("*")) dirs.add(`${home}/Code/${g}`);
      setProjectDirs([...dirs]);
    }).catch(() => {});
  }, []);

  const refresh = () => setTabs(listTabs(node));
  const create = (cwd: string, cmd?: string) => { const t = addTab(node, { cwd, cmd: cmd || undefined }); refresh(); setActive(t.id); setAdding(false); setNewCmd(""); navigate("term", { tab: t.id }); };
  const close = (id: string) => { removeTab(node, id); const rest = listTabs(node); setTabs(rest); if (active === id) setActive(rest[rest.length - 1]?.id ?? ""); if (!rest.length) setAdding(true); };
  const cwdOptions = useMemo(() => Array.from(new Set([...recentCwds(), ...projectDirs])), [projectDirs, adding]);

  return (
    <div className="flex h-full flex-col">
      <div className="hud-chrome flex items-center gap-1 overflow-x-auto border-b px-2 py-1">
        <span className="hud-label neon mr-2 hidden whitespace-nowrap sm:inline">Terminal{node ? ` @ ${activeNodeName()}` : ""}</span>
        {tabs.map((t) => (
          <div key={t.id} className={`group flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] ${active === t.id && !adding ? "border-sky-500/40 bg-sky-500/10 text-zinc-100" : "border-transparent text-zinc-400 hover:text-zinc-200"}`} data-testid="term-tab">
            <span className={`led ${statuses[t.id] === "live" ? "led-on" : statuses[t.id] === "closed" ? "led-off" : "led-warn"}`} />
            {editing === t.id ? (
              <input autoFocus defaultValue={t.title} onBlur={(e) => { renameTab(node, t.id, e.target.value || t.title); setEditing(null); refresh(); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="w-28 bg-transparent font-mono outline-none" />
            ) : (
              <button onClick={() => { setActive(t.id); setAdding(false); navigate("term", { tab: t.id }); }} onDoubleClick={() => setEditing(t.id)} className="font-mono" title={`${t.cwd}${t.cmd ? ` · ${t.cmd}` : ""}`}>{t.title}</button>
            )}
            <button onClick={() => close(t.id)} className="text-zinc-600 hover:text-red-400" title="close">×</button>
          </div>
        ))}
        <button onClick={() => setAdding(true)} data-testid="term-new" className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[12px] ${adding ? "border-sky-500/40 text-sky-300" : "border-zinc-800 text-zinc-400 hover:text-zinc-100"}`} title="new terminal">+</button>
      </div>
      {adding && (
        <div className="hud-card m-3 p-4" data-testid="term-new-form">
          <div className="hud-label neon">New terminal{node ? ` on ${activeNodeName()}` : ""}</div>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); create(newCwd.trim(), newCmd.trim()); }}>
            <input list="cwd-options" value={newCwd} onChange={(e) => setNewCwd(e.target.value)} placeholder="working directory (default: home)" className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
            <datalist id="cwd-options">{cwdOptions.map((c) => <option key={c} value={c} />)}</datalist>
            <input value={newCmd} onChange={(e) => setNewCmd(e.target.value)} placeholder="startup command (optional), e.g. claude --dangerously-skip-permissions" className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
            <button className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10">Open</button>
            {tabs.length > 0 && <button type="button" onClick={() => setAdding(false)} className="rounded-sm border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">Cancel</button>}
          </form>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {cwdOptions.slice(0, 10).map((c) => <button key={c} onClick={() => setNewCwd(c)} className="rounded-sm border border-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400 hover:text-zinc-100">{c.replace(/^\/(Users|home)\/[^/]+/, "~")}</button>)}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-zinc-500">
            quick: <button onClick={() => setNewCmd("claude --dangerously-skip-permissions")} className="neon">cc</button> · <button onClick={() => setNewCmd("codex --yolo")} className="neon">cx</button> · <button onClick={() => setNewCmd("")} className="text-zinc-400">plain shell</button>
          </div>
        </div>
      )}
      {tabs.map((t) => <TermPane key={t.id} tab={t} visible={!adding && active === t.id} onStatus={(s) => setStatuses((m) => (m[t.id] === s ? m : { ...m, [t.id]: s }))} />)}
    </div>
  );
}
