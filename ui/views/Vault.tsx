import { SteamVault } from "./Steam";
import { VaultPlayer } from "./VaultPlayer";
import { PLAYER_SYSTEMS } from "../../src/shared/vault-player";
import { listRoms, type StoredRom } from "../lib/vault-storage";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, ApiError, navigate, token } from "../lib/api";
import { updateParams, useRouteTitle } from "../lib/navigation";
import {
  VIMM_SYSTEMS,
  systemName,
  type VaultGame,
  type VaultShelf,
  type VaultCatalog,
  type VaultHome,
} from "../../src/shared/vimm";
import "./vault.css";

const LIST_KEY = "cyberdeck-vault-list-v1";
function readList(): VaultGame[] {
  try {
    const data = JSON.parse(localStorage.getItem(LIST_KEY) ?? "[]");
    return Array.isArray(data)
      ? data
          .filter(
            (g) =>
              g &&
              /^\d{1,8}$/.test(g.id) &&
              typeof g.title === "string" &&
              typeof g.system === "string" &&
              Array.isArray(g.regions) &&
              g.regions.every((r: unknown) => typeof r === "string") &&
              (g.rating == null || typeof g.rating === "number") &&
              (g.version == null || typeof g.version === "string") &&
              (g.manual == null || typeof g.manual === "string"),
          )
          .slice(0, 500)
      : [];
  } catch {
    return [];
  }
}
function Artwork({
  game,
  type = "box",
  eager = false,
}: {
  game: VaultGame;
  type?: "box" | "screen";
  eager?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let objectUrl = "";
    setFailed(false);
    setUrl("");
    fetch(`/api/vimm/image/${game.id}?type=${type}`, {
      headers: { authorization: `Bearer ${token()}` },
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const blob = await r.blob();
        if (!controller.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, game.id, type]);
  return (
    <div ref={ref} className={`vault-art vault-art-${type}`}>
      {url && !failed ? (
        <>
          <img
            className="vault-art-backdrop"
            src={url}
            alt=""
            aria-hidden="true"
          />
          <img
            src={url}
            alt={
              type === "box"
                ? `${game.title} cover`
                : `${game.title} screenshot`
            }
            onLoad={(e) => {
              if (
                e.currentTarget.naturalWidth === 400 &&
                e.currentTarget.naturalHeight === 100
              )
                setFailed(true);
            }}
            onError={() => setFailed(true)}
          />
        </>
      ) : (
        <div className="vault-art-fallback">
          <span>{game.system}</span>
          <b>{game.title}</b>
          <small>{failed ? "Artwork unavailable" : "THE VAULT"}</small>
        </div>
      )}
    </div>
  );
}
function GameCard({
  game,
  open,
  saved,
}: {
  game: VaultGame;
  open: (game: VaultGame) => void;
  saved: boolean;
}) {
  return (
    <button
      className="vault-card"
      onClick={() => open(game)}
      aria-label={`View ${game.title}${
        game.regions.length ? ` (${game.regions.join(", ")})` : ""
      }`}
    >
      <div className="vault-card-image">
        <Artwork game={game} />
        {saved && (
          <span className="vault-saved-badge" aria-label="Saved">
            ✓
          </span>
        )}
        <span className="vault-card-open">Explore game ↗</span>
      </div>
      <strong>{game.title}</strong>
      <span className="vault-card-meta">
        {game.regions.join(" / ") || systemName(game.system)}
        {game.rating != null && <b>★ {game.rating.toFixed(1)}</b>}
      </span>
    </button>
  );
}
function Shelf({
  shelf,
  open,
  saved,
  browse,
}: {
  shelf: VaultShelf;
  open: (g: VaultGame) => void;
  saved: VaultGame[];
  browse: (id: string) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  return (
    <section className="vault-shelf">
      <div className="vault-section-heading">
        <div>
          <span className="vault-eyebrow">{shelf.title}</span>
          <h2>{systemName(shelf.system)}</h2>
        </div>
        <div className="vault-rail-actions">
          <button onClick={() => browse(shelf.system)}>Browse all ↗</button>
          <button
            aria-label={`Scroll ${systemName(shelf.system)} left`}
            onClick={() =>
              rail.current?.scrollBy({ left: -600, behavior: "smooth" })
            }
          >
            ←
          </button>
          <button
            aria-label={`Scroll ${systemName(shelf.system)} right`}
            onClick={() =>
              rail.current?.scrollBy({ left: 600, behavior: "smooth" })
            }
          >
            →
          </button>
        </div>
      </div>
      <div className="vault-rail" ref={rail}>
        {shelf.games.map((g) => (
          <GameCard
            key={g.id}
            game={g}
            open={open}
            saved={saved.some((s) => s.id === g.id)}
          />
        ))}
      </div>
    </section>
  );
}
function Detail({
  game,
  close,
  saved,
  toggle,
  play,
}: {
  game: VaultGame;
  close: () => void;
  saved: boolean;
  toggle: () => void;
  play: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLButtonElement>(".vault-primary:not(:disabled)")?.focus();
    return () => {
      dialog.current?.close();
      prior?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="vault-dialog vault"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={close}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
      aria-labelledby="vault-detail-title"
    >
      <div className="vault-detail">
        <button
          className="vault-close"
          onClick={close}
          aria-label="Close"
        >
          ×
        </button>
        <div className="vault-detail-art">
          <Artwork game={game} type="box" eager />
        </div>
        <div className="vault-detail-copy">
          <span className="vault-eyebrow">
            {systemName(game.system)} · VIMM’S LAIR
          </span>
          <h2 id="vault-detail-title">{game.title}</h2>
          <div className="vault-detail-tags">
            {game.rating != null && (
              <span className="vault-rating">
                ★ {game.rating.toFixed(1)} / 10
              </span>
            )}
            {game.regions.map((r) => (
              <span key={r}>{r}</span>
            ))}
            {game.version && <span>Version {game.version}</span>}
          </div>
          <div className="vault-detail-buttons">
            <button className="vault-primary" autoFocus disabled={!PLAYER_SYSTEMS[game.system]} onClick={play}>Play</button>
          </div>
          {!PLAYER_SYSTEMS[game.system] && <p className="vault-detail-note">Playback for this console is not available yet.</p>}

        </div>
      </div>
    </dialog>
  );
}

export function Vault({
  params,
  onLocked,
}: {
  params: URLSearchParams;
  onLocked: () => void;
}) {
  const rawTab = params.get("tab") ?? "discover";
  const tab = ["discover", "consoles", "saved", "steam"].includes(rawTab)
    ? rawTab
    : "discover";
  const rawSystem = params.get("system") ?? "";
  const system = VIMM_SYSTEMS.some(([id]) => id === rawSystem)
    ? rawSystem
    : "";
  const rawQuery = params.get("q") ?? "";
  const trimmedQuery = rawQuery.trim().slice(0, 120);
  const q = trimmedQuery.length >= 3 ? trimmedQuery : "";
  const rawLetter = params.get("letter") ?? "";
  const letter = /^(number|[A-Z])$/.test(rawLetter) ? rawLetter : "";
  const rawPage = params.get("page") ?? "";
  const page = /^\d{1,4}$/.test(rawPage)
    ? Math.max(1, Number(rawPage))
    : 1;
  const requestedGame = /^\d{1,8}$/.test(params.get("game") ?? "")
    ? params.get("game")!
    : "";
  const [steamSupported, setSteamSupported] = useState(false);
  const [playing, setPlaying] = useState<VaultGame | null>(null);
  const launch = async (game: VaultGame) => {
    // Finish entering the fullscreen top layer before opening the modal above it.
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.().catch(() => {});
    setPlaying(game);
    setSelected(null);
    updateParams({ game: null }, "replace");
  };
  const [playLibrary, setPlayLibrary] = useState<StoredRom[]>([]);
  const refreshPlayLibrary = () => {
    void listRoms()
      .then(setPlayLibrary)
      .catch(() => {});
  };
  useEffect(refreshPlayLibrary, []);
  const [query, setQuery] = useState(q),
    [searchSystem, setSearchSystem] = useState(system);
  const [saved, setSaved] = useState(readList),
    [selected, setSelected] = useState<VaultGame | null>(null);
  const [shelves, setShelves] = useState<VaultShelf[]>([]),
    [catalog, setCatalog] = useState<VaultCatalog | null>(null);
  const [error, setError] = useState(""),
    [warnings, setWarnings] = useState<string[]>([]),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0),
    [saveError, setSaveError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const go = (values: Record<string, string> = {}) =>
    navigate("applications", { app: "vimm", ...values });
  useEffect(() => {
    const changes: Record<string, string | null> = {};
    if (rawTab !== tab || (params.has("tab") && tab === "discover")) changes.tab = null;
    if (rawSystem !== system) changes.system = null;
    if (rawQuery !== q) changes.q = q || null;
    if (rawLetter !== letter || (letter && !system)) changes.letter = null;
    if (rawPage && (rawPage !== String(page) || page === 1)) changes.page = page === 1 ? null : String(page);
    if (tab !== "discover") {
      changes.system = null;
      changes.letter = null;
      changes.page = null;
      if (tab !== "steam") changes.q = null;
    }
    if (params.has("game") && !requestedGame) changes.game = null;
    if (Object.keys(changes).length) updateParams(changes, "replace");
  }, [rawTab, tab, rawSystem, system, rawQuery, q, rawLetter, letter, rawPage, page, requestedGame]);
  useEffect(() => {
    setQuery(q);
    setSearchSystem(system);
  }, [q, system]);
  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
    const controller = new AbortController();
    setError("");
    setWarnings([]);
    setCatalog(null);
    setShelves([]);
    if (tab === "saved" || tab === "consoles" || tab === "steam") {
      setLoading(false);
      return;
    }
    setLoading(true);
    const path =
      !q && !system
        ? "/api/vimm/home"
        : `/api/vimm/catalog?${new URLSearchParams({
            system,
            q,
            letter,
            page: String(page),
          })}`;
    api<VaultHome | VaultCatalog>(path, {
      signal: controller.signal,
    })
      .then((r) => {
        if (controller.signal.aborted) return;
        if ("games" in r) setCatalog(r);
        else {
          setShelves(r.shelves);
          setWarnings(r.errors ?? []);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) onLocked();
          setError(String(e.message ?? e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tab, system, q, letter, page, retry]);
  const knownGames = [
    ...saved,
    ...playLibrary.map((rom) => rom.game),
    ...shelves.flatMap((shelf) => shelf.games),
    ...(catalog?.games ?? []),
  ];
  const resolvedGame = requestedGame
    ? knownGames.find((game) => game.id === requestedGame) ?? null
    : null;
  const detailReady = tab === "saved" || tab === "consoles" || !loading;
  useEffect(() => {
    if (!requestedGame) setSelected(null);
    else if (resolvedGame) setSelected(resolvedGame);
    else if (detailReady) setSelected(null);
  }, [requestedGame, resolvedGame?.id, resolvedGame?.title, resolvedGame?.system, detailReady]);
  useRouteTitle(
    tab === "steam"
      ? undefined
      : selected
        ? `${selected.title} · The Vault`
        : requestedGame && detailReady
          ? "Game not found · The Vault"
          : q
            ? `${q} · The Vault`
            : system
              ? `${systemName(system)} · The Vault`
              : tab === "saved"
                ? "My list · The Vault"
                : tab === "consoles"
                  ? "Consoles · The Vault"
                  : undefined,
  );
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LIST_KEY) setSaved(readList());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const toggle = (game: VaultGame) => {
    const next = saved.some((g) => g.id === game.id)
      ? saved.filter((g) => g.id !== game.id)
      : [game, ...saved].slice(0, 500);
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify(next));
      setSaved(next);
      setSaveError("");
    } catch {
      setSaveError(
        "Your browser could not save this list. Check available storage.",
      );
    }
  };
  const browse = (id: string) => go({ system: id });
  const openGame = (game: VaultGame) => {
    setSelected(game);
    updateParams({ game: game.id });
  };
  const closeGame = (mode: "push" | "replace" = "push") => {
    setSelected(null);
    updateParams({ game: null }, mode);
  };
  const home = tab === "discover" && !system && !q;
  const featured = shelves.flatMap((s) => s.games.slice(0, 2)).slice(0, 3);
  return (
    <div className="vault" ref={scroll}>
      <header className="vault-header">
        <button
          className="vault-brand"
          onClick={() => go()}
          aria-label="The Vault home"
        >
          <span className="vault-brand-icon">
            V<span>•</span>
          </span>
          <span>
            THE VAULT<small>A CYBERDECK APP</small>
          </span>
        </button>
        <nav aria-label="Vault navigation">
          {[
            ["discover", "Discover"],
            ["consoles", "Consoles"],
            ...(steamSupported ? [["steam", "PC games"]] : []),
            ["saved", `My list${saved.length ? ` (${saved.length})` : ""}`],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => go(id === "discover" ? {} : { tab: id })}
            >
              {label}
            </button>
          ))}
        </nav>
        <button className="vault-exit" onClick={() => navigate("applications")}>
          ← Apps
        </button>
      </header>
      <form
        className="vault-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 3)
            go({
              q: query.trim(),
              ...(searchSystem ? { system: searchSystem } : {}),
            });
        }}
      >
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          aria-label="Search games"
          placeholder="Find your next game…"
          value={query}
          minLength={3}
          maxLength={120}
          required
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Search console"
          value={searchSystem}
          onChange={(e) => setSearchSystem(e.target.value)}
        >
          <option value="">All consoles</option>
          {VIMM_SYSTEMS.map((s) => (
            <option key={s[0]} value={s[0]}>
              {s[1]}
            </option>
          ))}
        </select>
        <button type="submit" disabled={query.trim().length < 3}>
          Search <span aria-hidden="true">↗</span>
        </button>
      </form>
      <div className="vault-content">
        {home && (
          <section className="vault-hero">
            <div className="vault-hero-copy">
              <span className="vault-eyebrow">
                <i /> PRESS REWIND
              </span>
              <h1>
                Your next adventure
                <br />
                is a <em>classic.</em>
              </h1>
              <p>
                Your classics and PC favorites, together. Pick a game, press Play,
                and make yourself at home.
              </p>
              <div>
                <button
                  className="vault-primary"
                  onClick={() => go({ tab: "consoles" })}
                >
                  Explore the consoles <span>→</span>
                </button>
                <span className="vault-hero-count">
                  {VIMM_SYSTEMS.length} systems.
                  <br />
                  Decades of discovery.
                </span>
              </div>
            </div>
            <div className="vault-hero-art" aria-hidden="true">
              <div className="vault-orbit" />
              {featured.map((g, i) => (
                <div key={g.id} className={`vault-hero-poster poster-${i}`}>
                  <Artwork game={g} eager />
                </div>
              ))}
              <span className="vault-hero-stamp">INSERT NOSTALGIA</span>
            </div>
            <div className="vault-hero-bottom">
              THE VIMM’S LAIR COLLECTION <span>EST. 1997 ↗</span>
            </div>
          </section>
        )}
        {(tab === "steam" || (tab === "discover" && !system)) && <SteamVault params={params} query={q} expanded={tab === "steam"} onSupported={setSteamSupported} onLocked={onLocked} />}
        {playLibrary.length > 0 && (
          <section className="vault-shelf" aria-label="Ready to play">
            <div className="vault-section-heading">
              <div>
                <span className="vault-eyebrow">
                  YOUR GAME FILES · SAVED IN THIS BROWSER
                </span>
                <h2>Ready to play</h2>
              </div>
            </div>
            <div className="vault-rail">
              {playLibrary.map((r) => (
                <GameCard
                  key={r.id}
                  game={r.game}
                  open={(g) => void launch(g)}
                  saved={false}
                />
              ))}
            </div>
          </section>
        )}
        {tab === "discover" && (
          <div className="vault-console-chips" aria-label="Popular consoles">
            {[
              "",
              "SNES",
              "PS1",
              "N64",
              "Genesis",
              "PS2",
              "GBA",
              "GameCube",
            ].map((id) => (
              <button
                key={id}
                aria-pressed={system === id}
                onClick={() => (id ? browse(id) : go())}
              >
                {id ? systemName(id) : "For you"}
              </button>
            ))}
          </div>
        )}
        {tab === "consoles" ? (
          <>
            <div className="vault-page-heading">
              <span className="vault-eyebrow">PICK YOUR ERA</span>
              <h1>A world behind every console.</h1>
              <p>From the first pixels to your all-time favorites.</p>
            </div>
            <div className="vault-console-grid">
              {VIMM_SYSTEMS.map((s, i) => (
                <button
                  key={s[0]}
                  style={
                    { "--console-hue": (i * 39 + 215) % 360 } as CSSProperties
                  }
                  onClick={() => browse(s[0])}
                >
                  <span className="vault-console-code">{s[0]}</span>
                  <span>
                    <strong>{s[1]}</strong>
                    <small>{s[2]}</small>
                  </span>
                  <b>↗</b>
                </button>
              ))}
            </div>
          </>
        ) : tab === "steam" ? null : tab === "saved" ? (
          <>
            <div className="vault-page-heading">
              <span className="vault-eyebrow">YOUR PERSONAL COLLECTION</span>
              <h1>Worth coming back to.</h1>
              <p>{saved.length} saved games · Stored in this browser</p>
            </div>
            {saved.length ? (
              <div className="vault-grid">
                {saved.map((g) => (
                  <GameCard key={g.id} game={g} open={openGame} saved />
                ))}
              </div>
            ) : (
              <div className="vault-empty">
                <span>＋</span>
                <h2>Your next favorite belongs here.</h2>
                <p>Open a game and add it to My list to keep it close.</p>
                <button className="vault-primary" onClick={() => go()}>
                  Discover games →
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            {!home && (
              <div className="vault-page-heading">
                <span className="vault-eyebrow">
                  {q ? "SEARCH THE COLLECTION" : "EXPLORE THE COLLECTION"}
                </span>
                <h1>{q ? `Results for “${q}”` : systemName(system)}</h1>
                <p>
                  {q
                    ? `${system ? systemName(system) : "All consoles"} · ${
                        loading
                          ? "Searching…"
                          : `${catalog?.games.length ?? 0} games on this page`
                      }`
                    : VIMM_SYSTEMS.find((s) => s[0] === system)?.[2]}
                </p>
              </div>
            )}
            {system && !q && (
              <nav
                className="vault-alphabet"
                aria-label="Browse titles by letter"
              >
                <button aria-pressed={!letter} onClick={() => browse(system)}>
                  Popular
                </button>
                {["number", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((l) => (
                  <button
                    key={l}
                    aria-pressed={letter === l}
                    onClick={() => go({ system, letter: l })}
                  >
                    {l === "number" ? "#" : l}
                  </button>
                ))}
              </nav>
            )}
            {loading && (
              <div
                role="status"
                aria-label="Loading games"
                className="vault-loading"
              >
                <span>Finding your next classic…</span>
                <div className="vault-grid">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="vault-skeleton" />
                  ))}
                </div>
              </div>
            )}
            {error && (
              <div role="alert" className="vault-empty">
                <h2>The collection couldn’t load.</h2>
                <p>{error}</p>
                <button
                  className="vault-primary"
                  onClick={() => setRetry((r) => r + 1)}
                >
                  Try again
                </button>{" "}
                <a
                  href="https://vimm.net/vault"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Vimm ↗
                </a>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="vault-warning" role="status">
                Some console shelves are unavailable.{" "}
                <button onClick={() => setRetry((r) => r + 1)}>
                  Try again
                </button>
              </div>
            )}
            {shelves.map((s) => (
              <Shelf
                key={`${s.system}-${s.title}`}
                shelf={s}
                open={openGame}
                saved={saved}
                browse={browse}
              />
            ))}
            {catalog && (
              <>
                {catalog.games.length ? (
                  <div className="vault-grid">
                    {catalog.games.map((g) => (
                      <GameCard
                        key={g.id}
                        game={g}
                        open={openGame}
                        saved={saved.some((s) => s.id === g.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="vault-empty">
                    <h2>No games found.</h2>
                    <p>Try another title, console, or letter.</p>
                    <button className="vault-secondary" onClick={() => go()}>
                      Back to discover
                    </button>
                  </div>
                )}
                {catalog.pages > 1 && (
                  <nav className="vault-pagination" aria-label="Search pages">
                    <button
                      disabled={page <= 1}
                      onClick={() =>
                        go({ system, q, letter, page: String(page - 1) })
                      }
                    >
                      ← Previous
                    </button>
                    <span>
                      Page {page} of {catalog.pages}
                    </span>
                    <button
                      disabled={page >= catalog.pages}
                      onClick={() =>
                        go({ system, q, letter, page: String(page + 1) })
                      }
                    >
                      Next →
                    </button>
                  </nav>
                )}
              </>
            )}
          </>
        )}

        <footer className="vault-footer">
          <span>
            THE VAULT <b> / </b> Made for the love of the game.
          </span>
          <a href="https://vimm.net" target="_blank" rel="noopener noreferrer">
            Catalog & artwork by Vimm’s Lair ↗
          </a>
        </footer>
      </div>
      {saveError && (
        <p role="alert" className="vault-save-error">
          {saveError}
        </p>
      )}
      {playing && (
        <VaultPlayer
          key={playing.id}
          game={playing}
          close={() => setPlaying(null)}
          changed={refreshPlayLibrary}
        />
      )}
      {selected && (
        <Detail
          key={selected.id}
          game={selected}
          close={() => closeGame()}
          saved={saved.some((g) => g.id === selected.id)}
          toggle={() => toggle(selected)}
          play={() => void launch(selected)}
        />
      )}
      {requestedGame && detailReady && !selected && (
        <div role="alert" className="vault-save-error">
          Game not found in this collection.{" "}
          <button onClick={() => closeGame()}>Close</button>
        </div>
      )}
    </div>
  );
}
