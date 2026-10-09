import { useEffect, useState } from "react";
import { api, ApiError, navigate } from "../lib/api";
import { CaseworkConsole, inCasework, openNative, type CaseworkApp } from "./CaseworkConsole";
type Application = { id: string; name: string; description: string; url: string };
/** `casework.apps` are the example apps that run natively in the Casework Desk app (the kitchen sink). */
type Listing = { applications: Application[]; casework?: { apps: CaseworkApp[]; devices: { id: string }[]; kiosk: boolean } };
export function Applications({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const [apps, setApps] = useState<Application[]>([]);
  const [casework, setCasework] = useState<Listing["casework"]>();
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pairing, setPairing] = useState<{ qr: string; link: string } | null>(null);
  const pair = async () => { try { setPairing(await api("/api/casework/pairing?url=" + encodeURIComponent(location.origin), { local: true })); } catch (e) { setError(String(e)); } };
  useEffect(() => {
    let alive = true;
    api<Listing>("/api/applications", { local: true }).then(r => { if (alive) { setApps(r.applications.filter(a => /^https?:\/\//.test(a.url))); setCasework(r.casework); setLoaded(true); } }).catch(e => { if (alive) { if (e instanceof ApiError && e.status === 401) onLocked(); setError(String(e)); } });
    return () => { alive = false; };
  }, []);
  const app = apps.find(a => a.id === params.get("app"));
  const example = casework?.apps.find(a => a.id === params.get("app"));
  if (example) return <section className="flex h-full flex-col" aria-label={example.name}>
    <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
      <button onClick={() => navigate("applications")} className="text-cyan-300">← Applications</button>
      <strong>{example.name}</strong><span className="text-zinc-500">Casework example app</span>
    </div>
    <div className="min-h-0 flex-1"><CaseworkConsole app={example} onLocked={onLocked} /></div>
  </section>;
  if (app) return <section className="flex h-full flex-col" aria-label={app.name}>
    <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
      <button onClick={() => navigate("applications")} className="text-cyan-300">← Applications</button>
      <strong>{app.name}</strong><span className="flex-1" />
      <button onClick={() => setRetry(n => n + 1)}>Reload</button>
    </div>
    <iframe key={`${app.id}-${retry}`} title={app.name} src={app.url} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen className="min-h-0 w-full flex-1 border-0 bg-black" />
  </section>;
  return <section className="h-full overflow-auto p-6"><h1 className="text-2xl font-semibold">Applications</h1><p className="mt-2 text-sm text-zinc-400">Your apps in Cyberdeck.</p>
    <button className="mt-4 rounded-lg border border-cyan-700 px-4 py-2 text-sm text-cyan-300" onClick={pair}>Connect Casework remote</button>
    {pairing && <div role="dialog" aria-label="Connect Casework" className="mt-4 max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5"><h2 className="text-lg">Connect buoy</h2><p className="my-3 text-sm text-zinc-400">In Casework, open Server settings → Scan pairing QR → Use this server. Keep Tailscale connected. {casework?.kiosk ? "This gives control of this machine’s whole Cyberdeck screen, with the deck and its example apps underneath." : "The device then runs the whole deck, with the example apps under Apps."}</p><div className="max-w-72 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: pairing.qr }} /><button className="mt-3 text-cyan-300" onClick={() => setPairing(null)}>Done</button></div>}
    {error && <p role="alert" className="mt-4 text-red-300">{error}</p>}
    <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><button onClick={() => navigate("spotify")} className="rounded-xl border border-emerald-900 bg-zinc-900 p-6 text-left hover:border-emerald-400"><span className="mb-4 block text-3xl text-emerald-400">♫</span><strong className="text-xl">Spotify</strong><p className="mt-2 text-sm text-zinc-400">Open your Spotify player with your existing login.</p><span className="mt-5 block text-sm text-emerald-400">Open Spotify →</span></button>{apps.map(a => <button key={a.id} onClick={() => navigate("applications", { app: a.id })} className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-left hover:border-cyan-500">
      <span className="mb-4 block text-3xl text-lime-300">▶</span><strong className="text-xl">{a.name}</strong><p className="mt-2 text-sm text-zinc-400">{a.description}</p><span className="mt-5 block text-sm text-cyan-300">Open {a.name} →</span>
    </button>)}{casework?.apps.map(a => <button key={a.id} data-testid={`app-${a.id}`} onClick={() => navigate("applications", { app: a.id })} className="rounded-xl border border-lime-900 bg-zinc-900 p-6 text-left hover:border-lime-400">
      <span className="mb-4 block text-3xl text-lime-300">◈</span><strong className="text-xl">{a.name}</strong><span className="hud-badge ml-3 align-middle text-lime-300">Casework example</span><p className="mt-2 text-sm text-zinc-400">{a.description}</p>
      <span className="mt-5 block text-sm text-lime-300">{inCasework() ? "Open the console, or run it on this device" : casework.devices.length ? `Open ${a.name} · ${casework.devices.length} device${casework.devices.length === 1 ? "" : "s"} connected →` : `Open ${a.name} →`}</span>
      {inCasework() && <span role="button" data-testid={`app-${a.id}-native`} onClick={e => { e.stopPropagation(); openNative(a.id); }} className="mt-3 inline-block rounded-lg border border-lime-600 px-3 py-2 text-sm text-lime-300">Run on this device →</span>}
    </button>)}</div>{loaded && !apps.length && !casework?.apps.length && <p className="mt-6 text-zinc-400">No additional applications configured on this machine.</p>}
  </section>;
}
