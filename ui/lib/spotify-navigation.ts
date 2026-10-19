import { routeHash } from "./navigation";

/** The listening room is Afterglow's music half: `#/applications?app=afterglow&tab=music…`. There is no
 *  standalone Spotify view; `#/spotify` links are rewritten to this by the router. */
export const MUSIC_VIEW = "applications";
export const MUSIC_APP = "afterglow";
export const MUSIC_TAB = "music";
export function isMusicRoute(view: string, params: URLSearchParams): boolean {
  return view === MUSIC_VIEW && params.get("app") === MUSIC_APP && params.get("tab") === MUSIC_TAB;
}
/** The player's own params (shelf, id, q, …) pinned under Afterglow's music tab. */
export function musicParams(params: URLSearchParams | Record<string, string> = {}): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("app", MUSIC_APP);
  next.set("tab", MUSIC_TAB);
  next.delete("route");
  next.sort();
  return next;
}
export const musicHash = (params: URLSearchParams | Record<string, string> = {}): string => routeHash(MUSIC_VIEW, musicParams(params));

export const SPOTIFY_COLLECTIONS = [
  "home",
  "liked",
  "albums",
  "artists",
  "recent",
  "queue",
  "history",
  "search",
] as const;
export const SPOTIFY_ENTITIES = ["artist", "album", "playlist"] as const;

export type SpotifyShelf =
  | (typeof SPOTIFY_COLLECTIONS)[number]
  | (typeof SPOTIFY_ENTITIES)[number];

export type SpotifyLocation = {
  shelf: SpotifyShelf;
  id: string;
  query: string;
  page: number;
  immersive: boolean;
  radio: boolean;
  recording: string;
};

/** Parse and canonicalize only the URL state owned by the listening room. */
export function spotifyLocation(params: URLSearchParams): {
  location: SpotifyLocation;
  canonical: URLSearchParams;
} {
  const canonical = new URLSearchParams(params);
  const rawShelf = canonical.get("shelf") || "home";
  const shelf = [...SPOTIFY_COLLECTIONS, ...SPOTIFY_ENTITIES].includes(
    rawShelf as SpotifyShelf,
  )
    ? (rawShelf as SpotifyShelf)
    : "home";
  const entity = SPOTIFY_ENTITIES.includes(shelf as (typeof SPOTIFY_ENTITIES)[number]);
  const id = entity ? (canonical.get("id") || "").trim() : "";
  const query = shelf === "search" ? (canonical.get("q") || "").trim() : "";
  const rawPage = Number(canonical.get("page") || "1");
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 20 ? rawPage : 1;
  const immersive = canonical.get("immersive") === "1";
  const resolvedShelf: SpotifyShelf = (entity && !id) || (shelf === "search" && !query) ? "home" : shelf;
  const radio = resolvedShelf === "search" && canonical.get("radio") === "1";

  const rawRecording = (canonical.get("recording") || "").trim();
  const recording = resolvedShelf === "history" && rawRecording.length <= 512 && !/[\u0000-\u001f]/.test(rawRecording) ? rawRecording : "";
  canonical.delete("recording");
  if (recording) canonical.set("recording", recording);
  canonical.delete("shelf");
  canonical.delete("id");
  canonical.delete("q");
  canonical.delete("page");
  canonical.delete("immersive");
  canonical.delete("radio");
  if (resolvedShelf !== "home") canonical.set("shelf", resolvedShelf);
  if (id && resolvedShelf === shelf) canonical.set("id", id);
  if (query && resolvedShelf === "search") canonical.set("q", query);
  if (page > 1 && resolvedShelf !== "home") canonical.set("page", String(page));
  if (immersive) canonical.set("immersive", "1");
  if (radio) canonical.set("radio", "1");
  canonical.sort();

  return {
    location: {
      shelf: resolvedShelf,
      id: resolvedShelf === shelf ? id : "",
      query: resolvedShelf === "search" ? query : "",
      page: resolvedShelf === "home" ? 1 : page,
      immersive,
      radio,
      recording,
    },
    canonical,
  };
}

export function spotifyRouteParams(
  current: URLSearchParams,
  next: Pick<SpotifyLocation, "shelf"> &
    Partial<Pick<SpotifyLocation, "id" | "query" | "page" | "immersive" | "radio" | "recording">>,
) {
  const params = new URLSearchParams(current);
  for (const key of ["shelf", "id", "q", "page", "immersive", "radio", "recording"])
    params.delete(key);
  if (next.shelf !== "home") params.set("shelf", next.shelf);
  if (next.id) params.set("id", next.id);
  if (next.recording && next.shelf === "history") params.set("recording", next.recording);
  if (next.query) params.set("q", next.query.trim());
  if ((next.page || 1) > 1) params.set("page", String(next.page));
  if (next.immersive) params.set("immersive", "1");
  if (next.radio && next.shelf === "search") params.set("radio", "1");
  params.sort();
  return params;
}
