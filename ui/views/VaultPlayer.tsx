import { useEffect, useRef, useState } from "react";
import { canUseNativeN64, nativeRequest, prepareNativeRom, type NativeLibrary } from "../lib/vault-native";
import { PlayerController } from "../lib/vault-controller";
import { useRouteTitle } from "../lib/navigation";
import { api, token } from "../lib/api";
import { downloadGame } from "../lib/vault-download";
import {
  getRom,
  getState,
  storeRom,
  saveState,
  type StoredRom,
} from "../lib/vault-storage";
import {
  PLAYER_SYSTEMS,
  MAX_STATE_BYTES,
  romError,
  type NodeRom,
} from "../../src/shared/vault-player";
import { systemName, type VaultGame } from "../../src/shared/vimm";

const playerSession = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export function VaultPlayer({
  game,
  close,
  changed,
  visible = true,
}: {
  game: VaultGame;
  close: () => void;
  changed: () => void;
  visible?: boolean;
}) {
  const active = useRef(visible);
  active.current = visible;
  useRouteTitle(visible ? `${game.title} · The Vault` : undefined);
  const dialog = useRef<HTMLDialogElement>(null),
    frame = useRef<HTMLIFrameElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [rom, setRom] = useState<StoredRom | null>(null),
    [checking, setChecking] = useState(true),
    [busy, setBusy] = useState(false);
  const transfer = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ bytes: 0, total: 0 });
  const [library, setLibrary] = useState<NodeRom[]>([]),
    [choice, setChoice] = useState("");
  const [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [started, setStarted] = useState(false),
    [hasSave, setHasSave] = useState(false);
  const [generation, setGeneration] = useState(0);
  const session = useRef(playerSession()),
    saveCounter = useRef(0),
    exitPending = useRef(false),
    lastSavedRequest = useRef(0);
  const localTV = canUseNativeN64(game.system, location.hostname, !!(window as Window & { __cyberdeckInputBridge?: unknown }).__cyberdeckInputBridge);
  const [nativeLibrary, setNativeLibrary] = useState<NativeLibrary | null | undefined>(localTV ? undefined : null);
  const nativeId = useRef<string | null>(null);
  const nativeStarting = useRef(false);
  const [nativeLaunching, setNativeLaunching] = useState(false);
  const stopNative = async () => {
    if (!nativeId.current) return;
    const state = await nativeRequest<{ running: { id: string } | null }>("/status");
    if (state.running?.id === nativeId.current) await nativeRequest("/stop", undefined, "{}");
  };
  useEffect(() => {
    if (!localTV) return;
    const abort = new AbortController();
    nativeRequest<NativeLibrary>("", abort.signal).then(lib => {
      setNativeLibrary(lib.available && lib.systems.some(s => s.id === "n64" && s.core) ? lib : null);
    }).catch(() => { if (!abort.signal.aborted) setNativeLibrary(null); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!rom || !nativeLibrary || nativeStarting.current) return;
    if (rom.name.toLowerCase().endsWith(".7z")) { setNativeLibrary(null); return; }
    const abort = new AbortController(); let alive = true, timer: ReturnType<typeof setInterval> | undefined;
    nativeStarting.current = true; setNativeLaunching(true); setStatus("Starting your game on this TV…");
    void (async () => {
      try {
        const latest = await nativeRequest<NativeLibrary>("", abort.signal);
        if (latest.running) throw new Error("Another game is already playing on this TV.");
        const id = await prepareNativeRom(rom, latest, abort.signal);
        if (!alive) return;
        nativeId.current = id;
        await nativeRequest(`/${id}/launch`, undefined, "{}");
        if (!alive) { await stopNative(); return; }
        setStatus("Playing · Home or Back + Start saves and returns here");
        timer = setInterval(() => {
          void nativeRequest<{ running: { id: string } | null }>("/status", abort.signal).then(state => {
            if (alive && state.running?.id !== id) close();
          }).catch(() => {});
        }, 1000);
      } catch (e) {
        if (alive) { setNativeLaunching(false); setError(e instanceof Error ? e.message : "The TV player couldn't start."); }
      }
    })();
    return () => { alive = false; abort.abort(); clearInterval(timer); nativeStarting.current = false; };
  }, [rom, nativeLibrary, generation]);
  // Hiding a modal removes it from the browser's top layer, but keeps its
  // iframe, save timer and native game owner alive. Hidden games cannot consume
  // keyboard/controller events or steal focus from the newly selected view.
  useEffect(() => {
    if (visible) dialog.current?.showModal(); else dialog.current?.close();
    if (visible && rom) document.documentElement.setAttribute("data-vault-playing", "");
    else document.documentElement.removeAttribute("data-vault-playing");
    return () => { document.documentElement.removeAttribute("data-vault-playing"); };
  }, [visible, rom]);
  const [menu, setMenu] = useState(false), [hint, setHint] = useState(true);
  const menuRef = useRef(menu); menuRef.current = menu;
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reveal = () => { setHint(true); clearTimeout(hintTimer.current); hintTimer.current = setTimeout(() => setHint(false), 3500); };
  const showMenu = (open = true) => {
    if (nativeLibrary) { if (open) exitRef.current(); return; }
    setMenu(open); menuRef.current = open;
    post("pause", { paused: open });
    if (!open) { frame.current?.focus(); setHint(false); }
  };
  const menuAction = useRef(showMenu); menuAction.current = showMenu;
  useEffect(() => {
    if (!rom || !visible) return;
    const controller = new PlayerController(); let raf = 0;
    const move = (by: number) => {
      const buttons = [...dialog.current!.querySelectorAll<HTMLButtonElement>(".vault-pause-panel button:not(:disabled), .vault-player-error button")];
      if (!buttons.length) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(at + by + buttons.length) % buttons.length].focus();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); menuAction.current(!menuRef.current); }
      else if (menuRef.current && ["ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); move(e.key === "ArrowDown" ? 1 : -1); }
    };
    const tick = (now: number) => {
      let action; try { action = controller.poll([...navigator.getGamepads()], menuRef.current, now); } catch {}
      if (action === "menu") menuAction.current(!menuRef.current);
      if (action === "resume") menuAction.current(false);
      if (action === "up" || action === "down") move(action === "down" ? 1 : -1);
      if (action === "accept") (document.activeElement as HTMLElement)?.click();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const fullscreen = () => { if (!document.fullscreenElement) menuAction.current(true); };
    window.addEventListener("fullscreenchange", fullscreen);
    window.addEventListener("keydown", key, true);
    return () => { cancelAnimationFrame(raf); clearTimeout(hintTimer.current); window.removeEventListener("keydown", key, true); window.removeEventListener("fullscreenchange", fullscreen); };
  }, [rom, visible]);
  useEffect(() => {
    if (visible && error && rom) {
      if (nativeLibrary) { setMenu(true); menuRef.current = true; }
      else menuAction.current(true);
      requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>(".vault-player-error button")?.focus());
    }
  }, [error, visible]);
  useEffect(() => {
    if (visible && menu) requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>(".vault-pause-panel button:not(:disabled)")?.focus());
  }, [menu, visible]);
  const core = PLAYER_SYSTEMS[game.system];
  const stateKey = (r: StoredRom) => `${core.core}:${r.digest}`;
  const post = (type: string, extra: Record<string, unknown> = {}) =>
    frame.current?.contentWindow?.postMessage(
      { source: "vault-host", session: session.current, type, ...extra },
      location.origin,
    );
  const exit = () => {
    if (nativeLibrary && rom) {
      void stopNative().then(close).catch(e => setError(String(e)));
      return;
    }
    if (!rom || !started) {
      close();
      return;
    }
    if (exitPending.current) return;
    exitPending.current = true;
    setStatus("Saving before returning to The Vault…");
    post("save", { requestId: ++saveCounter.current, closing: true });
  };
  const exitRef = useRef(exit);
  exitRef.current = exit;
  useEffect(() => {
    let alive = true;
    getRom(game.id)
      .then((r) => {
        if (!alive) return;
        if (r) setRom(r);
        else void download();
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    api<{ games: NodeRom[] }>("/api/vimm/roms")
      .then((r) => {
        if (alive) setLibrary(r.games.filter((g) => g.system === game.system));
      })
      .catch(() => {});
    return () => {
      alive = false;
      transfer.current?.abort();
      transfer.current = null;
      dialog.current?.close();
    };
  }, [game.id]);
  useEffect(() => {
    if (!rom || nativeLibrary !== null) return;
    let alive = true;
    const id = playerSession();
    session.current = id;
    setStarted(false);
    setHasSave(false);
    setStatus("Loading the player…");
    let closingTimeout: ReturnType<typeof setTimeout> | undefined;
    const receive = async (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.source !== "vault-player"
      )
        return;
      const message = event.data;
      if (message.type === "hello") {
        try {
          const state = await getState(stateKey(rom));
          if (!alive) return;
          setHasSave(!!state);
          post("init", {
            rom: rom.file,
            digest: rom.digest,
            core: core.core,
            scheme: core.scheme,
            state: state?.data,
          });
        } catch (e) {
          if (alive) setError(String(e));
        }
        return;
      }
      if (message.session !== id) return;
      if (message.type === "ready")
        setStatus(
          "Starting the game… Tap the player if your browser asks to enable audio.",
        );
      if (message.type === "started") {
        setStarted(true);
        if (active.current) { frame.current?.focus(); reveal(); }
        if (menuRef.current) post("pause", { paused: true });
        setStatus("Playing · Progress saves every 30 seconds");
      }
      if (message.type === "paused") {
        setStatus(message.paused ? "Paused" : "Playing");
      }
      if (message.type === "loaded") setStatus("Saved progress restored");
      if (message.type === "error" || message.type === "save-error") {
        setError(message.message);
        exitPending.current = false;
      }
      if (active.current && message.type === "menu-request") menuAction.current(!menuRef.current);
      if (active.current && message.type === "pointer") reveal();
      if (message.type === "not-started" && message.closing) close();
      if (message.type === "state") {
        if (
          !(message.data instanceof Uint8Array) ||
          !message.data.length ||
          message.data.length > MAX_STATE_BYTES
        ) {
          setError("The emulator returned an invalid save state.");
          exitPending.current = false;
          return;
        }
        const request =
          typeof message.requestId === "number"
            ? message.requestId
            : ++saveCounter.current;
        if (request < lastSavedRequest.current) return;
        lastSavedRequest.current = request;
        try {
          await saveState({
            id: stateKey(rom),
            data: message.data,
            updatedAt: Date.now(),
          });
          if (!alive) return;
          setHasSave(true);
          setStatus("Progress saved in this browser");
          setError("");
          if (message.closing) {
            clearTimeout(closingTimeout);
            close();
          }
        } catch {
          if (alive) {
            setError(
              "Progress could not be saved. Free some browser storage and try again, or exit without saving.",
            );
            exitPending.current = false;
          }
        }
      }
    };
    window.addEventListener("message", receive);
    const onExit = () => { if (active.current) menuAction.current(true); };
    window.addEventListener("vault-player-exit", onExit);
    // Install the listener before the iframe begins its handshake.
    frame.current!.src = "/vault-player.html";
    const interval = setInterval(() => {
      if (!exitPending.current)
        post("save", { requestId: ++saveCounter.current });
    }, 30000);
    const watchdog = setInterval(() => {
      if (exitPending.current && !closingTimeout)
        closingTimeout = setTimeout(() => {
          if (alive && exitPending.current) {
            exitPending.current = false;
            setError(
              "The player didn't respond to saving. Try again or exit without saving.",
            );
          }
        }, 8000);
      if (!exitPending.current) {
        clearTimeout(closingTimeout);
        closingTimeout = undefined;
      }
    }, 250);
    return () => {
      alive = false;
      clearInterval(interval);
      clearInterval(watchdog);
      clearTimeout(closingTimeout);
      window.removeEventListener("message", receive);
      window.removeEventListener("vault-player-exit", onExit);

    };
  }, [rom, generation, nativeLibrary]);
  const cancelDownload = () => {
    transfer.current?.abort();
    transfer.current = null;
    setDownloading(false);
  };
  const download = async () => {
    transfer.current?.abort();
    const controller = new AbortController();
    transfer.current = controller;
    setDownloading(true);
    setDownloadProgress({ bytes: 0, total: 0 });
    setError("");
    try {
      const { file, name, source } = await downloadGame(game, controller.signal, (bytes, total) => {
        if (transfer.current === controller) setDownloadProgress({ bytes, total });
      });
      controller.signal.throwIfAborted();
      const stored = await storeRom(game, file, name, source);
      if (transfer.current !== controller) return;
      setRom(stored);
      changed();
    } catch (e) {
      if (transfer.current === controller && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : "The game couldn't be downloaded.");
    } finally {
      if (transfer.current === controller) {
        transfer.current = null;
        setDownloading(false);
      }
    }
  };
  const importFile = async (file: Blob, name: string) => {
    cancelDownload();
    const problem = romError(game.system, name, file.size);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await storeRom(game, file, name);
      setRom(r);
      changed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const useLibrary = async () => {
    const selected = library.find((g) => g.id === choice);
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/vimm/roms/${selected.id}`, {
        headers: { authorization: `Bearer ${token()}` },
      });
      if (!r.ok)
        throw new Error(
          "The game file couldn't be loaded. Refresh the library and try again.",
        );
      await importFile(await r.blob(), selected.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    if (!rom) return;
    try {
      const state = await getState(stateKey(rom));
      if (state) post("load", { data: state.data });
    } catch {
      setError("Couldn't read saved progress.");
    }
  };
  return (
    <dialog
      ref={dialog}
      data-started={started}
      className={`vault vault-player-dialog ${rom ? "vault-immersive" : ""}`}
      aria-label={`${game.title} player`}
      onCancel={(e) => {
        e.preventDefault();
        if (rom) showMenu(!menu); else exit();
      }}
    >
      <input
        ref={input}
        type="file"
        aria-label="Choose game file"
        accept={[...(core?.extensions ?? []).map((e) => "." + e), ".zip", ".7z"].join(
          ",",
        )}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f, f.name);
          e.target.value = "";
        }}
        hidden
      />
      {!rom && <header className="vault-player-header">
        <div>
          <span className="vault-eyebrow">
            {systemName(game.system)} · PLAY IN THE VAULT
          </span>
          <h2 id="vault-player-title">{game.title}</h2>
        </div>
        <button className="vault-secondary" onClick={exit}>
          {started ? "Save & exit" : "Back"}
        </button>
      </header>}
      {checking ? (
        <p role="status">Checking your game library…</p>
      ) : downloading ? (
        <div className="vault-rom-picker" aria-busy="true">
          <span className="vault-play-symbol">↓</span>
          <h3>Getting your game ready</h3>
          <p role="status">{downloadProgress.bytes
            ? `Downloaded ${(downloadProgress.bytes / 1048576).toFixed(1)} MB${downloadProgress.total ? ` of ${(downloadProgress.total / 1048576).toFixed(1)} MB` : ""}…`
            : "Finding your game download…"}</p>
          <progress aria-label="Game download" max={downloadProgress.total || 1}
            value={downloadProgress.total ? downloadProgress.bytes : undefined} />
          <p>Play starts automatically when the download finishes.</p>
          <button className="vault-secondary" onClick={cancelDownload}>Cancel download</button>
        </div>
      ) : !rom ? (
        <div className="vault-rom-picker">
          <span className="vault-play-symbol">▷</span>
          <h3>Get ready to play</h3>
          <p>
            Download the game or choose an existing {systemName(game.system)} game file.
            We’ll remember it in this browser for next time.
          </p>
          <button className="vault-primary" disabled={busy || !core} onClick={() => void download()}>
            Retry download
          </button>
          <a className="vault-secondary" href={`https://vimm.net/vault/${game.id}`} target="_blank" rel="noreferrer">Open game on Vimm ↗</a>
          <button
            className="vault-secondary"
            disabled={busy || !core}
            onClick={() => input.current?.click()}
          >
            {busy ? "Importing…" : "Choose game file"}
          </button>
          {library.length > 0 && (
            <div className="vault-node-roms">
              <label htmlFor="vault-node-rom">
                Or use a game on this Cyberdeck
              </label>
              <select
                id="vault-node-rom"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">Choose from the game library…</option>
                {library.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button
                className="vault-secondary"
                disabled={!choice || busy}
                onClick={() => void useLibrary()}
              >
                Use this game
              </button>
            </div>
          )}
          <small>
            Game files and saves stay in this browser. Use localhost or HTTPS
            for controller support.
          </small>
        </div>
      ) : nativeLibrary !== null ? (
        <div className="vault-native-launch">
          <h2>{game.title}</h2><p role="status">{status || "Preparing your game…"}</p>
          <p>Home or Back + Start: save &amp; exit · Back + X: pause menu</p>
          <button onClick={exit}>{nativeLaunching ? "Save & exit" : "Back"}</button>
        </div>
      ) : (
        <>
          {menu && <section className="vault-pause-panel" aria-label="Game menu">
            <span className="vault-eyebrow">PAUSED</span>
            <h2 id="vault-player-title">{game.title}</h2>
            <button disabled={!started} onClick={() => showMenu(false)}>Resume</button>
            <button onClick={exit}>Save &amp; exit</button>
            <button disabled={!started} onClick={() => post("save", { requestId: ++saveCounter.current })}>Save progress</button>
            <button disabled={!started || !hasSave} onClick={() => void load()}>Load save</button>
            <p role="status">{status}</p>
            <small>{rom.source} · Progress saved on this browser</small>
            <small>↑↓ / left stick: choose · A: select · B: resume</small>
          </section>}
          {!menu && hint && <div className="vault-play-hint">
            <span>Hold Start for menu · Home or Back + Start · Esc</span>
            <button aria-label="Open game menu" onClick={() => showMenu(true)}>Ⅱ</button>
          </div>}
          {!started && <p className="vault-loading" role="status">{status}</p>}
          <iframe
            ref={frame}
            key={generation}
            title={`${game.title} emulator`}
            className="vault-player-frame"
            allow="autoplay; fullscreen; gamepad; screen-wake-lock"
            allowFullScreen
          />

        </>
      )}
      {error && (
        <div role="alert" className="vault-player-error">
          <p>{error}</p>
          {rom && (
            <>
              <button
                onClick={() => {
                  setError("");
                  exitPending.current = false;
                  setGeneration((n) => n + 1);
                }}
              >
                Retry player
              </button>
              <button onClick={() => { if (nativeLibrary) void stopNative().then(close).catch(e => setError(String(e))); else close(); }}>Exit without saving</button>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
