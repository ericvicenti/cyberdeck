import { updateParams, useRouteTitle } from "../lib/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiOn, postOn, navigate, routeNode } from "../lib/api";
import { useFleetQuery, useOverview, projectDirs } from "../lib/fleet";
import { nodeHealth } from "../../src/shared/fleetview";
import { NodePicker, NodeStrip, NodeTag } from "../components/NodePicker";
import { Panel, Empty } from "./Projects";

type Node = { kind: "window" | "workspace" | "pane" | "surface"; ref: string; uuid?: string; title?: string; type?: string; selected: boolean; focused: boolean; current: boolean; active: boolean; tty?: string; url?: string; children: Node[] };
type Tree = { available: boolean; running?: boolean; current?: string | null; error?: string; tree: Node[] };
const QUICK: [string, string][] = [["Enter", "Enter"], ["Esc", "Escape"], ["Tab", "Tab"], ["^C", "ctrl+c"], ["^D", "ctrl+d"], ["↑", "Up"], ["↓", "Down"], ["←", "Left"], ["→", "Right"]];

function flatten(nodes: Node[], out: Node[] = []): Node[] { for (const n of nodes) { out.push(n); flatten(n.children, out); } return out; }

/** cmux on every machine that runs it, in one tree; a surface is `${node}:${ref}` and every
 *  command goes to the machine that owns it. URL: `#/cmux?surface=<ref>&node=<id>`. */
