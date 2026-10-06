import { useEffect, useMemo, useState } from "react";
import { api, post, wsUrl, activeNode, activeNodeName, fmtAgo, ApiError } from "../lib/api";
import { type Overview, type ServiceProbe, isoAgo } from "../lib/control";
import { Panel, Row, Empty } from "./Projects";

export function Services({ onLocked }: { onLocked: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [probe, setProbe] = useState<ServiceProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
  const down = (probe?.rows ?? []).filter((r) => r.ok === false).length;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">Services{activeNode() ? ` via ${activeNodeName()}` : ""}</h1>
            <p className="text-xs text-zinc-500">{probe?.probedAt ? `probed ${isoAgo(probe.probedAt)} · ${probe.rows.length} services · ${down ? `${down} down` : "all up"}` : err ?? "no probe yet"}</p>
          </div>
          <button onClick={probeNow} disabled={busy || !ov} data-testid="probe-now" className="hud-badge neon px-3 py-1.5 hover:bg-sky-500/10 disabled:opacity-40">{busy ? "Probing…" : "Probe now"}</button>
        </header>
        {err && !ov && <div className="mt-6 hud-card p-6 text-sm text-zinc-400">{err}</div>}
        <div className="mt-5 space-y-3">
          {hosts.map((h) => {
            const rows = byHost.get(h.name) ?? [];
            return (
              <Panel
                key={h.name}
                title={h.name}
                right={
                  <span className="flex items-center gap-3 text-[11px] text-zinc-500">
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px]">{h.kind}</span>
                    {h.roles.join(", ")}
                    {h.cyberdeck && <span className="text-zinc-400">cyberdeck {h.cyberdeck.version} · {h.cyberdeck.repos} repos · {h.cyberdeck.atRisk} at risk{h.cyberdeck.lastScanAt ? ` · scanned ${fmtAgo(h.cyberdeck.lastScanAt)}` : ""}</span>}
                    <span className={`hud-badge flex items-center gap-1.5 ${h.online === true ? "neon-green" : h.online === false ? "neon-red" : "text-zinc-500"}`}>
                      <span className={`led ${h.online === true ? "led-on" : h.online === false ? "led-err" : "led-off"}`} />
                      {h.online === true ? "online" : h.online === false ? "unreachable" : "off-tailnet"}
                    </span>
                  </span>
                }
              >
                {h.note && h.online === false && <div className="mb-1 text-[11px] text-amber-400/80">{h.note}</div>}
                {rows.length === 0 && <Empty>{h.online === false ? "unreachable" : "no services declared or not probed yet"}</Empty>}
                {rows.map((r) => (
                  <Row key={r.service}>
                    <span className={`led ${r.ok === true ? "led-on" : r.ok === false ? "led-err" : "led-off"}`} />
                    <span className="w-64 truncate font-mono text-[11px] text-zinc-200">{r.service}</span>
                    <span className="w-24 text-[10px] text-zinc-500">{r.type}</span>
                    <span className={`hud-badge ${r.ok === true ? "neon-green" : r.ok === false ? "neon-red" : "text-zinc-500"}`}>{r.ok === true ? "online" : r.ok === false ? "down" : r.state || "unknown"}</span>
                    {r.error && <span className="ml-auto truncate text-[10px] text-zinc-500" title={r.error}>{r.error}</span>}
                  </Row>
                ))}
              </Panel>
            );
          })}
          {ov && hosts.length === 0 && <Empty>No hosts in fleet.json.</Empty>}
        </div>
      </div>
    </div>
  );
}
