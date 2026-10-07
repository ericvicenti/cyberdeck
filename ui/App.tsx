import { useEffect, useState } from "react";
import { parseHash, navigate, api, activeNode, activeNodeName, setActiveNode, type Route } from "./lib/api";
import { ShieldIcon, ServerIcon, FolderIcon, TerminalIcon, GitIcon, LayersIcon, BotIcon, PulseIcon, GridIcon } from "./lib/icons";
import { Home } from "./views/Home";
import type { Overview } from "./lib/control";
import { Projects } from "./views/Projects";
import { Agents } from "./views/Agents";
import { Services } from "./views/Services";
import { Data } from "./views/Data";
import { Files } from "./views/Files";
import { Editor } from "./views/Editor";
import { Term } from "./views/Term";
import { Cmux } from "./views/Cmux";
import { TokenGate } from "./views/TokenGate";
import { PromptBar } from "./components/PromptBar";

const NAV = [
  { view: "fleet", label: "Home", icon: ServerIcon },
  { view: "projects", label: "Projects", icon: LayersIcon },
  { view: "agents", label: "Agents", icon: BotIcon },
  { view: "services", label: "Services", icon: PulseIcon },
  { view: "data", label: "Data", icon: GitIcon },
  { view: "files", label: "Files", icon: FolderIcon },
  { view: "term", label: "Sessions", icon: TerminalIcon },
  { view: "cmux", label: "cmux", icon: GridIcon },
];

