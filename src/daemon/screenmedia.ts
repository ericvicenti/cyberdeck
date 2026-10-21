// Screen media: what is playing on this node's kiosk screen (the Chromium that cyberdeck-kiosk.service
// supervises), and the handful of things a voice agent may do to it: play, pause, seek, volume, open a
// route in Afterglow, put a search on screen, play a downloaded title. Afterglow runs in an iframe inside
// the Applications view; its page exposes `window.afterglowNavigation` (BoticalMedia public/navigation.js)
// and a plain <video>, so playback is a DOM call on that frame and navigation is a hash route. With no
// Afterglow on screen the outer page is pointed at `#/applications?app=afterglow&route=…` first.
//
// Everything here takes the smallest slice of a Playwright page it needs, so tests can fake it.

export const MEDIA_ACTIONS = ["status", "play", "pause", "toggle", "seek", "mute", "unmute", "volume", "open", "search", "watch", "library", "music"] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];
export type MediaCommand = { action: MediaAction; value?: string | number };

export type VideoState = { playing: boolean; currentTime: number; duration: number | null; muted: boolean; volume: number; label: string | null };
type FrameProbe = { afterglow: boolean; route: string | null; title: string; video: VideoState | null };
export type MediaState = {
  ok: boolean;
  action: MediaAction;
  /** What was done, in words; absent when nothing changed (status) or on error. */
  did?: string;
  error?: string;
  screen: { url: string; title: string };
  afterglow: { present: boolean; route: string | null; title: string | null };
  video: VideoState | null;
};

export type MediaFrame = { url(): string; evaluate(fn: any, arg?: any): Promise<any> };
export type MediaPage = { url(): string; title(): Promise<string>; frames(): MediaFrame[]; evaluate(fn: any, arg?: any): Promise<any> };

/** A downloaded title as Afterglow's /api/library lists it (the fields this module reads). */
export type LibraryItem = { id: number | string; name?: string; media?: { name?: string; type?: string; year?: string }; files?: { index: number; name?: string; video?: boolean; included?: boolean }[] };

const NAV_ACTIONS = new Set<MediaAction>(["open", "search", "watch", "library", "music"]);
const VIDEO_ACTIONS = new Set<MediaAction>(["play", "pause", "toggle", "seek", "mute", "unmute", "volume"]);
const OPEN_TIMEOUT_MS = 8_000;
const SETTLE_MS = 300;

// Runs inside a frame: what Afterglow and the visible video say. Self-contained (Playwright serializes it).
function probeScript(): FrameProbe {
  const w = window as any;
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const videos = Array.from(document.querySelectorAll("video"));
  const v = videos.find(visible) ?? videos[0];
  const label = document.querySelector(".player-title")?.textContent?.replace(/\s+/g, " ").trim() || null;
  let route: string | null = null;
  try { route = w.afterglowNavigation ? String(w.afterglowNavigation.route() ?? "") : null; } catch {}
  return {
    afterglow: Boolean(w.afterglowNavigation),
    route,
    title: document.title,
    video: v ? { playing: !v.paused && !v.ended, currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null, muted: v.muted, volume: Math.round(v.volume * 100), label } : null,
  };
}

// Runs inside the chosen frame: one action on the video or one Afterglow route.
function actScript(cmd: { action: string; route?: string; value?: number }): string {
  const w = window as any;
  const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const videos = Array.from(document.querySelectorAll("video"));
  const v = videos.find(visible) ?? videos[0];
  if (cmd.route !== undefined) {
    if (w.afterglowNavigation) w.afterglowNavigation.navigate(cmd.route);
    else location.hash = cmd.route;
    return "navigated";
  }
  if (!v) return "no video";
  switch (cmd.action) {
    case "play": void v.play().catch(() => {}); return "played";
    case "pause": v.pause(); return "paused";
    case "toggle": if (v.paused) { void v.play().catch(() => {}); return "played"; } v.pause(); return "paused";
    case "seek": v.currentTime = Math.max(0, v.currentTime + (cmd.value ?? 0)); return "seeked";
    case "mute": v.muted = true; return "muted";
    case "unmute": v.muted = false; if (v.volume === 0) v.volume = 0.5; return "unmuted";
    case "volume": v.volume = Math.min(1, Math.max(0, (cmd.value ?? 50) / 100)); v.muted = false; return "volume";
  }
  return "nothing";
}

