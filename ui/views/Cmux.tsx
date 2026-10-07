import { useEffect, useMemo, useRef, useState } from "react";
import { api, post, activeNode, activeNodeName, ApiError } from "../lib/api";
import type { Overview } from "../lib/control";
import { Panel, Empty } from "./Projects";

type Node = { kind: "window" | "workspace" | "pane" | "surface"; ref: string; uuid?: string; title?: string; type?: string; selected: boolean; focused: boolean; current: boolean; active: boolean; tty?: string; url?: string; children: Node[] };
type Tree = { available: boolean; running?: boolean; current?: string | null; error?: string; tree: Node[] };
const QUICK: [string, string][] = [["Enter", "Enter"], ["Esc", "Escape"], ["Tab", "Tab"], ["^C", "ctrl+c"], ["^D", "ctrl+d"], ["↑", "Up"], ["↓", "Down"], ["←", "Left"], ["→", "Right"]];

function flatten(nodes: Node[], out: Node[] = []): Node[] { for (const n of nodes) { out.push(n); flatten(n.children, out); } return out; }

export function Cmux({ onLocked }: { onLocked: () => void }) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [surface, setSurface] = useState<string>("");
  const [screen, setScreen] = useState("");
  const [scrollback, setScrollback] = useState(false);
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", cwd: "", command: "" });
  const [dirs, setDirs] = useState<string[]>([]);
  const screenRef = useRef<HTMLPreElement>(null);

  const load = async () => {
    try { const t = await api<Tree>("/api/cmux/tree"); setTree(t); } catch (e) { if (e instanceof ApiError && e.status === 401) onLocked(); else setTree({ available: false, error: String(e instanceof Error ? e.message : e), tree: [] }); }
  };
  useEffect(() => { load(); const iv = setInterval(load, 5000); return () => clearInterval(iv); }, []);
  useEffect(() => {
    api<Overview>("/api/control/overview").then((o) => { const home = o.fleetDir.replace(/\/Code\/[^/]+$/, ""); setDirs(Array.from(new Set(o.projects.flatMap((p) => p.repos.filter((g) => !g.includes("*")).map((g) => `${home}/Code/${g}`))))); }).catch(() => {});
  }, []);

  const all = useMemo(() => (tree ? flatten(tree.tree) : []), [tree]);
  const surfaces = useMemo(() => all.filter((n) => n.kind === "surface"), [all]);
  useEffect(() => { if (!surface && surfaces.length) setSurface((surfaces.find((s) => s.active) ?? surfaces.find((s) => s.selected) ?? surfaces[0]).ref); }, [surfaces.length]);
  const workspaceOf = (ref: string): Node | undefined => { for (const w of all.filter((n) => n.kind === "workspace")) if (flatten(w.children).some((n) => n.ref === ref)) return w; return undefined; };

  useEffect(() => {
    if (!surface) return;
    let alive = true;
    const tick = async () => {
      try { const r = await api<{ text: string }>(`/api/cmux/screen?surface=${encodeURIComponent(surface)}&lines=${scrollback ? 1000 : 200}${scrollback ? "&scrollback=1" : ""}`); if (alive) setScreen(r.text); } catch (e) { if (alive) setScreen(`(${e instanceof Error ? e.message : e})`); }
    };
    tick();
    const iv = setInterval(() => { if (document.visibilityState === "visible") tick(); }, 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [surface, scrollback]);
  useEffect(() => { if (screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight; }, [screen]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try { const r: any = await fn(); setMsg(r?.ok === false ? `${label}: ${r.error}` : `${label}: ok`); setTimeout(load, 400); } catch (e) { setMsg(`${label} failed: ${e instanceof Error ? e.message : e}`); }
  };
  const send = () => { if (!surface) return; const text = input; setInput(""); act("send", () => post("/api/cmux/send", { surface, text, enter: true })); };
  const key = (k: string) => surface && act(k, () => post("/api/cmux/key", { surface, key: k }));
  const ws = surface ? workspaceOf(surface) : undefined;

  const renderNode = (n: Node, depth: number) => (
    <div key={n.ref}>
      {n.kind !== "window" && (
        <button
          onClick={() => { if (n.kind === "surface") setSurface(n.ref); else { const first = flatten(n.children).find((x) => x.kind === "surface" && (x.selected || x.active)) ?? flatten(n.children).find((x) => x.kind === "surface"); if (first) setSurface(first.ref); } }}
          className={`hud-row flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[11px] ${surface === n.ref ? "bg-sky-500/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-testid={`cmux-${n.kind}`}
        >
          <span className={`led shrink-0 ${n.active ? "led-run" : n.selected || n.focused ? "led-on" : "led-off"}`} />
          <span className="shrink-0 font-mono text-[10px] text-zinc-600">{n.ref}</span>
          {n.type && n.type !== "terminal" && <span className="hud-badge px-1 text-[9px]">{n.type}</span>}
          <span className="min-w-0 flex-1 truncate font-mono">{n.title ?? (n.kind === "pane" ? "pane" : "")}</span>
        </button>
      )}
      {n.children.map((c) => renderNode(c, n.kind === "window" ? depth : depth + 1))}
    </div>
  );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">cmux{activeNode() ? ` on ${activeNodeName()}` : ""}</h1>
            <p className="text-xs text-zinc-500">{tree ? tree.available ? tree.running ? `${all.filter((n) => n.kind === "workspace").length} workspaces · ${surfaces.length} surfaces · current ${tree.current ?? "?"}` : tree.error ?? "cmux is not running" : "cmux is not installed on this node" : "loading…"}</p>
          </div>
          <div className="flex items-center gap-2">
            {msg && <span className="text-[11px] text-zinc-400" data-testid="cmux-msg">{msg}</span>}
            <button onClick={() => setCreating((v) => !v)} className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10">New workspace</button>
          </div>
        </header>
        {creating && (
          <form className="hud-card mt-4 grid gap-2 p-4 sm:grid-cols-[160px_1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); act("new workspace", () => post("/api/cmux/workspace", { ...form, focus: false })); setCreating(false); }}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="name" className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none" />
            <input list="cmux-dirs" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} placeholder="cwd (absolute path)" className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none" />
            <datalist id="cmux-dirs">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
            <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="command (optional), e.g. claude --dangerously-skip-permissions" className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none" />
            <button className="hud-badge neon-green px-3 py-1.5">Create</button>
          </form>
        )}
        {tree && !tree.available && <div className="mt-6 hud-card p-6 text-sm text-zinc-400">cmux is not installed on this node. Install it from cmux.dev, or switch nodes with the selector in the title bar.</div>}
        {tree?.available && (
          <div className="mt-5 grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
            <Panel title="Windows · workspaces · surfaces">
              {tree.tree.length === 0 && <Empty>{tree.error ?? "No windows."}</Empty>}
              <div className="max-h-[70vh] overflow-auto">{tree.tree.map((n) => renderNode(n, 0))}</div>
            </Panel>
            <Panel
              title={surface ? `${surface}${ws ? ` · ${ws.title ?? ws.ref}` : ""}` : "Screen"}
              right={
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[10px] text-zinc-500"><input type="checkbox" checked={scrollback} onChange={(e) => setScrollback(e.target.checked)} />scrollback</label>
                  {ws && <button onClick={() => act("focus", () => post("/api/cmux/select", { workspace: ws.ref }))} className="hud-badge px-2 py-1 text-zinc-300 hover:text-zinc-100">Focus in cmux</button>}
                  {ws && <button onClick={() => { if (confirm(`Close workspace ${ws.title ?? ws.ref}?`)) act("close", () => post("/api/cmux/close", { workspace: ws.ref })); }} className="hud-badge neon-red px-2 py-1">Close</button>}
                </div>
              }
            >
              {!surface && <Empty>Select a surface on the left.</Empty>}
              {surface && (
                <>
                  <pre ref={screenRef} className="hud-cursor max-h-[55vh] min-h-[200px] w-full overflow-auto whitespace-pre rounded-sm border border-sky-500/10 bg-[#07080c] p-3 font-mono text-[11px] leading-snug text-zinc-200" data-testid="cmux-screen">{screen || " "}</pre>
                  <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
                    <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="type a line and press Enter to send it to this surface" data-testid="cmux-input" className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
                    <button className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10">Send</button>
                  </form>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {QUICK.map(([label, k]) => <button key={k} onClick={() => key(k)} className="rounded-sm border border-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-300 hover:border-sky-500/40 hover:text-zinc-100">{label}</button>)}
                  </div>
                </>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
