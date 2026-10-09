import { useEffect, useState } from "react";
import { api, fmtAgo } from "../lib/api";
import { NETWORK_INTERVAL, type NetworkNode, type NetworkSample, type NetworkSnapshot } from "../../src/shared/network";

const speed = (value: number | null | undefined) => value == null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} Gbps` : `${value.toFixed(1)} Mbps`;
const pairKey = (a: string, b: string) => [a, b].sort().join(":");
const fresh = (s?: NetworkSample) => !!s && Date.now() - s.at < NETWORK_INTERVAL;

export function NetworkMap() {
  const [local, setLocal] = useState<NetworkSnapshot | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, NetworkSnapshot>>({});
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let canceled = false, busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const own = await api<NetworkSnapshot>("/api/network", { local: true, signal: AbortSignal.timeout(10_000) });
        if (!Array.isArray(own.nodes)) throw new Error("Network map needs a daemon update");
        const peers = own.nodes.filter(n => n.id);
        const remote = await Promise.all(peers.map(async n => {
          try {
            const s = await api<NetworkSnapshot>(`/api/nodes/${n.id}/proxy/network`, { local: true, signal: AbortSignal.timeout(8_000) });
            return Array.isArray(s.samples) && Array.isArray(s.nodes) ? [n.name, s] as const : null;
          } catch { return null; }
        }));
        if (canceled) return;
        setLocal(own); setSource(s => s || own.source);
        setTarget(t => t || own.nodes.find(n => n.name === "sentinel" && n.id)?.name || own.nodes.find(n => n.id)?.name || "");
        setSnapshots(Object.fromEntries([[own.source, own], ...remote.filter((s): s is readonly [string, NetworkSnapshot] => s !== null)]));
        setUnavailable(peers.filter((_, i) => !remote[i]).map(n => n.name));
        setError("");
      } catch (e) { if (!canceled) setError(e instanceof Error ? e.message : "Network map unavailable"); }
      finally { busy = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { canceled = true; clearInterval(timer); };
  }, [retry]);

  // Reuse metadata from a peer with Deck installed; IDs always belong to this daemon.
  const nodes: NetworkNode[] = (local?.nodes ?? []).map(n => ({ ...n }));
  for (const snap of Object.values(snapshots)) for (const n of snap.nodes) {
    const own = nodes.find(x => x.name === n.name);
    if (!own) nodes.push({ ...n, id: null, local: false });
    else if (own.kind === "host" && n.kind !== "host") Object.assign(own, { kind: n.kind, services: n.services, roles: n.roles });
  }
  const samples = Object.values(snapshots).flatMap(s => s.samples).sort((a, b) => b.at - a.at);
  const selected = samples.find(s => pairKey(s.source, s.target) === pairKey(source, target));
  const up = selected?.source === source ? selected?.uploadMbps : selected?.downloadMbps;
  const down = selected?.source === source ? selected?.downloadMbps : selected?.uploadMbps;
  const current = snapshots[source];
  const destination = current?.nodes.find(n => n.name === target && n.id);
  const sourceNode = nodes.find(n => n.name === source);
  const targetNode = nodes.find(n => n.name === target);
  const cooling = !!current?.samples.find(s => s.target === target && Date.now() - s.at < 60_000);
  const testing = !!current?.running;
  const links = new Map<string, { a: string; b: string; sample?: NetworkSample }>();
  for (const snap of Object.values(snapshots)) for (const n of snap.nodes) if (n.id && nodes.some(x => x.name === n.name)) {
    const key = pairKey(snap.source, n.name);
    links.set(key, { a: snap.source, b: n.name, sample: samples.find(s => pairKey(s.source, s.target) === key) });
  }
  const group = (n: NetworkNode) => n.kind === "laptop" || n.kind === "phone" ? 0 : n.kind === "vps" ? 2 : 1;
  const positions = new Map<string, { x: number; y: number }>();
  const columns = [0, 1, 2].map(g => nodes.filter(n => group(n) === g));
  const height = Math.max(310, ...columns.map(ns => ns.length * 84 + 65));
  columns.forEach((ns, col) => ns.forEach((n, i) => positions.set(n.name, { x: 112 + col * 230, y: 85 + i * 84 })));
  const healthy = [...links.values()].filter(l => fresh(l.sample) && !l.sample?.error).length;

  async function testNow() {
    if (!destination || !sourceNode) return;
    setSending(true); setNotice("");
    try {
      const path = sourceNode.local ? "/api/network/test" : `/api/nodes/${sourceNode.id}/proxy/network/test`;
      await api(path, { local: true, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: destination.id }) });
      setNotice(`Testing ${source} ↔ ${target}. Results refresh automatically.`);
      setRetry(r => r + 1);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Test failed"); }
    finally { setSending(false); }
  }

  return <section className="hud-card network-map mt-5 overflow-hidden" aria-label="Fleet network topology" data-testid="network-map">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-400/15 px-4 py-4 sm:px-5">
      <div><div className="hud-label text-sky-400">Fleet telemetry / 01</div><h2 className="mt-1 text-sm uppercase tracking-[.18em] text-zinc-100">Network constellation</h2></div>
      <div className="flex gap-4 text-[10px] text-zinc-400"><span><b className="text-sky-300">{nodes.length}</b> hosts</span><span><b className="text-emerald-400">{healthy}</b> fresh links</span><span>{local?.automatic ? "AUTO · 6H / PEER" : "AUTO OFF"}</span></div>
    </div>
    {error && <div role="alert" className="px-5 py-3 text-xs text-amber-400">{error} <button className="hud-chip ml-2" onClick={() => setRetry(r => r + 1)}>Retry</button></div>}
    {!local && !error && <p className="p-5 text-xs text-zinc-400">Reading the fleet’s connections…</p>}
    {local && <>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_290px]">
        <div className="min-w-0">
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 690 ${height}`} className="network-constellation w-full min-w-[540px]" role="img" aria-label="Logical peer connections. Select a host to inspect its connection. This is not geographic or physical routing.">
              <defs><pattern id="net-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".6" fill="#22d3ee" opacity=".14" /></pattern><radialGradient id="net-glow"><stop stopColor="#22d3ee" stopOpacity=".09"/><stop offset="1" stopColor="#22d3ee" stopOpacity="0"/></radialGradient></defs>
              <rect width="690" height={height} fill="url(#net-grid)"/><ellipse cx="345" cy={height / 2} rx="340" ry="180" fill="url(#net-glow)"/>
              {["PERSONAL", "COMPUTE / HOME", "CLOUD / SERVICES"].map((s, i) => <text key={s} x={112 + i * 230} y="28" textAnchor="middle" fill="#76819c" fontSize="9" letterSpacing="1.6">{s}</text>)}
              {[...links.entries()].map(([key, l]) => {
                const active = key === pairKey(source, target);
                const a = positions.get(active ? source : l.a), b = positions.get(active ? target : l.b); if (!a || !b) return null;
                const good = fresh(l.sample) && !l.sample?.error;
                const color = l.sample?.error ? "#fbbf24" : good ? "#22d3ee" : "#4b5673";
                const d = a.x === b.x ? `M${a.x},${a.y} Q${a.x + 90},${(a.y + b.y) / 2} ${b.x},${b.y}` : `M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`;
                return <g key={key} opacity={active ? 1 : .35}><path d={d} fill="none" stroke={color} strokeWidth={active ? 3 : 1} strokeDasharray={good ? undefined : "4 6"}/>{active && good && <path d={d} fill="none" stroke="#cffafe" strokeWidth="3" strokeDasharray="2 22" className="network-flow"/>}{active && l.sample && <g transform={`translate(${a.x === b.x ? a.x + 44 : (a.x + b.x) / 2},${(a.y + b.y) / 2})`}><rect x="-56" y="-13" width="112" height="26" rx="5" fill="#0b111c" stroke={color}/><text textAnchor="middle" y="4" fill={color} fontSize="10">{speed(up)} {b.x < a.x ? "←" : b.x > a.x ? "→" : b.y < a.y ? "↑" : "↓"}</text></g>}</g>;
              })}
              {nodes.map(n => {
                const p = positions.get(n.name)!;
                const active = n.name === source || n.name === target;
                const reporting = !!snapshots[n.name];
                return <g key={n.name} transform={`translate(${p.x},${p.y})`} role="button" tabIndex={0} aria-label={`Inspect ${n.name}`} aria-pressed={n.name === target} onClick={() => { if (n.name !== source) { setTarget(n.name); setNotice(""); } }} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (n.name !== source) setTarget(n.name); } }} className="network-host cursor-pointer">
                  <rect x="-80" y="-25" width="160" height="55" rx="9" fill="#0b111c" stroke={active ? "#22d3ee" : "#283046"} strokeWidth={active ? 1.5 : 1}/>
                  <circle cx="-62" cy="-6" r="3" fill={reporting ? "#a3e635" : "#76819c"}/>
                  <text x="-51" y="-2" fill={active ? "#eef2fb" : "#bcc6dc"} fontSize="13">{n.name}</text>
                  <text x="-62" y="17" fill="#76819c" fontSize="8">{n.roles.filter(r => r !== "cyberdeck").slice(0, 2).join(" · ") || n.kind}</text>
                  {n.name === source && <text x="65" y="-5" textAnchor="end" fill="#22d3ee" fontSize="8">SRC</text>}
                </g>;
              })}
            </svg>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 pb-4 text-[9px] text-zinc-500"><span className="text-sky-400">━ fresh test</span><span className="text-amber-400">┄ failed test</span><span>┄ stale / untested</span><span>Logical links · host dot = telemetry available</span></div>
        </div>
        <div className="border-t border-cyan-400/15 bg-zinc-950/50 p-4 lg:border-l lg:border-t-0">
          <div className="hud-label mb-3">Inspect a connection</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] text-zinc-500">From<select aria-label="Network source" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-xs text-zinc-200" value={source} onChange={e => { setSource(e.target.value); if (e.target.value === target) setTarget(source); setNotice(""); }}>{nodes.map(n => <option key={n.name}>{n.name}</option>)}</select></label>
            <label className="text-[10px] text-zinc-500">To<select aria-label="Network target" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-xs text-zinc-200" value={target} onChange={e => { setTarget(e.target.value); setNotice(""); }}>{nodes.filter(n => n.name !== source).map(n => <option key={n.name}>{n.name}</option>)}</select></label>
          </div>
          <div className="mt-5 text-[10px] text-zinc-500">{source} → {target}</div><div className="mt-1 text-2xl tracking-tight text-sky-300">{speed(up)}</div>
          <div className="mt-3 flex justify-between text-xs"><span className="text-zinc-500">← reverse</span><span className="text-zinc-200">{speed(down)}</span></div>
          <div className="mt-2 flex justify-between text-xs"><span className="text-zinc-500">HTTP round trip</span><span className="text-zinc-200">{selected?.latencyMs == null ? "—" : `${selected.latencyMs.toFixed(1)} ms`}</span></div>
          <p className={`mt-3 text-[10px] ${!fresh(selected) || selected?.error ? "text-amber-400" : "text-zinc-500"}`} title={selected ? new Date(selected.at).toLocaleString() : undefined}>{selected ? `${fresh(selected) ? "Sample" : "Stale sample"} · ${fmtAgo(selected.at)}` : "No measurements yet"}</p>
          {selected?.error && <p className="mt-2 text-[10px] text-amber-400">{selected.error}</p>}
          {!destination && <p className="mt-3 text-[10px] text-zinc-400">{!current ? "Source telemetry unavailable. Update or reconnect its Cyberdeck daemon." : "These hosts are not paired. Connect their private Cyberdeck endpoints to enable direct tests."}</p>}
          <button className="hud-chip neon mt-4 w-full py-2 disabled:opacity-40" disabled={!destination || testing || sending || cooling} onClick={() => void testNow()}>{sending || testing ? `Testing ${current?.running ?? target}…` : cooling ? "Retest available in a minute" : "Test connection ↗"}</button>
          {notice && <p role="status" className="mt-2 text-[10px] text-zinc-400">{notice}</p>}
          <div className="mt-5 border-t border-zinc-800 pt-3"><div className="hud-label">{target} / expected services</div><div className="mt-2 flex flex-wrap gap-1">{[...new Set(targetNode?.services.length ? targetNode.services : targetNode?.roles ?? [])].map(s => <span key={s} className="max-w-full break-all rounded border border-zinc-800 px-1.5 py-1 text-[9px] text-zinc-400">{s}</span>)}</div></div>
        </div>
      </div>
      <div className="border-t border-cyan-400/15 px-5 py-3 text-[10px] leading-relaxed text-zinc-500">4 MiB each way · automatic tests every 6 hours per peer, staggered · application throughput, not a line-speed or voice-quality benchmark.{unavailable.length > 0 && <span className="ml-1 text-amber-400">Telemetry unavailable: {unavailable.join(", ")}.</span>}</div>
    </>}
  </section>;
}