async function probeAll(page: MediaPage): Promise<{ frame: MediaFrame; probe: FrameProbe }[]> {
  const out: { frame: MediaFrame; probe: FrameProbe }[] = [];
  for (const frame of page.frames()) {
    try { out.push({ frame, probe: (await frame.evaluate(probeScript)) as FrameProbe }); } catch {}
  }
  return out;
}

/** The frame worth talking to: Afterglow's, else the one with a video, else the page itself. */
function pick(frames: { frame: MediaFrame; probe: FrameProbe }[]) {
  return frames.find((f) => f.probe.afterglow) ?? frames.find((f) => f.probe.video) ?? frames[0] ?? null;
}

/** The Afterglow hash route an action asks for, or null when the action is about the video. */
export function routeFor(cmd: MediaCommand): string | null {
  switch (cmd.action) {
    case "open": return String(cmd.value ?? "").replace(/^#\/?/, "") || "discover";
    case "search": return `search/${encodeURIComponent(String(cmd.value ?? "").trim())}`;
    case "library": return "library";
    case "music": return "music";
    default: return null;
  }
}

/** Afterglow's `watch/<id>/<file>` route for the library item that best matches a spoken title. */
export function watchRoute(items: LibraryItem[], query: string): { route: string; name: string } | { error: string } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const q = norm(query);
  if (!q) return { error: "Say which title to play." };
  const words = q.split(" ");
  let best: { item: LibraryItem; score: number; name: string } | null = null;
  for (const item of items) {
    const name = item.media?.name || item.name || "";
    const n = norm(name);
    if (!n) continue;
    const score = n === q ? 3 : n.includes(q) ? 2 : words.every((w) => n.includes(w)) ? 1 : 0;
    if (score && (!best || score > best.score)) best = { item, score, name };
  }
  if (!best) return { error: `Nothing in the library matches "${query}".` };
  const file = (best.item.files ?? []).find((f) => f.video && f.included !== false) ?? (best.item.files ?? []).find((f) => f.video);
  if (!file) return { error: `${best.name} is in the library but has no video file yet.` };
  return { route: `watch/${best.item.id}/${file.index}`, name: best.name };
}

export type ScreenMediaOptions = {
  /** The outer hash that shows Afterglow at a route when it is not on screen. */
  outerHash?: (route: string) => string;
  /** Afterglow's downloaded titles, for `watch` (absent: `watch` explains it cannot look titles up). */
  library?: () => Promise<LibraryItem[]>;
  sleep?: (ms: number) => Promise<void>;
};

const defaultOuterHash = (route: string) => `#/applications?${new URLSearchParams({ app: "afterglow", route })}`;

/** Run one media command against the kiosk page and describe the screen afterwards. */
export async function screenMedia(page: MediaPage, cmd: MediaCommand, opts: ScreenMediaOptions = {}): Promise<MediaState> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const outerHash = opts.outerHash ?? defaultOuterHash;
  const state = async (extra: Partial<MediaState>): Promise<MediaState> => {
    const chosen = pick(await probeAll(page));
    const p = chosen?.probe;
    return {
      ok: true,
      action: cmd.action,
      ...extra,
      screen: { url: page.url(), title: await page.title().catch(() => "") },
      afterglow: { present: Boolean(p?.afterglow), route: p?.afterglow ? p.route : null, title: p?.afterglow ? p.title || null : null },
      video: p?.video ?? null,
    };
  };

  let route = routeFor(cmd);
  let did: string | undefined;
  if (cmd.action === "watch") {
    if (!opts.library) return state({ ok: false, error: "This node cannot look up Afterglow's library." });
    let items: LibraryItem[];
    try { items = await opts.library(); } catch (err) { return state({ ok: false, error: `Afterglow's library did not answer: ${err instanceof Error ? err.message : err}` }); }
    const r = watchRoute(items, String(cmd.value ?? ""));
    if ("error" in r) return state({ ok: false, error: r.error });
    route = r.route;
    did = `playing ${r.name}`;
  }

  if (cmd.action === "status") return state({});

  const frames = await probeAll(page);
  const chosen = pick(frames);
  if (route !== null) {
    const target = frames.find((f) => f.probe.afterglow);
    if (target) {
      await target.frame.evaluate(actScript, { action: cmd.action, route });
    } else {
      await page.evaluate((hash: string) => { location.hash = hash; }, outerHash(route));
    }
    const t0 = Date.now();
    while (Date.now() - t0 < OPEN_TIMEOUT_MS) {
      await sleep(SETTLE_MS);
      const now = pick(await probeAll(page));
      if (now?.probe.afterglow && (now.probe.route ?? "") === route) break;
    }
    return state({ did: did ?? `opened ${route}` });
  }

  if (VIDEO_ACTIONS.has(cmd.action)) {
    if (!chosen?.probe.video) return state({ ok: false, error: "Nothing is playing on the screen." });
    const value = cmd.action === "seek" ? Number(cmd.value ?? 0) : cmd.action === "volume" ? Number(cmd.value ?? 50) : undefined;
    if (value !== undefined && !Number.isFinite(value)) return state({ ok: false, error: `${cmd.action} needs a number.` });
    const r = String(await chosen.frame.evaluate(actScript, { action: cmd.action, value }));
    if (r === "no video") return state({ ok: false, error: "Nothing is playing on the screen." });
    await sleep(SETTLE_MS);
    return state({ did: r });
  }
  return state({ ok: false, error: `Unknown action ${String(cmd.action)}.` });
}

