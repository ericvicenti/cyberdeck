import { useEffect, useState } from "react";
import { api, post, token } from "../lib/api";
import { pairingOrigin } from "../lib/pairing";

type System = { id: string; name: string; short: string; core: boolean; count: number; folder: string };
type Game = { id: string; system: string; title: string; tags: string; lastPlayed: number | null };
type Running = { id: string; title: string; system: string; startedAt: number };
type Library = { available: boolean; dir: string; systems: System[]; games: Game[]; running: Running | null; hotkeys: { keys: string; does: string }[] };

const ACCENT: Record<string, string> = { snes: "from-violet-700 to-zinc-900", n64: "from-emerald-700 to-zinc-900" };

function Card({ game, short, onPlay }: { game: Game; short: string; onPlay: () => void }) {
  const [art, setArt] = useState(true);
  return <button data-testid={`game-${game.id}`} onClick={onPlay} className="group flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-left hover:border-lime-400 focus:border-lime-400">
    <span className={`relative flex aspect-[4/3] items-center justify-center bg-gradient-to-br ${ACCENT[game.system] ?? "from-zinc-700 to-zinc-900"}`}>
      {art ? <img src={`/api/games/art/${game.id}?token=${encodeURIComponent(token())}`} alt="" loading="lazy" onError={() => setArt(false)} className="h-full w-full object-contain" />
        : <span className="px-4 text-center text-xl font-semibold text-white/90">{game.title}</span>}
      <span className="hud-badge absolute left-2 top-2 bg-zinc-950/80 text-zinc-200">{short}</span>
    </span>
    <span className="p-3"><strong className="block truncate">{game.title}</strong><span className="block truncate text-xs text-zinc-500">{game.tags || " "}</span></span>
  </button>;
}

/** Retro games on this node's own screen. Hidden on nodes without RetroArch. */
export function GamesSection() {
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState("");
  const [origin, setOrigin] = useState("");
  useEffect(() => { void pairingOrigin().then(setOrigin).catch(() => {}); }, []);
  const load = () => api<Library>("/api/games").then(setLib).catch(e => setError(String(e)));
  useEffect(() => { void load(); }, []);
  const running = lib?.running;
  useEffect(() => {
    // Keep the Now playing banner current (the deck's controller suspension lives in main.tsx).
    const t = setInterval(load, running ? 1500 : 5000);
    return () => clearInterval(t);
  }, [running?.id]);
  if (!lib?.available) return null;
  const play = async (g: Game) => {
    setError("");
    try { const r = await post<{ running: Running }>(`/api/games/${g.id}/launch`, {}); setLib(l => l && { ...l, running: r.running }); }
    catch (e) { setError(String(e)); }
  };
  const stop = async () => { await post("/api/games/stop", {}).catch(() => {}); void load(); };
  const upload = async (files: FileList | null) => {
    setError("");
    for (const f of Array.from(files ?? [])) {
      setAdding(`Adding ${f.name}…`);
      const r = await fetch(`/api/games/upload?name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { authorization: `Bearer ${token()}` }, body: f });
      if (!r.ok) setError(`${f.name}: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
    }
    setAdding("");
    void load();
  };
  const recent = lib.games.filter(g => g.lastPlayed).sort((a, b) => b.lastPlayed! - a.lastPlayed!).slice(0, 4);
  const short = (id: string) => lib.systems.find(s => s.id === id)?.short ?? id;
  return <section aria-label="Retro games" className="mt-10">
    <h2 className="text-xl font-semibold">Retro games</h2>
    <p className="mt-1 text-sm text-zinc-400">Plays fullscreen on this screen. {lib.hotkeys.map(h => `${h.keys}: ${h.does}`).join(" · ")}</p>
    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      {window.__cyberdeckInputBridge
        ? <span className="text-zinc-400">Add games from a laptop or phone: open <code className="text-zinc-200">{origin}/#/applications</code> → Add games.</span>
        : <label className="cursor-pointer rounded-lg border border-lime-700 px-4 py-2 text-lime-300 hover:border-lime-400">+ Add games<input type="file" multiple accept=".sfc,.smc,.fig,.swc,.z64,.n64,.v64,.zip" className="hidden" onChange={e => { void upload(e.currentTarget.files); e.currentTarget.value = ""; }} /></label>}
      <span className="text-zinc-500">SNES (.sfc .smc) and N64 (.z64 .n64 .v64), or zipped. Games are named and get box art from their checksum.</span>
      {adding && <span role="status" className="text-lime-300">{adding}</span>}
    </div>
    {running && <div role="status" className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-lime-700 bg-lime-950/40 p-4">
      <span className="text-lime-300">▶ Playing <strong>{running.title}</strong></span>
      <span className="text-sm text-zinc-400">Press Home (or Back + Start) on the controller to come back here.</span>
      <button onClick={stop} className="ml-auto rounded-lg border border-zinc-600 px-4 py-2 text-sm">Stop game</button>
    </div>}
    {error && <p role="alert" className="mt-3 text-red-300">{error}</p>}
    {recent.length > 0 && <>
      <h3 className="mt-6 text-sm uppercase tracking-wider text-zinc-500">Continue playing</h3>
      <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">{recent.map(g => <Card key={`r-${g.id}`} game={g} short={short(g.system)} onPlay={() => play(g)} />)}</div>
    </>}
    {lib.systems.map(s => <div key={s.id}>
      <h3 className="mt-6 text-sm uppercase tracking-wider text-zinc-500">{s.name} · {s.count} game{s.count === 1 ? "" : "s"}</h3>
      {!s.core && <p className="mt-2 text-sm text-amber-300">No {s.short} emulator core is installed.</p>}
      {s.count ? <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">{lib.games.filter(g => g.system === s.id).map(g => <Card key={g.id} game={g} short={s.short} onPlay={() => play(g)} />)}</div>
        : <p className="mt-2 text-sm text-zinc-500">Copy {s.short} ROMs into <code>{s.folder}</code>.</p>}
    </div>)}
  </section>;
}
