import { useRouteTitle, routeHash, readRoute } from "../lib/navigation";
import { isMusicRoute } from "../lib/spotify-navigation";
import { Spotify } from "./Spotify";
import { AfterglowTabs } from "./AfterglowFrame";
import { ApplicationFrames } from "./ApplicationFrames";
import { Vault } from "./Vault";
import { pairingOrigin } from "../lib/pairing";
import { useEffect, useState } from "react";
import { api, ApiError, navigate } from "../lib/api";
import { GamesSection } from "./Games";
import { CaseworkConsole, inCasework, openNative, type CaseworkApp } from "./CaseworkConsole";
type Application = { id: string; name: string; description: string; url: string };
/** The app Back returns from; its card takes focus again on the list. */
let lastApp = "";
/** `casework.apps` are the example apps that run natively in the Casework Desk app (the kitchen sink). */
type Listing = { applications: Application[]; casework?: { apps: CaseworkApp[]; devices: { id: string }[]; kiosk: boolean } };
export function Applications({ params, onLocked, visible = true }: { params: URLSearchParams; onLocked: () => void; visible?: boolean }) {
  const [apps, setApps] = useState<Application[]>([]);
  const [casework, setCasework] = useState<Listing["casework"]>();
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [listingError, setListingError] = useState("");
  const [pairing, setPairing] = useState<{ qr: string; link: string } | null>(null);
  const pair = async () => { try { setPairing(await api("/api/casework/pairing?url=" + encodeURIComponent(await pairingOrigin()))); } catch (e) { setError(String(e)); } };
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setListingError("");
    api<Listing>("/api/applications").then(r => { if (alive) { setApps(r.applications.filter(a => /^https?:\/\//.test(a.url))); setCasework(r.casework); setLoaded(true); } }).catch(e => { if (alive) { if (e instanceof ApiError && e.status === 401) onLocked(); setListingError(String(e)); } });
    return () => { alive = false; };
  }, [visible]);
  const app = apps.find(a => a.id === params.get("app"));
  if (params.get("app")) lastApp = params.get("app")!;
  const example = casework?.apps.find(a => a.id === params.get("app"));
  // Afterglow's music tab is the listening room Cyberdeck renders itself; it needs no configured app.
  const music = isMusicRoute("applications", params);
  const [musicOpened, setMusicOpened] = useState(visible && music);
  useEffect(() => { if (visible && music) setMusicOpened(true); }, [visible, music]);
  const missing = loaded && !!params.get("app") && !app && !example && !music && !["vimm", "steam"].includes(params.get("app")!);
  const listingUnavailable = !!listingError && !music && !["vimm", "steam"].includes(params.get("app") || "") && (!loaded || missing);
  useRouteTitle(!visible ? undefined : listingUnavailable ? "Applications unavailable" : missing ? "Application not found" : undefined);
  const content = () => {
  if (!visible || music) return null;
  if (listingUnavailable) return <section className="p-6"><h1 className="text-xl">Applications unavailable</h1><p role="alert" className="my-3 text-red-300">{listingError}</p><p>The requested application could not be checked. Reload to try again.</p></section>;
  if (missing) return <section className="p-6"><h1 className="text-xl">Application not found</h1><p className="my-3">“{params.get("app")}” is not configured on this machine.</p><button onClick={() => navigate("applications")}>← Applications</button></section>;
  if (params.get("app") === "vimm") return <Vault params={params} onLocked={onLocked} />;
  if (params.get("app") === "steam") return <Vault params={new URLSearchParams("tab=steam")} onLocked={onLocked} />;
  if (example) return <section className="flex h-full flex-col" aria-label={example.name}>
    <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
      <button data-tv-frame-back onClick={() => navigate("applications")} className="text-cyan-300">← Applications</button>
      <strong>{example.name}</strong><span className="text-zinc-500">Casework example app</span>
    </div>
    <div className="min-h-0 flex-1"><CaseworkConsole app={example} params={params} onLocked={onLocked} /></div>
  </section>;
  if (app) return null;
  return <section className="h-full overflow-auto p-6"><h1 className="text-2xl font-semibold">Applications</h1><p className="mt-2 text-sm text-zinc-400">Your apps in Cyberdeck.</p><button className="mt-4 mr-3 rounded-lg border border-zinc-700 px-4 py-2 text-sm" onClick={() => navigate("controls")}>Controller & keyboard controls</button>
    <button className="mt-4 rounded-lg border border-cyan-700 px-4 py-2 text-sm text-cyan-300" onClick={pair}>Connect Casework remote</button>
    {pairing && <div role="dialog" aria-label="Connect Casework" className="mt-4 max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5"><h2 className="text-lg">Connect buoy</h2><p className="my-3 text-sm text-zinc-400">In Casework, open Server settings → Scan pairing QR → Use this server. Keep Tailscale connected. {casework?.kiosk ? "This gives control of this machine’s whole Cyberdeck screen, with the deck and its example apps underneath." : "The device then runs the whole deck, with the example apps under Apps."}</p><div className="max-w-72 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: pairing.qr }} /><button className="mt-3 text-cyan-300" onClick={() => setPairing(null)}>Done</button></div>}
    {listingError && <p role="alert" className="mt-4 text-red-300">Could not refresh applications: {listingError}</p>}
    {error && <p role="alert" className="mt-4 text-red-300">{error}</p>}
    <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><button onClick={() => navigate("applications", { app: "vimm" })} className="rounded-xl border border-lime-900 bg-zinc-900 p-6 text-left hover:border-lime-400"><span className="mb-4 block text-3xl text-lime-300">◈</span><strong className="text-xl">The Vault</strong><p className="mt-2 text-sm text-zinc-400">Rediscover the classics. Browse and search Vimm’s Lair with box art, console collections, and your own saved list.</p><span className="mt-5 block text-sm text-lime-300">Explore The Vault →</span></button>{apps.map(a => <button key={a.id} data-tv-autofocus={a.id === lastApp || undefined} onClick={() => navigate("applications", { app: a.id })} className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-left hover:border-cyan-500">
      <span className="mb-4 block text-3xl text-lime-300">▶</span><strong className="text-xl">{a.name}</strong><p className="mt-2 text-sm text-zinc-400">{a.description}</p><span className="mt-5 block text-sm text-cyan-300">Open {a.name} →</span>
    </button>)}{casework?.apps.map(a => <button key={a.id} data-testid={`app-${a.id}`} onClick={() => navigate("applications", { app: a.id })} className="rounded-xl border border-lime-900 bg-zinc-900 p-6 text-left hover:border-lime-400">
      <span className="mb-4 block text-3xl text-lime-300">◈</span><strong className="text-xl">{a.name}</strong><span className="hud-badge ml-3 align-middle text-lime-300">Casework example</span><p className="mt-2 text-sm text-zinc-400">{a.description}</p>
      <span className="mt-5 block text-sm text-lime-300">{inCasework() ? "Open the console, or run it on this device" : casework.devices.length ? `Open ${a.name} · ${casework.devices.length} device${casework.devices.length === 1 ? "" : "s"} connected →` : `Open ${a.name} →`}</span>
      {inCasework() && <span role="button" data-testid={`app-${a.id}-native`} onClick={e => { e.stopPropagation(); openNative(a.id); }} className="mt-3 inline-block rounded-lg border border-lime-600 px-3 py-2 text-sm text-lime-300">Run on this device →</span>}
    </button>)}</div>{loaded && !apps.length && !casework?.apps.length && <p className="mt-6 text-zinc-400">No additional applications configured on this machine.</p>}
    <GamesSection />
  </section>;
  };
  const musicActive = visible && music;
  return <>{content()}
    {musicOpened && (
      <div className={musicActive ? "flex h-full flex-col" : "hidden"} inert={!musicActive} aria-hidden={!musicActive} data-testid="afterglow-music">
        <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
          <a data-tv-frame-back href={routeHash("applications", readRoute().params.has("node") ? { node: readRoute().params.get("node")! } : {})} className="text-cyan-300">← Applications</a>
          <strong>{app?.name ?? "Afterglow"}</strong>
          <AfterglowTabs tab="music" films={!!app} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto"><Spotify visible={musicActive} params={params} /></div>
      </div>
    )}
    <ApplicationFrames app={music ? undefined : app} params={params} visible={visible && !music} /></>;

}