type FleetSummary = { self: { nodeId: string; name: string; commit?: string }; nodes: { id: string; name: string; online: boolean }[] };

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [locked, setLocked] = useState(false);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [nodeGen, setNodeGen] = useState(0); // bump to remount views on node switch
  const [hud, setHud] = useState<{ tasks: number; running: number; down: number | null; handoff: number } | null>(null);
  const [cmuxCount, setCmuxCount] = useState<number | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    const onNode = () => setNodeGen((g) => g + 1);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("cyberdeck-node-changed", onNode);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("cyberdeck-node-changed", onNode);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const f = await api<FleetSummary>("/api/fleet/nodes");
        if (alive) setFleet(f);
      } catch {}
      try {
        const o = await api<Overview>("/api/control/overview");
        if (alive) setHud({ tasks: o.collab.tasks.filter((t) => t.status === "open").length, running: o.collab.runs.filter((r) => r.status === "running").length, down: o.services ? o.services.rows.filter((r) => r.ok === false).length : null, handoff: o.status?.handoffOpen ?? 0 });
      } catch { if (alive) setHud(null); }
      try {
        const t = await api<{ available: boolean; running?: boolean; tree: { kind: string; children: any[] }[] }>("/api/cmux/tree");
        if (alive) setCmuxCount(t.available && t.running ? t.tree.reduce((n, w) => n + w.children.length, 0) : null);
      } catch { if (alive) setCmuxCount(null); }
    };
    poll();
    const iv = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [locked]);

  if (locked) return <TokenGate />;
  const lock = () => setLocked(true);
  const isActive = (v: string) => route.view === v || (v === "files" && route.view === "edit");
  const nodeId = activeNode();
  const onlineCount = fleet ? fleet.nodes.filter((n) => n.online).length : 0;

  const switchNode = (value: string) => {
    if (value === "") setActiveNode("", "");
    else {
      const n = fleet?.nodes.find((n) => n.id === value);
      setActiveNode(value, n?.name ?? "node");
    }
  };

  const view = (
    <>
      {route.view === "fleet" && <Home onLocked={lock} key={`fleet-${nodeGen}`} />}
      {route.view === "projects" && <Projects params={route.params} onLocked={lock} key={`projects-${nodeGen}-${nodeId}`} />}
      {route.view === "agents" && <Agents params={route.params} onLocked={lock} key={`agents-${nodeGen}-${nodeId}`} />}
      {route.view === "services" && <Services params={route.params} onLocked={lock} key={`services-${nodeGen}-${nodeId}`} />}
      {route.view === "data" && <Data onLocked={lock} key={`data-${nodeGen}-${nodeId}`} />}
      {route.view === "files" && <Files params={route.params} onLocked={lock} key={`files-${nodeGen}-${nodeId}`} />}
      {route.view === "edit" && <Editor params={route.params} onLocked={lock} key={`edit-${nodeGen}-${nodeId}`} />}
      {route.view === "term" && <Term params={route.params} key={`term-${nodeGen}-${nodeId}`} />}
      {route.view === "cmux" && <Cmux onLocked={lock} key={`cmux-${nodeGen}-${nodeId}`} />}
    </>
  );

  return (
    <div className="scanlines flex h-[100dvh] flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      {/* title bar: game HUD */}
      <header className="hud-chrome flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <ShieldIcon size={15} className="neon" />
        <span className="neon text-[13px] font-semibold uppercase tracking-[0.2em]">Cyberdeck</span>
        <span className="hidden text-[10px] uppercase tracking-widest text-zinc-600 sm:inline">/ {NAV.find((n) => isActive(n.view))?.label ?? route.view}</span>
        <div className="hidden items-center gap-1.5 pl-3 md:flex" data-testid="hud-chips">
          <span className="hud-chip text-zinc-300"><span className="led led-on" />{nodeId ? activeNodeName() : fleet?.self.name ?? "local"}</span>
          <span className="hud-chip text-zinc-300"><span className={`led ${onlineCount === (fleet?.nodes.length ?? 0) ? "led-on" : "led-warn"}`} />fleet {onlineCount}/{fleet?.nodes.length ?? 0}</span>
          <button className="hud-chip text-zinc-300 hover:text-zinc-100" onClick={() => navigate("agents")}><span className={`led ${hud?.running ? "led-run" : "led-off"}`} />tasks {hud ? `${hud.tasks} open` : "—"}{hud?.running ? ` · ${hud.running} run` : ""}</button>
          <button className={`hud-chip ${hud?.down ? "neon-red" : "text-zinc-300"} hover:text-zinc-100`} onClick={() => navigate("services")}><span className={`led ${hud?.down ? "led-err" : hud?.down === 0 ? "led-on" : "led-off"}`} />svc {hud?.down == null ? "—" : hud.down ? `${hud.down} down` : "ok"}</button>
          {cmuxCount != null && <button className="hud-chip text-zinc-300 hover:text-zinc-100" onClick={() => navigate("cmux")}><span className="led led-on" />cmux {cmuxCount}</button>}
        </div>
        <div className="flex-1" />
        <select
          value={nodeId}
          onChange={(e) => switchNode(e.target.value)}
          data-testid="node-switcher"
          className="max-w-[45vw] rounded-sm border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] uppercase tracking-wider text-zinc-300 outline-none focus:border-zinc-600"
          title="Which machine you are operating on"
        >
          <option value="">{fleet?.self.name ?? "this machine"} (local)</option>
          {fleet?.nodes.map((n) => (
            <option key={n.id} value={n.id} disabled={!n.online}>
              {n.name} {n.online ? "" : "(offline)"}
            </option>
          ))}
        </select>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* activity bar (desktop) */}
        <aside className="hud-chrome hidden w-12 shrink-0 flex-col items-center gap-1 border-r py-2 sm:flex">
          {NAV.map((item) => (
            <button
              key={item.view}
              onClick={() => navigate(item.view)}
              title={item.label}
              data-testid={`nav-${item.view}`}
              className={`relative flex h-10 w-10 items-center justify-center rounded-sm transition-colors ${
                isActive(item.view) ? "neon" : "text-zinc-600 hover:text-zinc-300"
              }`}
            >
              {isActive(item.view) && <span className="absolute left-0 top-2 h-6 w-0.5 rounded bg-sky-400 shadow-[0_0_8px_#22d3ee]" />}
              <item.icon size={20} />
            </button>
          ))}
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden">{view}</main>
      </div>

      {/* sticky prompt bar: start sessions from anywhere; live sessions strip */}
      <PromptBar route={route} nodeName={fleet?.self.name ?? "local"} />

      {/* status bar (desktop) */}
      <footer className="hud-chrome hidden h-6 shrink-0 items-center gap-4 border-t px-3 text-[10px] uppercase tracking-wider text-zinc-500 sm:flex">
        <button className="flex items-center gap-1.5 hover:text-zinc-300" onClick={() => navigate("fleet")} data-testid="statusbar-node">
          <span className={`led ${nodeId ? "led-run" : "led-on"}`} />
          {nodeId ? `remote: ${activeNodeName()}` : fleet?.self.name ?? "local"}
        </button>
        <span>
          fleet: {onlineCount}/{fleet?.nodes.length ?? 0} peers online
        </span>
        {hud && <span>handoff {hud.handoff}</span>}
        <div className="flex-1" />
        <span className="font-mono normal-case">cyberdeck {fleet?.self.commit ?? ""}</span>
      </footer>

      {/* bottom nav (mobile) */}
      <nav className="hud-chrome flex shrink-0 border-t pb-[env(safe-area-inset-bottom)] sm:hidden">
        {NAV.map((item) => (
          <button
            key={item.view}
            onClick={() => navigate(item.view)}
            data-testid={`mnav-${item.view}`}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[9px] uppercase tracking-wider ${
              isActive(item.view) ? "neon" : "text-zinc-500"
            }`}
          >
            <item.icon size={20} />
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
