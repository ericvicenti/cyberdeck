// System volume of the machine serving this page (the media PC): mute, −, slider, +.
// Used by the Enuc remote (buoy's screen) and the Home dashboard's Sound widget.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AudioState } from "../../src/daemon/api/audio";

const STEP = 5;

export function useAudio(pollMs = 5000) {
  const [state, setState] = useState<AudioState | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const load = async () => {
    if (busy.current) return;
    try { setState(await api<AudioState>("/api/audio", { local: true })); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), pollMs); return () => clearInterval(t); }, [pollMs]);
  const change = async (patch: { volume?: number; delta?: number; muted?: boolean | "toggle" }) => {
    busy.current = true;
    try {
      // Show the intent at once; the daemon's answer replaces it.
      if (patch.volume !== undefined) setState((s) => (s ? { ...s, volume: patch.volume! } : s));
      setState(await api<AudioState>("/api/audio", { local: true, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }));
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busy.current = false; }
  };
  return { state, error, change, reload: load };
}

export function VolumeControl({ className = "" }: { className?: string }) {
  const { state, error, change } = useAudio();
  const [dragging, setDragging] = useState<number | null>(null);
  const ready = !!state?.available;
  const volume = dragging ?? state?.volume ?? 0;
  const button = "rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40";
  return (
    <div className={`flex items-center gap-2 ${className}`} data-testid="volume-control" aria-label="Volume">
      <button type="button" className={`${button} ${state?.muted ? "border-amber-500 text-amber-300" : ""}`} disabled={!ready} aria-pressed={!!state?.muted} onClick={() => change({ muted: "toggle" })} title={state?.muted ? "Unmute" : "Mute"}>
        {state?.muted ? "Muted" : "Mute"}
      </button>
      <button type="button" className={button} disabled={!ready} aria-label="Volume down" onClick={() => change({ delta: -STEP })}>−</button>
      <input type="range" min={0} max={100} step={1} value={volume} disabled={!ready} aria-label="Volume level" className="min-w-0 flex-1 accent-cyan-400"
        onChange={(e) => setDragging(Number(e.target.value))}
        onPointerUp={(e) => { const v = Number((e.target as HTMLInputElement).value); setDragging(null); void change({ volume: v }); }}
        onKeyUp={(e) => { const v = Number((e.target as HTMLInputElement).value); setDragging(null); void change({ volume: v }); }}
        onBlur={() => { if (dragging !== null) { const v = dragging; setDragging(null); void change({ volume: v }); } }} />
      <button type="button" className={button} disabled={!ready} aria-label="Volume up" onClick={() => change({ delta: STEP })}>+</button>
      <span className={`w-12 shrink-0 text-right font-mono text-sm tabular-nums ${state?.muted ? "text-amber-300" : "text-zinc-300"}`} role="status">
        {ready ? `${volume}%` : "—"}
      </span>
      {(!ready || error) && <span className="truncate text-xs text-zinc-500" title={error || state?.reason}>{error || state?.reason || "…"}</span>}
    </div>
  );
}
