/** URL state for the compact Spotify player. Playback always requires a gesture. */
export function basicSpotifyLocation(params: URLSearchParams) {
  const q = (params.get("q") || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300);
  const raw = params.get("playlists") || "1";
  const pages = /^\d+$/.test(raw) ? Math.max(1, Math.min(20, Number(raw))) : 1;
  const canonical = new URLSearchParams(params);
  canonical.delete("q"); canonical.delete("playlists");
  if (q) canonical.set("q", q);
  if (pages > 1) canonical.set("playlists", String(pages));
  return { q, pages, canonical };
}
