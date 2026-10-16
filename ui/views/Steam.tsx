import { updateParams, useRouteTitle } from "../lib/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, navigate } from "../lib/api";
import type { SteamGame, SteamLibrary, SteamSession } from "../../src/shared/steam";

function LaunchDecision({ session, done }: { session: SteamSession; done: () => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { ref.current?.showModal(); ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); return () => ref.current?.close(); }, []);
  const choose = async (choice: "cancel" | "local" | "cloud") => {
    setBusy(true); setError("");
    try { await api("/api/steam/respond", { method: "POST", local: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ choice }) }); await done(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const conflict = session.prompt?.kind === "cloudconflict";
  return <dialog ref={ref} className="vault-dialog vault" aria-labelledby="steam-decision-title" onCancel={e => { e.preventDefault(); if (!busy) void choose("cancel"); }}>
    <div className="vault-detail-copy"><span className="vault-eyebrow">{session.name}</span><h2 id="steam-decision-title">{conflict ? "Choose your saved progress" : "Cloud saves need your attention"}</h2>
      <p className="vault-detail-note">{conflict ? "Steam found different saves on this machine and in the cloud. The version you choose will replace the other version." : session.prompt?.kind === "pendingcloudsessions" ? "Another device may still be playing or uploading saves. Continuing now could use older progress." : "Steam could not sync your cloud saves. You can cancel and retry, or play using this machine’s saves. Your latest progress from another device may be missing."}</p>
      {error && <p role="alert" className="vault-warning">{error}</p>}
      <div className="vault-detail-buttons"><button className="vault-primary" disabled={busy} onClick={() => void choose("cancel")}>Cancel launch</button><button className="vault-secondary" disabled={busy} onClick={() => void choose("local")}>{conflict ? "Use this machine’s saves" : "Play with local saves"}</button>{conflict && <button className="vault-secondary" disabled={busy} onClick={() => void choose("cloud")}>Use cloud saves</button>}</div>
    </div>
  </dialog>;
}

