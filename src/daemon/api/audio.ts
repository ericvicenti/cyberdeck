// System volume: the node's default output device, so the Cyberdeck dashboard and the
// Casework remote (buoy) can turn the media PC up, down and mute it. Linux talks to
// PipeWire through `wpctl` (the daemon's user session owns the audio devices); macOS
// uses `osascript`. Arguments are built from validated numbers only, never from strings
// a client sent.
import type { Hono } from "hono";

export type AudioState = {
  available: boolean;
  /** 0–100, the default output device's volume (null when unavailable). */
  volume: number | null;
  muted: boolean;
  /** Human name of the default output device, when the backend reports one. */
  device: string | null;
  reason?: string;
};

export type AudioPatch = { volume?: number; delta?: number; muted?: boolean | "toggle" };
export type Runner = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const MAX_VOLUME = 100; // never drive PipeWire past 0 dB from a remote

export const defaultRunner: Runner = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

/** `wpctl get-volume` prints `Volume: 0.40` or `Volume: 0.40 [MUTED]`. */
export function parseWpctlVolume(out: string): { volume: number; muted: boolean } | null {
  const m = /Volume:\s*([\d.]+)(\s*\[MUTED\])?/.exec(out);
  if (!m) return null;
  return { volume: Math.round(parseFloat(m[1]) * 100), muted: !!m[2] };
}

/** `wpctl inspect` lists `node.description = "..."` among the properties. */
export function parseWpctlDescription(out: string): string | null {
  const m = /node\.description\s*=\s*"([^"]*)"/.exec(out);
  return m ? m[1] : null;
}

/** Clamp a requested level into what we will ever set. */
export const clampVolume = (v: number): number => Math.max(0, Math.min(MAX_VOLUME, Math.round(v)));

/** Validate a client's patch; null when nothing in it is usable. */
export function parsePatch(body: unknown): AudioPatch | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const patch: AudioPatch = {};
  if (typeof b.volume === "number" && Number.isFinite(b.volume)) patch.volume = clampVolume(b.volume);
  if (typeof b.delta === "number" && Number.isFinite(b.delta)) patch.delta = Math.max(-MAX_VOLUME, Math.min(MAX_VOLUME, Math.round(b.delta)));
  if (typeof b.muted === "boolean" || b.muted === "toggle") patch.muted = b.muted as boolean | "toggle";
  return Object.keys(patch).length ? patch : null;
}

export type AudioBackend = { get(): Promise<AudioState>; set(patch: AudioPatch): Promise<AudioState> };

const unavailable = (reason: string): AudioState => ({ available: false, volume: null, muted: false, device: null, reason });

export function pipewireBackend(run: Runner = defaultRunner): AudioBackend {
  const SINK = "@DEFAULT_AUDIO_SINK@";
  const get = async (): Promise<AudioState> => {
    let r;
    try { r = await run(["wpctl", "get-volume", SINK]); } catch (e) { return unavailable(`wpctl is not available: ${e instanceof Error ? e.message : e}`); }
    if (r.code !== 0) return unavailable((r.stderr || r.stdout).trim() || "no default audio output");
    const parsed = parseWpctlVolume(r.stdout);
    if (!parsed) return unavailable(`unexpected wpctl output: ${r.stdout.trim()}`);
    let device: string | null = null;
    try { const i = await run(["wpctl", "inspect", SINK]); if (i.code === 0) device = parseWpctlDescription(i.stdout); } catch {}
    return { available: true, volume: parsed.volume, muted: parsed.muted, device };
  };
  const set = async (patch: AudioPatch): Promise<AudioState> => {
    if (patch.volume !== undefined) await run(["wpctl", "set-volume", "-l", "1.0", SINK, `${patch.volume}%`]);
    else if (patch.delta) {
      // Compute the target here rather than letting wpctl step, so the cap and clamp always hold.
      const cur = await get();
      if (cur.available && cur.volume !== null) await run(["wpctl", "set-volume", "-l", "1.0", SINK, `${clampVolume(cur.volume + patch.delta)}%`]);
    }
    if (patch.muted !== undefined) await run(["wpctl", "set-mute", SINK, patch.muted === "toggle" ? "toggle" : patch.muted ? "1" : "0"]);
    return get();
  };
  return { get, set };
}

export function macBackend(run: Runner = defaultRunner): AudioBackend {
  const get = async (): Promise<AudioState> => {
    let r;
    try { r = await run(["osascript", "-e", "set s to get volume settings", "-e", "(output volume of s as text) & \" \" & (output muted of s as text)"]); } catch (e) { return unavailable(`osascript failed: ${e instanceof Error ? e.message : e}`); }
    if (r.code !== 0) return unavailable(r.stderr.trim() || "could not read the volume");
    const [vol, muted] = r.stdout.trim().split(/\s+/);
    const volume = parseInt(vol, 10);
    if (!Number.isFinite(volume)) return unavailable(`unexpected osascript output: ${r.stdout.trim()}`);
    return { available: true, volume, muted: muted === "true", device: null };
  };
  const set = async (patch: AudioPatch): Promise<AudioState> => {
    let target = patch.volume;
    if (target === undefined && patch.delta) { const cur = await get(); if (cur.volume !== null) target = clampVolume(cur.volume + patch.delta); }
    if (target !== undefined) await run(["osascript", "-e", `set volume output volume ${clampVolume(target)}`]);
    if (patch.muted !== undefined) {
      const muted = patch.muted === "toggle" ? !(await get()).muted : patch.muted;
      await run(["osascript", "-e", `set volume output muted ${muted}`]);
    }
    return get();
  };
  return { get, set };
}

export function audioBackend(run: Runner = defaultRunner, platform = process.platform): AudioBackend {
  if (platform === "linux") return pipewireBackend(run);
  if (platform === "darwin") return macBackend(run);
  const none = unavailable(`volume control is not supported on ${platform}`);
  return { get: async () => none, set: async () => none };
}

export function registerAudioRoutes(app: Hono, backend: AudioBackend) {
  let chain: Promise<unknown> = Promise.resolve(); // serialize writes so taps on a slider cannot race
  app.get("/api/audio", async (c) => c.json(await backend.get()));
  app.post("/api/audio", async (c) => {
    let body: unknown = null;
    try { body = await c.req.json(); } catch {}
    const patch = parsePatch(body);
    if (!patch) return c.json({ error: "send {volume: 0-100} and/or {delta: ±n} and/or {muted: true|false|\"toggle\"}" }, 400);
    const result = chain.then(() => backend.set(patch), () => backend.set(patch));
    chain = result.catch(() => {});
    try { return c.json(await result); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 500); }
  });
}
