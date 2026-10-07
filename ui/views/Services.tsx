import { useEffect, useMemo, useState } from "react";
import { api, post, wsUrl, navigate, activeNode, activeNodeName, fmtAgo, ApiError } from "../lib/api";
import { type Overview, type ServiceProbe, isoAgo, projectsForService, projectsOnHost, serviceLogCmd, serviceRestartCmd, pill } from "../lib/control";
import { useFleetNodes, openOnHost, resolveHost } from "../lib/hosts";
import { Panel, Empty, ServiceLine, Action } from "./Projects";

export function Services({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [probe, setProbe] = useState<ServiceProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const nodes = useFleetNodes();
  const focusHost = params.get("host") ?? "";
  const focusSvc = params.get("svc") ?? "";

  const load = async () => {
    try {
      const o = await api<Overview>("/api/control/overview");
      setOv(o);
      setProbe(o.services);
      setErr(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      else setErr(e instanceof ApiError && e.status === 404 ? "No fleet dir configured on this node." : String(e instanceof Error ? e.message : e));
    }
  };
  useEffect(() => {
    load();
    const iv = setInterval(load, 60_000);
    if (activeNode()) return () => clearInterval(iv);
    const ws = new WebSocket(wsUrl("/api/events"));
    ws.onmessage = (m) => { try { if (JSON.parse(m.data).kind === "services") load(); } catch {} };
    return () => { clearInterval(iv); ws.close(); };
  }, []);
  // scroll the focused host into view once data is there
  useEffect(() => {
    if (!ov || !focusHost) return;
    document.getElementById(`host-${focusHost.toLowerCase()}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [ov?.fleetDir, focusHost]);

  const probeNow = async () => {
    setBusy(true);
    try { setProbe(await post<ServiceProbe>("/api/control/services/probe", {})); } catch (e) { setErr(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
  };

  const byHost = useMemo(() => {
    const m = new Map<string, ServiceProbe["rows"]>();
    for (const r of probe?.rows ?? []) m.set(r.host, [...(m.get(r.host) ?? []), r]);
    return m;
  }, [probe]);
  const hosts = ov?.status?.hosts ?? [];
  const projects = ov?.projects ?? [];
  const me = ov?.status?.host ?? "";
  const down = (probe?.rows ?? []).filter((r) => r.ok === false).length;
  const onHost = (host: string, cmd: string | undefined, title: string) => {
    const e = openOnHost({ host, me, hosts, nodes, cmd, title });
    setMsg(e);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <header className="flex items-center justify-between gap-2">
          <div>
            <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">Services{activeNode() ? ` via ${activeNodeName()}` : ""}</h1>
            <p className="text-xs text-zinc-500">
              {probe?.probedAt ? `probed ${isoAgo(probe.probedAt)} · ${probe.rows.length} services · ${down ? `${down} down` : "all up"}` : err ?? "no probe yet"}
              {focusHost && <> · showing <span className="text-zinc-300">{focusHost}</span> <button onClick={() => navigate("services")} className="text-sky-400 hover:underline">(all hosts)</button></>}
            </p>
          </div>
          {msg && <span className="text-[11px] text-amber-400/90" data-testid="services-msg">{msg}</span>}
          <button onClick={probeNow} disabled={busy || !ov} data-testid="probe-now" className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10 disabled:opacity-40">{busy ? "Probing…" : "Probe now"}</button>
        </header>
        {err && !ov && <div className="mt-6 hud-card p-6 text-sm text-zinc-400">{err}</div>}
        <div className="mt-5 space-y-3">
          {hosts.filter((h) => !focusHost || h.name.toLowerCase() === focusHost.toLowerCase()).map((h) => {
            const rows = byHost.get(h.name) ?? [];
            const owners = projectsOnHost(h.name, projects);
            const where = resolveHost({ host: h.name, me, hosts, nodes });
            return (
              <div key={h.name} id={`host-${h.name.toLowerCase()}`} data-testid={`host-panel-${h.name}`}>
                <Panel
                  title={h.name}
                  right={
                    <span className="flex flex-wrap items-center justify-end gap-2 text-[11px] text-zinc-500">
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px]">{h.kind}</span>
                      <span className="hidden sm:inline">{h.roles.join(", ")}</span>
                      {h.cyberdeck && (
                        <button onClick={() => navigate("fleet")} className="hidden text-zinc-400 hover:text-sky-400 md:inline" title="open Fleet">cyberdeck {h.cyberdeck.version} · {h.cyberdeck.repos} repos · {h.cyberdeck.atRisk} at risk{h.cyberdeck.lastScanAt ? ` · scanned ${fmtAgo(h.cyberdeck.lastScanAt)}` : ""}</button>
                      )}
                      {where.kind !== "none" && <Action onClick={() => onHost(h.name, undefined, h.name)} title={where.kind === "ssh" ? `ssh ${where.alias}` : where.kind === "node" ? `terminal on ${where.name}` : "terminal here"}>{where.kind === "local" ? "$ shell" : where.kind === "node" ? "$ shell there" : `$ ssh ${where.alias}`}</Action>}
                      <span className={`hud-badge flex items-center gap-1.5 ${h.online === true ? "neon-green" : h.online === false ? "neon-red" : "text-zinc-500"}`}>
                        <span className={`led ${h.online === true ? "led-on" : h.online === false ? "led-err" : "led-off"}`} />
                        {h.online === true ? "online" : h.online === false ? "unreachable" : "off-tailnet"}
                      </span>
                    </span>
                  }
                >
                  {owners.length > 0 && (
                    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                      projects:
                      {owners.map((p) => (
                        <button key={p.slug} onClick={() => navigate("projects", { p: p.slug })} className="rounded-lg border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800" data-testid={`host-project-${p.slug}`}>
                          {p.name} <span className={`ml-1 rounded px-1 text-[9px] ${pill(p.status)}`}>{p.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {h.note && h.online === false && <div className="mb-1 text-[11px] text-amber-400/80">{h.note}</div>}
                  {rows.length === 0 && <Empty>{h.online === false ? "unreachable" : "no services declared or not probed yet"}</Empty>}
                  {rows.map((r) => (
                    <ServiceLine
                      key={`${r.type}/${r.service}`}
                      row={r}
                      active={focusSvc === r.service && focusHost.toLowerCase() === r.host.toLowerCase()}
                      projects={projectsForService(r, projects)}
                      onLogs={() => { const c = serviceLogCmd(r); if (c) onHost(r.host, c, `${r.service} @ ${r.host}`); }}
                      onRestart={serviceRestartCmd(r) ? () => { if (confirm(`Restart ${r.service} on ${r.host}?`)) onHost(r.host, serviceRestartCmd(r)!, `restart ${r.service}`); } : undefined}
                    />
                  ))}
                </Panel>
              </div>
            );
          })}
          {ov && hosts.length === 0 && <Empty>No hosts in fleet.json.</Empty>}
          {ov && focusHost && !hosts.some((h) => h.name.toLowerCase() === focusHost.toLowerCase()) && <Empty>No host named {focusHost} in fleet.json. <button onClick={() => navigate("services")} className="text-sky-400 hover:underline">Show all.</button></Empty>}
        </div>
      </div>
    </div>
  );
}
