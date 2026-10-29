import { lazy, Suspense } from "react";
import { refreshRouteTitle, routeHash } from "./lib/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import { parseHash, navigate, api, type Route } from "./lib/api";
import { useFleet, useOverview } from "./lib/fleet";
import { ShieldIcon, ServerIcon, FolderIcon, TerminalIcon, GitIcon, LayersIcon, BotIcon, PulseIcon, GridIcon, CloudIcon, MicIcon, SeedIcon } from "./lib/icons";
import { RetainedView } from "./components/RetainedView";
import { Cloud } from "./views/Cloud";
import { Applications } from "./views/Applications";
import { Controls } from "./views/Controls";
import { ScreenRemote } from "./views/ScreenRemote";
import { Home } from "./views/Home";
import { Desk } from "./views/Desk";
import { Projects } from "./views/Projects";
import { Agents } from "./views/Agents";
import { Services } from "./views/Services";
import { Data } from "./views/Data";
import { Files } from "./views/Files";
import { EditorWorkspace } from "./views/Editor";
import { Term, type SessionDraftStore } from "./views/Term";
import { Cmux } from "./views/Cmux";
import { TokenGate } from "./views/TokenGate";
import { PromptBar } from "./components/PromptBar";
import { applyInstallTarget } from "./lib/pwa";

// Seed's agents UI is a large bundle of its own; load it when the view opens.
const Desktop = lazy(() => import("./views/Desktop").then((m) => ({ default: m.Desktop })));
const SeedAgents = lazy(() => import("./views/SeedAgents"));

const NAV = [
  { view: "fleet", label: "Home", icon: ServerIcon },
  { view: "controls", label: "Controls", icon: GridIcon },
  { view: "desktop", label: "Desktop", icon: GridIcon },
  { view: "applications", label: "Applications", icon: GridIcon },
  { view: "desk", label: "Desk", icon: MicIcon },
  { view: "projects", label: "Projects", icon: LayersIcon },
  { view: "seed", label: "Seed", icon: SeedIcon },
  { view: "agents", label: "Agents", icon: BotIcon },
  { view: "services", label: "Services", icon: PulseIcon },
  { view: "data", label: "Data", icon: GitIcon },
  { view: "files", label: "Files", icon: FolderIcon },
  { view: "term", label: "Sessions", icon: TerminalIcon },
  { view: "cmux", label: "cmux", icon: GridIcon },
  { view: "cloud", label: "Cloud", icon: CloudIcon },
];

/** The shell: title bar, activity bar, the view, the prompt bar, the status bar. There is no
 *  page-wide machine selection: the fleet is one place. Views that span machines ask every node
 *  (Projects, Sessions, cmux, Data, Home); views bound to one machine name it in their own URL
 *  (`?node=`) and pick it in place (Files, Editor, Cloud, Desktop, Seed). */
