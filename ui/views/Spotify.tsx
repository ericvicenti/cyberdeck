import { useEffect, useRef, useState } from "react";
import { connectSpotify, disconnectSpotify, finishSpotifyLogin, loadSpotifySdk, spotifyApi, spotifyClientId, spotifyConnected, spotifyRedirect, spotifyToken, spotifyUri, type SpotifyDevice, type SpotifyPlayback, type SpotifyPlayer, type SpotifyPlaylist, type SpotifyTrack } from "../lib/spotify";
import { MusicIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipFwdIcon } from "../lib/icons";

const button = "rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm hover:border-emerald-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed";
const primary = button + " border-emerald-600 bg-emerald-950 text-emerald-200";
const input = "min-w-0 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-400";
const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function Spotify({ visible }: { visible: boolean }) {
  const [connected, setConnected] = useState(spotifyConnected);
  const [clientId, setClientId] = useState(spotifyClientId);
  const [webQuery, setWebQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<SpotifyTrack[]>([]);
  const [searched, setSearched] = useState(false);
  const [devices, setDevices] = useState<SpotifyDevice[]>([]);
  const [selected, setSelected] = useState("");
  const [browserId, setBrowserId] = useState("");
  const [sdkStatus, setSdkStatus] = useState("");
  const [playback, setPlayback] = useState<SpotifyPlayback | null>(null);
  const [seek, setSeek] = useState<number | null>(null);
  const [volume, setVolume] = useState(50);
  const player = useRef<SpotifyPlayer | null>(null);
  const sdkGeneration = useRef(0);
  const alive = useRef(true);
  const accountGeneration = useRef(0);
  const queryGeneration = useRef(0);
  let redirect = "";
  let originError = "";
  try { redirect = spotifyRedirect(); } catch (e) { originError = (e as Error).message; }

  const report = (e: unknown) => { if (alive.current) { setError((e as Error).message || "Spotify is unavailable."); setConnected(spotifyConnected()); } };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { report(e); } finally { if (alive.current) setBusy(false); }
  };
  const refreshDevices = async () => {
    const version = accountGeneration.current;
    const data = await spotifyApi<{ devices: SpotifyDevice[] }>("/me/player/devices");
    if (alive.current && version === accountGeneration.current) setDevices(data.devices.filter(d => d.id && !d.is_restricted));
  };
  const refreshPlayback = async () => {
    const version = accountGeneration.current;
    const state = await spotifyApi<SpotifyPlayback | null>("/me/player");
    if (alive.current && version === accountGeneration.current) { setPlayback(state); if (state?.device.volume_percent != null) setVolume(state.device.volume_percent); }
  };
  const loadPlaylists = async (offset = 0) => {
    const version = accountGeneration.current;
    const data = await spotifyApi<{ items: (SpotifyPlaylist | null)[]; next: string | null }>(`/me/playlists?limit=50&offset=${offset}`);
    if (alive.current && version === accountGeneration.current) { setPlaylists(old => offset ? [...old, ...data.items.filter(Boolean) as SpotifyPlaylist[]] : data.items.filter(Boolean) as SpotifyPlaylist[]); setMore(!!data.next); }
  };
  useEffect(() => {
    alive.current = true;
    finishSpotifyLogin().then(() => { if (alive.current) setConnected(spotifyConnected()); }).catch(report);
    return () => { alive.current = false; sdkGeneration.current++; player.current?.disconnect(); player.current = null; };
  }, []);
  useEffect(() => {
    if (!connected) { sdkGeneration.current++; player.current?.disconnect(); player.current = null; setBrowserId(""); return; }
    let canceled = false;
    const init = async () => {
      const results = await Promise.allSettled([
        spotifyApi<{ display_name: string }>("/me").then(me => { if (!canceled) setName(me.display_name); }),
        loadPlaylists(), refreshDevices(), refreshPlayback(),
      ]);
      if (!canceled) for (const result of results) if (result.status === "rejected") report(result.reason);
    };
    void init();
    return () => { canceled = true; };
  }, [connected]);
  useEffect(() => {
    if (!connected || !visible) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) try { await refreshPlayback(); } catch (e) { if (!canceled) report(e); }
      if (!canceled) timer = setTimeout(poll, 10000);
    };
    timer = setTimeout(poll, 10000);
    return () => { canceled = true; clearTimeout(timer); };
  }, [connected, visible]);

  const enableBrowser = async () => {
    player.current?.disconnect(); player.current = null; setBrowserId("");
    const version = ++sdkGeneration.current;
    setSdkStatus("Connecting browser…");
    try {
      await loadSpotifySdk();
      if (!alive.current || version !== sdkGeneration.current) return;
      const p = new window.Spotify!.Player({ name: "Cyberdeck", getOAuthToken: cb => { spotifyToken().then(cb).catch(report); }, volume: 0.5 });
      player.current = p;
      const valid = () => alive.current && version === sdkGeneration.current;
      p.addListener("ready", ({ device_id }) => { if (valid()) { setBrowserId(device_id); setSelected(current => current || device_id); setSdkStatus("Browser ready"); void refreshDevices().catch(report); } });
      p.addListener("not_ready", () => { if (valid()) { setBrowserId(""); setSdkStatus("Browser offline — enable playback to reconnect"); } });
      p.addListener("player_state_changed", () => { /* Web API polling also reflects other Connect devices. */ });
      for (const event of ["initialization_error", "authentication_error", "account_error", "playback_error"]) p.addListener(event, ({ message }) => { if (valid()) { setError(message); setSdkStatus("Browser playback unavailable"); } });
      p.addListener("autoplay_failed", () => { if (valid()) setError("Your browser blocked autoplay. Press Play here to allow audio."); });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const ok = await Promise.race([p.connect(), new Promise<boolean>((_, reject) => { timeout = setTimeout(() => reject(new Error("Spotify browser connection timed out. Retry or choose another Spotify device.")), 20000); })]);
        if (!ok) throw new Error("This browser cannot play Spotify. Try a browser with protected-content playback enabled, or choose another Spotify device.");
      } finally { clearTimeout(timeout); }
    } catch (e) { if (version === sdkGeneration.current) { player.current?.disconnect(); player.current = null; setSdkStatus("Browser playback unavailable"); } throw e; }
  };
  const target = selected || playback?.device.id || browserId;
  const deviceQuery = target ? `?device_id=${encodeURIComponent(target)}` : "";
  const activate = () => target === browserId && player.current ? player.current.activateElement() : Promise.resolve();
  const playUri = async (uri?: string) => {
    if (!target) throw new Error("Enable browser playback or choose a Spotify device first.");
    await activate();
    await spotifyApi("/me/player/play" + deviceQuery, "PUT", uri ? uri.startsWith("spotify:track:") ? { uris: [uri] } : { context_uri: uri } : undefined);
    await refreshPlayback();
  };
  const command = async (path: string, method = "PUT") => {
    await spotifyApi("/me/player/" + path + deviceQuery, method); await refreshPlayback();
  };
  const search = async () => {
    const version = ++queryGeneration.current;
    const data = await spotifyApi<{ tracks: { items: SpotifyTrack[] } }>(`/search?${new URLSearchParams({ q: query.trim(), type: "track", limit: "10" })}`);
    if (version === queryGeneration.current && alive.current) { setTracks(data.tracks.items); setSearched(true); }
  };
  const disconnect = () => {
    accountGeneration.current++; sdkGeneration.current++; queryGeneration.current++;
    player.current?.disconnect(); player.current = null;
    disconnectSpotify(); setConnected(false); setName(""); setPlaylists([]); setTracks([]); setDevices([]); setPlayback(null); setBrowserId(""); setSelected(""); setError(""); setSdkStatus(""); setSearched(false);
  };
  useEffect(() => { setSeek(null); }, [playback?.item?.id]);
  const track = playback?.item;
  const activeTarget = !!playback && playback.device.id === target;
  const uri = spotifyUri(query.trim());
  const availableDevices = devices.filter(d => d.id !== browserId);
  return <section className={visible ? "h-full overflow-y-auto p-4 sm:p-6" : "hidden"} aria-label="Spotify music" data-testid="spotify-app">
    <div className="mx-auto max-w-5xl space-y-6 pb-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><div className="rounded-xl border border-emerald-700 bg-emerald-950 p-3 text-emerald-400"><MusicIcon size={28} /></div><div><h1 className="text-2xl font-semibold text-white">Spotify</h1><p className="text-sm text-zinc-400">Your music, in Cyberdeck.</p></div></div>
        <div className="flex items-center gap-3 text-sm"><a className="text-emerald-400 hover:underline" href="https://open.spotify.com" target="_blank" rel="noreferrer">Open Spotify ↗</a>{connected && <button className={button} onClick={disconnect}>Disconnect</button>}</div>
      </header>
      {error && <div role="alert" className="rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">{error}</div>}
      {!connected ? <div className="space-y-6">
        <div className="rounded-xl border border-emerald-900 bg-gradient-to-br from-emerald-950/50 to-zinc-900/50 p-6 sm:p-8 space-y-5">
          <h2 className="text-2xl font-semibold text-white">Just open Spotify and play.</h2>
          <p className="max-w-2xl text-sm leading-6 text-zinc-400">Your playlists, saved music, and recommendations are already there. Use your existing Spotify login and subscription.</p>
          <div className="flex flex-wrap gap-3">
            <a className={primary + " inline-flex items-center gap-2"} href="https://open.spotify.com/" target="_blank" rel="noreferrer" data-testid="spotify-open-player"><PlayIcon size={18} />Open Spotify player ↗</a>
            <a className={button} href="spotify:">Open Spotify app</a>
          </div>
          <p className="text-xs leading-5 text-zinc-500">The full player opens in its own tab. Keep it open and your music continues while you use Cyberdeck. The app button opens Spotify if it is installed on this device.</p>
        </div>
        <form className="rounded-xl border border-zinc-800 p-6 space-y-3" action="https://open.spotify.com/search" target="_blank" onSubmit={e => { e.preventDefault(); if (webQuery.trim()) window.open(`https://open.spotify.com/search/${encodeURIComponent(webQuery.trim())}`, "_blank", "noopener,noreferrer"); }}>
          <label htmlFor="spotify-web-search" className="block text-sm text-white">Find something to listen to</label>
          <div className="flex gap-2"><input id="spotify-web-search" className={input + " flex-1"} value={webQuery} onChange={e => setWebQuery(e.target.value)} placeholder="Song, artist, album, or playlist" /><button className={button} disabled={!webQuery.trim()}>Search Spotify ↗</button></div>
        </form>
        <details className="rounded-xl border border-zinc-800 p-5" data-testid="spotify-advanced"><summary className="cursor-pointer text-sm text-zinc-500 hover:text-zinc-300">Advanced: custom Cyberdeck player</summary><p className="my-4 text-sm leading-6 text-zinc-400">Optional: enable custom playback controls inside Cyberdeck using Spotify’s developer API. This requires a Developer app; opening the standard Spotify player above does not.</p>
        <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-5"><h2 className="text-xl text-white">Bring your subscription</h2><p className="text-sm leading-6 text-zinc-400">Sign in with your existing Spotify Premium account to play full songs here, browse your playlists, and control your other Spotify devices.</p>
          <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => connectSpotify(clientId)); }}><label className="block text-sm" htmlFor="spotify-client-id">Spotify Client ID</label><input id="spotify-client-id" className={input + " w-full font-mono"} placeholder="Paste your app’s public Client ID" value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off" /><button className={primary + " w-full"} disabled={busy || !!originError || !clientId.trim()}>{busy ? "Connecting…" : "Connect Spotify"}</button></form>
          <p className="text-xs leading-5 text-zinc-500">Sign-in happens on Spotify. No password or client secret is needed here. Your connection lasts for this browser tab; your public Client ID is remembered.</p>
        </div>
        <div className="rounded-xl border border-zinc-800 p-6 space-y-4"><h2 className="text-lg text-white">One-time setup</h2><ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-zinc-400"><li>Open the <a className="text-emerald-400 underline" href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">Spotify Developer Dashboard</a> and create an app using your Premium account.</li><li>Select Web API and Web Playback SDK. Add this exact Redirect URI:<code className="mt-2 block break-all rounded bg-zinc-900 p-2 text-emerald-300" data-testid="spotify-redirect">{redirect || "HTTPS or loopback required"}</code></li><li>Save the app, copy its Client ID, and paste it here. If signing in with a different account, add that account under User Management first.</li></ol>{originError && <p role="alert" className="text-sm text-amber-300">{originError}</p>}</div>
        </div></details>
      </div> : <>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <span className="mr-auto text-sm text-zinc-400">{name ? `Connected as ${name}` : "Connected to Spotify"}</span>
          <button className={button} disabled={busy} onClick={() => void run(enableBrowser)}>{browserId ? "Reconnect browser" : "Enable browser playback"}</button>
          <span className="text-xs text-zinc-500" role="status">{sdkStatus}</span>
          <label className="flex items-center gap-2 text-sm">Play on<select aria-label="Playback device" className={input + " max-w-56"} value={selected} onChange={e => setSelected(e.target.value)}><option value="">{playback?.device.name ? `Active: ${playback.device.name}` : "Choose a device"}</option>{browserId && <option value={browserId}>This browser · Cyberdeck</option>}{availableDevices.map(d => <option key={d.id} value={d.id!}>{d.name}{d.is_active ? " · active" : ""}</option>)}</select></label>
          <button className={button} disabled={busy} onClick={() => void run(refreshDevices)}>Refresh devices</button>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-gradient-to-br from-emerald-950/60 to-zinc-900 p-5">
          <div className="flex items-center gap-5">{track?.album?.images?.[0] ? <img src={track.album.images[0].url} alt="Album artwork" className="h-24 w-24 shrink-0 rounded shadow-lg sm:h-36 sm:w-36" /> : <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded bg-zinc-800 text-emerald-400 sm:h-36 sm:w-36"><MusicIcon size={44} /></div>}<div className="min-w-0"><p className="mb-2 text-xs uppercase tracking-widest text-emerald-400">{playback?.is_playing ? "Now playing" : "Ready when you are"}</p><h2 className="break-words text-xl font-semibold text-white sm:text-2xl">{track?.name || "Find your next soundtrack"}</h2><p className="mt-1 text-sm text-zinc-400">{track?.artists?.map(a => a.name).join(", ") || "Choose a device, then play a song or playlist."}</p>{track?.external_urls?.spotify && <a className="mt-2 inline-block text-xs text-emerald-400 hover:underline" href={track.external_urls.spotify} target="_blank" rel="noreferrer">Listen on Spotify ↗</a>}{playback?.device && <p className="mt-2 text-xs text-zinc-500">Playing on {playback.device.name}</p>}</div></div>
          <div className="mt-5 flex flex-wrap items-center gap-3"><button aria-label="Previous track" className={button} disabled={busy || !activeTarget} onClick={() => void run(() => command("previous", "POST"))}><SkipBackIcon /></button><button aria-label={activeTarget && playback?.is_playing ? "Pause" : "Play"} className={primary} disabled={busy || !target} onClick={() => void run(() => activeTarget && playback?.is_playing ? command("pause") : playUri())}>{activeTarget && playback?.is_playing ? <PauseIcon /> : <PlayIcon />}</button><button aria-label="Next track" className={button} disabled={busy || !activeTarget} onClick={() => void run(() => command("next", "POST"))}><SkipFwdIcon /></button><button className={button} disabled={busy || !target} onClick={() => void run(async () => { await activate(); await spotifyApi("/me/player", "PUT", { device_ids: [target], play: true }); await refreshPlayback(); })}>Listen here</button><span className="text-xs text-zinc-500">Audio continues while you browse Cyberdeck.</span></div>
          {track && <div className="mt-4 flex items-center gap-3 text-xs text-zinc-400"><span>{time(seek ?? playback?.progress_ms ?? 0)}</span><input aria-label="Playback position" type="range" className="min-w-0 flex-1 accent-emerald-500" min={0} max={track.duration_ms} value={seek ?? playback?.progress_ms ?? 0} disabled={busy || !activeTarget} onChange={e => setSeek(Number(e.target.value))} /><span>{time(track.duration_ms)}</span><button className={button} disabled={seek === null || busy || !activeTarget} onClick={() => void run(async () => { await spotifyApi(`/me/player/seek?position_ms=${seek}&device_id=${encodeURIComponent(target!)}`, "PUT"); setSeek(null); await refreshPlayback(); })}>Seek</button></div>}
          {activeTarget && playback.device.supports_volume !== false && playback.device.volume_percent !== null && <form className="mt-3 flex items-center gap-3" onSubmit={e => { e.preventDefault(); void run(async () => { await spotifyApi(`/me/player/volume?volume_percent=${volume}&device_id=${encodeURIComponent(target!)}`, "PUT"); }); }}><label className="text-xs text-zinc-400" htmlFor="spotify-volume">Volume</label><input id="spotify-volume" type="range" min={0} max={100} className="min-w-0 max-w-40 accent-emerald-500" value={volume} onChange={e => setVolume(Number(e.target.value))} /><button className={button} disabled={busy}>Set {volume}%</button></form>}
        </div>
        <div className="space-y-4"><form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void run(uri ? () => playUri(uri) : search); }}><input aria-label="Search Spotify" className={input + " flex-1"} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search songs or paste a Spotify link" /><button className={primary} disabled={busy || !query.trim()}>{uri ? "Play link" : "Search"}</button></form>
          {searched && <div className="space-y-2"><h2 className="text-lg text-white">Search results</h2>{tracks.length === 0 && <p className="text-sm text-zinc-500">No songs found. Try another search.</p>}{tracks.map(t => <div key={t.id} className="flex items-center gap-3 rounded border border-zinc-800 p-3">{t.album.images[0] && <img src={t.album.images[0].url} alt="" className="h-12 w-12 rounded" />}<div className="min-w-0 flex-1"><a href={t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`} target="_blank" rel="noreferrer" className="block truncate text-sm text-white hover:underline">{t.name}</a><p className="truncate text-xs text-zinc-500">{t.artists.map(a => a.name).join(", ")}</p></div><span className="hidden text-xs text-zinc-500 sm:block">{time(t.duration_ms)}</span><button className={button} aria-label={`Play ${t.name}`} disabled={busy || !target} onClick={() => void run(() => playUri(t.uri))}><PlayIcon size={18} /></button></div>)}</div>}
        </div>
        <div className="space-y-4"><h2 className="text-lg text-white">Your playlists</h2>{playlists.length === 0 && <p className="text-sm text-zinc-500">Your Spotify playlists will appear here.</p>}<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{playlists.map(p => <div key={p.id} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">{p.images?.[0] ? <img src={p.images[0].url} alt="" className="mb-3 aspect-square w-full rounded" /> : <div className="mb-3 flex aspect-square items-center justify-center rounded bg-zinc-800 text-zinc-500"><MusicIcon size={40} /></div>}<a href={p.external_urls?.spotify || `https://open.spotify.com/playlist/${p.id}`} target="_blank" rel="noreferrer" className="mb-3 block truncate text-sm hover:underline">{p.name}</a><button className={button + " w-full"} disabled={busy || !target} onClick={() => void run(() => playUri(p.uri))}>Play playlist</button></div>)}</div>{more && <button className={button} disabled={busy} onClick={() => void run(() => loadPlaylists(playlists.length))}>More playlists</button>}</div>
      </>}
    </div>
  </section>;
}