/** Steam is a collection inside The Vault, never a second library application. */
export function SteamVault({ params, query = "", expanded = false, onSupported, onLocked }: { params: URLSearchParams; query?: string; expanded?: boolean; onSupported?: (supported: boolean) => void; onLocked: () => void }) {
  const [library, setLibrary] = useState<SteamLibrary>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const selectedId = params.get("steam") ?? "";
  const selected = library?.games.find(g => g.id === selectedId);
  const setSelected = (game: SteamGame | null) => updateParams({ steam: game?.id ?? null });
  useRouteTitle(selected ? `${selected.name} · The Vault` : selectedId && library ? "Game not found · The Vault" : undefined);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = async () => {
    const value = await api<SteamLibrary>("/api/steam", { local: true });
    setLibrary(value); onSupported?.(value.supported);
  };
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const value = await api<SteamLibrary>("/api/steam", { local: true });
        if (alive) { setLibrary(value); onSupported?.(value.supported); }
      } catch (e) { if (alive && e instanceof ApiError && e.status === 401) onLocked(); }
    };
    void load(); const timer = setInterval(load, 3000);
    window.addEventListener("focus", load);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", load); };
  }, []);
  useEffect(() => {
    if (!selected) return;
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLButtonElement>(".vault-primary")?.focus();
    return () => { dialog.current?.close(); before?.focus(); };
  }, [selected?.id]);
  const play = async (game: SteamGame) => {
    setBusy(game.id); setError("");
    try {
      await api(`/api/steam/games/${game.id}/play`, { local: true, method: "POST" });
      setSelected(null); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  };
  const quit = async () => {
    setBusy("quit");
    try { await api("/api/steam/stop", { local: true, method: "POST" }); setConfirmQuit(false); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  };
  if (!library?.supported) return library && selectedId ? <p role="alert" className="vault-warning">Steam games are unavailable on this machine.</p> : null;
  const games = library.games.filter(g => g.compatible !== false && g.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const session = library.session;
  const active = session && !["ended", "error"].includes(session.phase);
  return <section className="vault-shelf" aria-label="Steam games">
    <div className="vault-section-heading"><div><span className="vault-eyebrow">YOUR STEAM COLLECTION · {library.node}</span><h2>{expanded ? "Your PC games" : query ? "PC games matching your search" : "From your Steam library"}</h2></div>
      {!expanded && <button className="vault-secondary" onClick={() => navigate("applications", { app: "vimm", tab: "steam" })}>Browse all →</button>}
    </div>
    <p className="vault-detail-note">Play here. Press Home or Back + Start during a game to return to The Vault. Your game stays open so you can resume.</p>
    {library.reason && <p className="vault-warning">{library.reason}</p>}
    {(error || session?.error) && <p role="alert" className="vault-warning">{error || session?.error}</p>}
    {active && <div className="vault-steam-session" role="status">
      <div><strong>{session.name}</strong><p>{session.phase === "installing" ? `Downloading${session.progress ? ` · ${Math.round(session.progress)}%` : ""}… The game will open when ready.` : session.phase === "launching" ? "Starting your game…" : session.phase === "attention" ? "Choose how to continue in The Vault." : "Your game is still open."}</p></div>
      {["returned", "running"].includes(session.phase) && <button className="vault-primary" disabled={Boolean(busy)} onClick={() => { const game = library.games.find(g => g.id === session.id); if (game) void play(game); }}>Resume</button>}
      <button className="vault-secondary" disabled={Boolean(busy)} onClick={() => setConfirmQuit(true)}>{session.phase === "installing" ? "Cancel download" : "Quit game"}</button>
    </div>}
    {session?.phase === "attention" && session.prompt && <LaunchDecision key={session.prompt.action} session={session} done={refresh} />}
    {confirmQuit && <div role="alertdialog" aria-label="Quit game?" className="vault-steam-session"><p>{session?.phase === "installing" ? `Cancel downloading ${session.name}? Downloaded files will be kept.` : `Quit ${session?.name}? Unsaved progress may be lost.`}</p><button className="vault-primary" autoFocus onClick={() => setConfirmQuit(false)}>Keep playing</button><button className="vault-secondary" disabled={Boolean(busy)} onClick={quit}>Quit game</button></div>}
    {!games.length ? <p className="vault-detail-note">{query ? "No PC games match this search." : library.connected ? "Your Steam games will appear here." : "Your Steam library will appear when the background client connects."}</p> :
      <div className={expanded || query ? "vault-grid" : "vault-rail"}>{games.map(game => <button key={game.id} className="vault-card" aria-label={`View ${game.name}`} onClick={() => { setError(""); setSelected(game); }}>
        <div className="vault-card-image"><div className="vault-art vault-art-box"><img src={`https://cdn.akamai.steamstatic.com/steam/apps/${game.id}/library_600x900.jpg`} alt={`${game.name} cover`} loading="lazy" referrerPolicy="no-referrer" onError={e => { const img = e.currentTarget; if (!img.dataset.fallback) { img.dataset.fallback = "1"; img.src = `https://cdn.akamai.steamstatic.com/steam/apps/${game.id}/header.jpg`; } else img.style.visibility = "hidden"; }} /></div><span className="vault-card-open">Play →</span></div>
        <strong>{game.name}</strong><span className="vault-card-meta">{game.status === 4 ? "Running" : game.ready ? "Ready to play" : "Download on Play"}<b>STEAM</b></span>
      </button>)}</div>}
    {selectedId && !selected && <p role="alert" className="vault-warning">Game not found in this machine’s Steam library. <button onClick={() => setSelected(null)}>Close</button></p>}
    {selected && <dialog ref={dialog} className="vault-dialog vault" aria-labelledby="steam-detail-title" onCancel={e => { e.preventDefault(); setSelected(null); }} onClick={e => { if (e.target === dialog.current) setSelected(null); }}>
      <div className="vault-detail"><button className="vault-close" aria-label="Close" onClick={() => setSelected(null)}>×</button>
        <div className="vault-detail-art"><div className="vault-art vault-art-box"><img src={`https://cdn.akamai.steamstatic.com/steam/apps/${selected.id}/library_600x900.jpg`} alt="" /></div></div>
        <div className="vault-detail-copy"><span className="vault-eyebrow">PC · STEAM</span><h2 id="steam-detail-title">{selected.name}</h2>
          <p className="vault-detail-note">{selected.ready ? "Ready to play on this machine." : "Downloads automatically when you press Play."}</p>
          <div className="vault-detail-buttons"><button className="vault-primary" disabled={!library.available || !library.connected || Boolean(busy)} onClick={() => void play(selected)}>{busy === selected.id ? "Starting…" : "Play"}</button></div>
          <p className="vault-detail-note">Home or Back + Start returns to The Vault.</p>{error && <p role="alert" className="vault-warning">{error}</p>}
        </div></div>
    </dialog>}
  </section>;
}