export function Cmux({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const trees = useFleetQuery<Tree>("/api/cmux/tree", { intervalMs: 5000, onLocked });
  const { overview } = useOverview();
  const surfaceRef = params.get("surface") ?? "";
  const surfaceNode = routeNode(params);
  const [screen, setScreen] = useState("");
  const scrollback = params.get("scrollback") === "1";
  const setScrollback = (value: boolean) => updateParams({ scrollback: value ? "1" : null });
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ node: "", name: "", cwd: "", command: "" });
  const screenRef = useRef<HTMLPreElement>(null);
  const dirs = useMemo(() => projectDirs(overview), [overview]);

  // machines by what they said: running cmux, installed but not running, not installed, no answer
  const machines = useMemo(() => trees.results.map((r) => ({ node: r.node.id, nodeName: r.node.name, tree: r.data, error: r.error, loading: r.loading && !r.data })), [trees.results]);
  const running = machines.filter((m) => m.tree?.available && m.tree.running);
  const health = useMemo(() => nodeHealth(trees.results), [trees.results]);
  const runningTargets = useMemo(() => trees.targets.filter((t) => running.some((m) => m.node === t.id)), [trees.targets, running]);
  const allSurfaces = useMemo(() => running.flatMap((m) => flatten(m.tree!.tree).filter((n) => n.kind === "surface").map((n) => ({ node: m.node, nodeName: m.nodeName, n }))), [running]);
  const workspaceCount = running.reduce((n, m) => n + flatten(m.tree!.tree).filter((x) => x.kind === "workspace").length, 0);
  const answered = machines.some((m) => !m.loading);

  // default selection: the active surface of the first machine that answered (replace, not push)
  const selected = allSurfaces.find((s) => s.node === surfaceNode && s.n.ref === surfaceRef) ?? null;
  useEffect(() => {
    if (surfaceRef || !allSurfaces.length) return;
    const first = allSurfaces.find((s) => s.n.active) ?? allSurfaces.find((s) => s.n.selected) ?? allSurfaces[0];
    updateParams({ surface: first.n.ref, node: first.node || null }, "replace");
  }, [surfaceRef, allSurfaces.length]);
  const select = (node: string, ref: string) => navigate("cmux", { surface: ref, node: node || undefined, ...(scrollback ? { scrollback: "1" } : {}) });
  const workspaceOf = (node: string, ref: string): Node | undefined => { const m = running.find((x) => x.node === node); if (!m) return undefined; for (const w of flatten(m.tree!.tree).filter((n) => n.kind === "workspace")) if (flatten(w.children).some((n) => n.ref === ref)) return w; return undefined; };
  const surfaceMachine = machines.find((m) => m.node === surfaceNode);
  const missingSurface = !!surfaceRef && answered && !selected && (!surfaceMachine || !surfaceMachine.loading);
  useRouteTitle(missingSurface ? "Surface not found · cmux" : answered && running.length === 0 ? "cmux unavailable" : selected ? `${selected.n.title ?? surfaceRef} · cmux${selected.node ? ` · ${selected.nodeName}` : ""}` : undefined);

  useEffect(() => {
    setScreen("");
    if (!selected) return;
    let alive = true;
    const { node, n } = selected;
    const tick = async () => {
      try { const r = await apiOn<{ text: string }>(node, `/api/cmux/screen?surface=${encodeURIComponent(n.ref)}&lines=${scrollback ? 1000 : 200}${scrollback ? "&scrollback=1" : ""}`); if (alive) setScreen(r.text); } catch (e) { if (alive) setScreen(`(${e instanceof Error ? e.message : e})`); }
    };
    tick();
    const iv = setInterval(() => { if (document.visibilityState === "visible") tick(); }, 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [selected?.node, selected?.n.ref, scrollback]);
  useEffect(() => { if (screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight; }, [screen]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try { const r: any = await fn(); setMsg(r?.ok === false ? `${label}: ${r.error}` : `${label}: ok`); setTimeout(trees.refresh, 400); } catch (e) { setMsg(`${label} failed: ${e instanceof Error ? e.message : e}`); }
  };
  const send = () => { if (!selected) return; const text = input; setInput(""); act(`send to ${selected.nodeName}`, () => postOn(selected.node, "/api/cmux/send", { surface: selected.n.ref, text, enter: true })); };
  const key = (k: string) => selected && act(k, () => postOn(selected.node, "/api/cmux/key", { surface: selected.n.ref, key: k }));
  const ws = selected ? workspaceOf(selected.node, selected.n.ref) : undefined;
  const formNode = runningTargets.find((t) => t.id === form.node) ?? runningTargets[0];

  const renderNode = (node: string, n: Node, depth: number) => (
    <div key={`${node}:${n.ref}`}>
      {n.kind !== "window" && (
        <button
          onClick={() => { if (n.kind === "surface") select(node, n.ref); else { const first = flatten(n.children).find((x) => x.kind === "surface" && (x.selected || x.active)) ?? flatten(n.children).find((x) => x.kind === "surface"); if (first) select(node, first.ref); } }}
          className={`hud-row flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[11px] ${selected?.node === node && selected.n.ref === n.ref ? "bg-sky-500/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-testid={`cmux-${n.kind}`}
        >
          <span className={`led shrink-0 ${n.active ? "led-run" : n.selected || n.focused ? "led-on" : "led-off"}`} />
          <span className="shrink-0 font-mono text-[10px] text-zinc-600">{n.ref}</span>
          {n.type && n.type !== "terminal" && <span className="hud-badge px-1 text-[9px]">{n.type}</span>}
          <span className="min-w-0 flex-1 truncate font-mono">{n.title ?? (n.kind === "pane" ? "pane" : "")}</span>
        </button>
      )}
      {n.children.map((c) => renderNode(node, c, n.kind === "window" ? depth : depth + 1))}
    </div>
  );

  const idle = machines.filter((m) => !m.loading && !(m.tree?.available && m.tree.running));

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">cmux</h1>
            <p className="text-xs text-zinc-500">{trees.loading && !running.length ? "asking every machine…" : running.length ? `${running.length} machine${running.length === 1 ? "" : "s"} · ${workspaceCount} workspaces · ${allSurfaces.length} surfaces` : "cmux is not running on any reachable machine"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {msg && <span className="text-[11px] text-zinc-400" data-testid="cmux-msg">{msg}</span>}
            <NodeStrip health={health} testId="cmux-nodes" />
            {running.length > 0 && <button onClick={() => setCreating((v) => !v)} className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10">New workspace</button>}
          </div>
        </header>
        {missingSurface && <p role="alert" className="mt-4">Surface not found: {surfaceRef} on {surfaceMachine?.nodeName ?? (surfaceNode || "this machine")}. Select an available surface.</p>}
        {creating && formNode && (
          <form className="hud-card mt-4 grid gap-2 p-4 sm:grid-cols-[auto_160px_1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); act(`new workspace on ${formNode.name}`, () => postOn(formNode.id, "/api/cmux/workspace", { name: form.name, cwd: form.cwd, command: form.command, focus: false })); setCreating(false); }}>
            <NodePicker value={formNode.id} onChange={(node) => setForm({ ...form, node })} targets={runningTargets} testId="cmux-new-node" title="which machine's cmux" />
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="name" className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 outline-none" />
            <input list="cmux-dirs" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} placeholder={`cwd on ${formNode.name} (absolute path)`} className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none" />
            <datalist id="cmux-dirs">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
            <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="command (optional), e.g. claude --dangerously-skip-permissions" className="rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none" />
            <button className="hud-badge neon-green px-3 py-1.5">Create</button>
          </form>
        )}
        {idle.length > 0 && (
          <div className="mt-4 text-[11px] text-zinc-500" data-testid="cmux-idle">
            {idle.map((m) => <span key={m.node} className="mr-4">{m.nodeName}: {m.error && !m.tree ? `no answer (${m.error})` : !m.tree?.available ? "cmux not installed" : m.tree.error ?? "cmux not running"}</span>)}
          </div>
        )}
        {answered && !trees.loading && running.length === 0 && <div className="mt-6 hud-card p-6 text-sm text-zinc-400">No reachable machine is running cmux. Install it from cmux.dev on a Mac in the fleet; it appears here as soon as that machine answers.</div>}
        {running.length > 0 && (
          <div className="mt-5 grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
            <Panel title="Machines · workspaces · surfaces">
              <div className="max-h-[70vh] overflow-auto">
                {running.map((m) => (
                  <div key={m.node} data-testid={`cmux-host-${m.nodeName}`}>
                    <div className="flex items-center gap-2 px-1 pt-2 text-[10px] uppercase tracking-wider text-zinc-500"><NodeTag name={m.nodeName} self={m.node === ""} />current {m.tree!.current ?? "?"}{m.error ? <span className="text-amber-300/80" title={m.error}>· stale</span> : null}</div>
                    {m.tree!.tree.length === 0 && <Empty>{m.tree!.error ?? "No windows."}</Empty>}
                    {m.tree!.tree.map((n) => renderNode(m.node, n, 0))}
                  </div>
                ))}
              </div>
            </Panel>
            <Panel
              title={selected ? `${selected.n.ref} on ${selected.nodeName}${ws ? ` · ${ws.title ?? ws.ref}` : ""}` : "Screen"}
              right={
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[10px] text-zinc-500"><input type="checkbox" checked={scrollback} onChange={(e) => setScrollback(e.target.checked)} />scrollback</label>
                  {ws && selected && <button onClick={() => act("focus", () => postOn(selected.node, "/api/cmux/select", { workspace: ws.ref }))} className="hud-badge px-2 py-1 text-zinc-300 hover:text-zinc-100">Focus in cmux</button>}
                  {ws && selected && <button onClick={() => { if (confirm(`Close workspace ${ws.title ?? ws.ref} on ${selected.nodeName}?`)) act("close", () => postOn(selected.node, "/api/cmux/close", { workspace: ws.ref })); }} className="hud-badge neon-red px-2 py-1">Close</button>}
                </div>
              }
            >
              {!selected && <Empty>{surfaceRef ? `No surface ${surfaceRef} on ${surfaceMachine?.nodeName ?? "that machine"}.` : "Select a surface on the left."}</Empty>}
              {selected && (
                <>
                  <pre ref={screenRef} className="hud-cursor max-h-[55vh] min-h-[200px] w-full overflow-auto whitespace-pre rounded-sm border border-sky-500/10 bg-[#07080c] p-3 font-mono text-[11px] leading-snug text-zinc-200" data-testid="cmux-screen">{screen || " "}</pre>
                  <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
                    <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={`type a line and press Enter to send it to this surface on ${selected.nodeName}`} data-testid="cmux-input" className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-sky-500/60" />
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