export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [locked, setLocked] = useState(false);
  const [sessionDrafts] = useState<SessionDraftStore>(() => ({ values: new Map(), pending: new Set(), generation: 0 }));
  const { fleet } = useFleet();
  const knownRoute = NAV.some(item => item.view === route.view) || ["edit", "remote"].includes(route.view);
  // a machine-bound view remounts when its machine changes, so nothing of the old machine lingers
  const nodeId = route.params.get("node") ?? "";
  const { overview: hudOverview } = useOverview(undefined, 30_000);
  const hud = hudOverview ? { tasks: hudOverview.collab.tasks.filter((t) => t.status === "open").length, running: hudOverview.collab.runs.filter((r) => r.status === "running").length, down: hudOverview.services ? hudOverview.services.rows.filter((r) => r.ok === false).length : null, handoff: hudOverview.status?.handoffOpen ?? 0 } : null;
  const [cmuxCount, setCmuxCount] = useState<number | null>(null);

  useLayoutEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  useEffect(() => applyInstallTarget(route.view), [route.view]);
  // re-run once the fleet list arrives: a machine-bound title names the machine, not its id
  useEffect(() => refreshRouteTitle(locked, !knownRoute), [route, locked, knownRoute, fleet]);
  // the page-wide node preference of earlier builds; a link names its machine now
  useEffect(() => { try { localStorage.removeItem("cyberdeck-active-node"); } catch {} }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
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
  const lock = () => {
    if (location.hash !== routeHash(route.view, route.params)) return;
    sessionDrafts.values.clear(); sessionDrafts.pending.clear(); sessionDrafts.generation++;
    setLocked(true);
  };
  const isActive = (v: string) => route.view === v || (v === "files" && route.view === "edit");
  const onlineCount = fleet ? fleet.nodes.filter((n) => n.online).length : 0;
  const selfName = fleet?.self.name ?? "local";

  const view = (
    <>
      {!knownRoute && <section className="p-6"><h1 className="text-xl">Page not found</h1><p className="my-3">No Cyberdeck view named “{route.view}”.</p><button onClick={() => navigate("fleet")}>Go home</button></section>}
      {route.view === "controls" && <Controls />}
      {route.view === "desktop" && <Suspense fallback={<div className="p-6">Loading desktop…</div>}><Desktop params={route.params} key={`desktop-${nodeId}`} /></Suspense>}
      {route.view === "fleet" && <Home params={route.params} onLocked={lock} />}
      {route.view === "projects" && <Projects params={route.params} onLocked={lock} />}
      {route.view === "seed" && <Suspense fallback={<div className="p-6 text-xs text-zinc-500">Loading Seed agents…</div>}><SeedAgents params={route.params} key={`seed-${nodeId}`} /></Suspense>}
      {route.view === "agents" && <Agents params={route.params} onLocked={lock} />}
      {route.view === "services" && <Services params={route.params} onLocked={lock} />}
      {route.view === "data" && <Data params={route.params} onLocked={lock} />}
      {route.view === "files" && <Files params={route.params} onLocked={lock} key={`files-${nodeId}`} />}
      {route.view === "term" && <Term params={route.params} onLocked={lock} drafts={sessionDrafts} />}
      {route.view === "cmux" && <Cmux params={route.params} onLocked={lock} />}
      {route.view === "cloud" && <Cloud params={route.params} onLocked={lock} key={`cloud-${nodeId}`} />}
    </>
  );

  return (
    <>
    {route.view === "remote" && <ScreenRemote />}
    <div style={route.view === "remote" ? { display: "none" } : undefined} inert={route.view === "remote"} className="scanlines flex h-[100dvh] flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      {/* title bar: game HUD */}
      <header className="hud-chrome flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <ShieldIcon size={15} className="neon" />
        <span className="neon text-[13px] font-semibold uppercase tracking-[0.2em]">Cyberdeck</span>
        <span className="hidden text-[10px] uppercase tracking-widest text-zinc-600 sm:inline">/ {NAV.find((n) => isActive(n.view))?.label ?? route.view}</span>
        <div className="hidden items-center gap-1.5 pl-3 md:flex" data-testid="hud-chips">
          <span className="hud-chip text-zinc-300" data-testid="header-node" title="the machine serving this page"><span className="led led-on" />{selfName}</span>
          <button type="button" data-testid="header-fleet" className="hud-chip text-zinc-300 hover:text-zinc-100" onClick={() => navigate("fleet")} title="Open Fleet overview"><span className={`led ${onlineCount === (fleet?.nodes.length ?? 0) ? "led-on" : "led-warn"}`} />fleet {onlineCount}/{fleet?.nodes.length ?? 0}</button>
          <button className="hud-chip text-zinc-300 hover:text-zinc-100" onClick={() => navigate("agents")}><span className={`led ${hud?.running ? "led-run" : "led-off"}`} />tasks {hud ? `${hud.tasks} open` : "—"}{hud?.running ? ` · ${hud.running} run` : ""}</button>
          <button className={`hud-chip ${hud?.down ? "neon-red" : "text-zinc-300"} hover:text-zinc-100`} onClick={() => navigate("services")}><span className={`led ${hud?.down ? "led-err" : hud?.down === 0 ? "led-on" : "led-off"}`} />svc {hud?.down == null ? "—" : hud.down ? `${hud.down} down` : "ok"}</button>
          {cmuxCount != null && <button className="hud-chip text-zinc-300 hover:text-zinc-100" onClick={() => navigate("cmux")}><span className="led led-on" />cmux {cmuxCount}</button>}
        </div>
        <div className="flex-1" />
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

        <main className="min-w-0 flex-1 overflow-hidden">{view}
          <EditorWorkspace params={route.params} visible={route.view === "edit"} onLocked={lock} />
          <RetainedView visible={route.view === "applications"} params={route.params}>{(params, visible) => <Applications params={params} visible={visible} onLocked={lock} />}</RetainedView>
          <RetainedView visible={route.view === "desk"} params={route.params}>{(params, visible) => <Desk params={params} visible={visible} onLocked={lock} />}</RetainedView></main>
      </div>

      {/* sticky prompt bar: start sessions from anywhere; live sessions strip */}
      {route.view !== "applications" && <PromptBar route={route} nodeName={selfName} />}

      {/* status bar (desktop) */}
      <footer className="hud-chrome hidden h-6 shrink-0 items-center gap-4 border-t px-3 text-[10px] uppercase tracking-wider text-zinc-500 sm:flex">
        <button className="flex items-center gap-1.5 hover:text-zinc-300" onClick={() => navigate("fleet")} data-testid="statusbar-node" title="the machine serving this page">
          <span className="led led-on" />
          {selfName}
        </button>
        <span>
          fleet: {onlineCount}/{fleet?.nodes.length ?? 0} peers online
        </span>
        {hud && <span>handoff {hud.handoff}</span>}
        <div className="flex-1" />
        <span className="font-mono normal-case">cyberdeck {fleet?.self.commit ?? ""}</span>
      </footer>

      {/* bottom nav (mobile) */}
      <nav className="hud-chrome flex shrink-0 overflow-x-auto border-t pb-[env(safe-area-inset-bottom)] sm:hidden">
        {NAV.map((item) => (
          <button
            key={item.view}
            onClick={() => navigate(item.view)}
            data-testid={`mnav-${item.view}`}
            className={`flex min-w-20 flex-1 flex-col items-center gap-0.5 py-2 text-[9px] uppercase tracking-wider ${
              isActive(item.view) ? "neon" : "text-zinc-500"
            }`}
          >
            <item.icon size={20} />
            {item.label}
          </button>
        ))}
      </nav>
    </div>
    </>
  );
}
