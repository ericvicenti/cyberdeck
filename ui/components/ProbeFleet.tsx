import { useEffect, useState } from 'react';
import { api, navigate, post } from '../lib/api';

type Peer = { id: string; name: string; online: boolean; probe_device?: string | null; error?: string };
type Fleet = { enabled: boolean; paired: boolean; account?: string; device?: string; relay?: string; fresh?: boolean;
  devices: { id: string; name: string; port: number | null; online: boolean }[] };

/** Relay presence and a successful Cyberdeck request are separate, visible checks. */
export function ProbeFleet({ peers }: { peers: Peer[] | null }) {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => api<Fleet>('/api/fleet/probe').then(f => { if (alive) setFleet(f); }).catch(() => {});
    void load(); const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!fleet?.enabled) return null;
  const openConsole = async () => {
    try { const result = await post<{ url: string }>('/api/fleet/probe/console', {}); location.assign(result.url); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open Probe'); }
  };
  return <section className="hud-card mt-5 overflow-hidden" aria-label="Probe fleet connectivity" data-testid="probe-fleet">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-400/15 p-4">
      <div><div className="hud-label text-sky-400">Probe network</div><h2 className="mt-1 text-sm text-zinc-100">{fleet.account ?? 'Connect this machine to your fleet'}</h2><p className="mt-1 text-xs text-zinc-500">{fleet.paired ? `Private connections through ${fleet.relay}` : 'Pair this machine in Probe to use its fleet connections.'}</p></div>
      {fleet.paired && <button className="hud-chip" onClick={openConsole}>Manage devices / pair</button>}
    </div>
    {error && <p role="alert" className="p-4 text-xs text-amber-400">{error}</p>}
    {fleet.paired && !fleet.fresh && <p className="px-4 pt-3 text-xs text-amber-400">Probe’s directory is stale. Check that its network agent is running.</p>}
    <div className="divide-y divide-zinc-800">{fleet.devices.map(d => {
      const self = d.id === fleet.device;
      const peer = peers?.find(p => p.probe_device === d.id);
      const reachable = self || peer?.online === true;
      const label = !d.port ? (d.online ? 'Client connected' : 'Client offline') : reachable ? 'Cyberdeck reachable' : peers === null ? 'Checking Cyberdeck…' : d.online ? (peer ? 'Relay online · Cyberdeck unavailable' : 'Relay online · Cyberdeck not paired') : 'Offline';
      return <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-testid={`probe-device-${d.name.toLowerCase()}`}>
        <div><div className="flex items-center gap-2 text-sm text-zinc-200"><span className={`led ${reachable || d.online ? 'led-on' : 'led-off'}`} />{d.name}{self && <span className="text-xs text-zinc-500">this machine</span>}</div><div className="mt-1 text-xs text-zinc-500">{label}</div>{peer?.error && !peer.online && <p className="mt-1 max-w-xl text-xs text-amber-500">{peer.error}</p>}</div>
        {(self || peer) && d.port && <div className="flex gap-2">{[['term','Terminal'],['files','Files'],['desktop','Desktop']].map(([view,title]) => <button key={view} disabled={!reachable} className="hud-chip disabled:opacity-40" onClick={() => navigate(view!, { node: self ? '' : peer!.id })}>{title}</button>)}</div>}
      </div>;
    })}</div>
  </section>;
}