/** Validate a request body into a command, or say what is wrong. */
export function parseMediaCommand(body: unknown): MediaCommand | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const action = String(b.action ?? "status") as MediaAction;
  if (!MEDIA_ACTIONS.includes(action)) return { error: `action must be one of ${MEDIA_ACTIONS.join(", ")}` };
  const value = b.value;
  if (value !== undefined && typeof value !== "string" && typeof value !== "number") return { error: "value must be a string or a number" };
  if (typeof value === "string" && value.length > 500) return { error: "value is too long" };
  if (NAV_ACTIONS.has(action) && action !== "library" && action !== "music" && (value === undefined || String(value).trim() === "")) return { error: `${action} needs a value` };
  return { action, value: value as string | number | undefined };
}

const mmss = (s: number) => { const m = Math.floor(s / 60), h = Math.floor(m / 60); return h ? `${h} hour${h === 1 ? "" : "s"} ${m % 60} minutes` : `${m} minute${m === 1 ? "" : "s"}`; };

/** One spoken sentence for a media state, for the voice agent. */
export function mediaSentence(host: string, s: MediaState): string {
  if (!s.ok) return `${s.error ?? "That did not work"} (${host}'s screen${s.afterglow.present ? `, Afterglow at ${s.afterglow.route || "home"}` : ""}).`;
  const v = s.video;
  const what = v?.label || s.afterglow.title || null;
  const where = v && v.duration ? ` at ${mmss(v.currentTime)} of ${mmss(v.duration)}` : v ? ` at ${mmss(v.currentTime)}` : "";
  const playing = v ? (v.playing ? `playing${what ? ` ${what}` : ""}${where}${v.muted ? ", muted" : ""}` : `paused${what ? ` on ${what}` : ""}${where}`) : null;
  if (s.action === "status") {
    if (playing) return `${host}'s screen is ${playing}.`;
    if (s.afterglow.present) return `${host}'s screen shows Afterglow at ${s.afterglow.route || "home"}; nothing is playing.`;
    return `${host}'s screen shows ${s.screen.title || s.screen.url || "Cyberdeck"}; nothing is playing.`;
  }
  const done = s.did === "navigated" || s.did?.startsWith("opened ") ? `Opened ${s.afterglow.route || s.did?.slice(7) || "Afterglow"} on ${host}'s screen` : s.did?.startsWith("playing ") ? `${s.did[0].toUpperCase()}${s.did.slice(1)} on ${host}'s screen` : s.did === "played" ? `Playing on ${host}'s screen` : s.did === "paused" ? `Paused ${host}'s screen` : s.did === "seeked" ? `Moved ${host}'s screen` : s.did === "muted" ? `Muted ${host}'s screen` : s.did === "unmuted" ? `Unmuted ${host}'s screen` : s.did === "volume" ? `Set the volume on ${host}'s screen${v ? ` to ${v.volume}` : ""}` : `Done on ${host}'s screen`;
  return `${done}${playing ? `; it is ${playing}` : ""}.`;
}
