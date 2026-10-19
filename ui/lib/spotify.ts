import { isMusicRoute, musicHash } from "./spotify-navigation";
// Spotify stays on this browser, independent of Cyberdeck's selected fleet node.
// PKCE needs only a public client ID. Tokens are tab-scoped and never sent to Cyberdeck.
const PREFIX = "cyberdeck-spotify-";
/** Public ID of Eric's existing Cyberdeck app, verified in Spotify's developer dashboard. */
export const SPOTIFY_CLIENT_ID = "6dc6300fa4364a81acb8a5f5e920f809";
const SCOPES =
  "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-read-recently-played user-library-read user-library-modify user-follow-read playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private";
/** Catalog artist, also used for the clickable credits on a track. */
export type SpotifyArtist = {
  id: string;
  uri: string;
  name: string;
  images?: { url: string }[];
};
/** Catalog album and its artwork. */
export type SpotifyAlbum = {
  id: string;
  uri: string;
  name: string;
  images: { url: string }[];
  artists?: SpotifyArtist[];
  release_date?: string;
};
/** A playable catalog track; unavailable playlist entries are filtered at the API boundary. */
export type SpotifyTrack = {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  is_local?: boolean;
  is_playable?: boolean;
  type?: string;
  external_urls?: { spotify: string };
};
/** Playlist identity and editing permissions. */
export type SpotifyPlaylist = {
  id: string;
  uri: string;
  name: string;
  images: { url: string }[];
  description?: string;
  owner?: { id: string };
  collaborative?: boolean;
  public?: boolean;
  snapshot_id?: string;
};
/** Spotify Connect playback target. */
export type SpotifyDevice = {
  id: string | null;
  name: string;
  is_active: boolean;
  is_restricted: boolean;
  supports_volume?: boolean;
  volume_percent: number | null;
};
/** Current playback across Connect devices. */
export type SpotifyPlayback = {
  item: SpotifyTrack | null;
  is_playing: boolean;
  progress_ms: number;
  device: SpotifyDevice;
  shuffle_state: boolean;
  repeat_state: string;
};
/** Spotify's paginated collections. */
export type SpotifyPage<T> = {
  items: T[];
  next: string | null;
  total?: number;
  offset?: number;
  limit?: number;
};
type Credentials = {
  access_token: string;
  refresh_token: string;
  expires: number;
  clientId: string;
};
type Pending = {
  state: string;
  verifier: string;
  clientId: string;
  redirect: string;
  created: number;
  returnHash?: string;
};
const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(sessionStorage.getItem(PREFIX + key) || "null");
  } catch {
    return null;
  }
};
/** Whether this tab has an OAuth session. */
export const spotifyConnected = () => !!read<Credentials>("tokens");
/** The shared public app identifier; a client secret is never required. */
export const spotifyClientId = () => SPOTIFY_CLIENT_ID;
/** Require a Spotify-supported callback origin. */
export function spotifyRedirect(origin = location.origin): string {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error(
      "Open Cyberdeck over HTTPS or http://127.0.0.1:4777 to connect Spotify. Spotify does not allow HTTP tailnet addresses or localhost.",
    );
  }
  return url.origin + "/";
}
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
/** Derive the RFC 7636 S256 proof key challenge. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
/** Begin Spotify authorization with the public app ID and PKCE. */
// Keep only view parameters in the tab-local OAuth continuation. Never allow an
// external return URL, authorization code, token, or unrelated application.
export function spotifyReturnHash(hash: string): string {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const source = new URLSearchParams(query), params = new URLSearchParams();
  const music = path === "spotify" || isMusicRoute(path, source);
  if (music) for (const key of ["node", "q", "shelf", "id", "page", "immersive", "radio"]) {
    const value = source.get(key)?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300);
    if (value) params.set(key, value);
  }
  return musicHash(params);
}
export async function connectSpotify(clientId: string): Promise<void> {
  clientId = clientId.trim();
  if (!/^[a-f0-9]{32}$/i.test(clientId))
    throw new Error(
      "Enter the 32-character Client ID from your Spotify Developer app.",
    );
  const redirect = spotifyRedirect();
  const pending: Pending = {
    state: random(),
    verifier: random(),
    clientId,
    redirect,
    created: Date.now(),
    returnHash: spotifyReturnHash(location.hash),
  };
  const challenge = await pkceChallenge(pending.verifier);
  sessionStorage.setItem(PREFIX + "pending", JSON.stringify(pending));
  localStorage.setItem(PREFIX + "client-id", clientId);
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope: SCOPES,
    state: pending.state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  location.assign("https://accounts.spotify.com/authorize?" + query);
}
let generation = 0;
/** Invalidate pending token refresh and clear this tab’s credentials. */
export function disconnectSpotify(): void {
  generation++;
  sessionStorage.removeItem(PREFIX + "tokens");
  sessionStorage.removeItem(PREFIX + "pending");
}
async function tokenRequest(
  params: URLSearchParams,
  clientId: string,
  refreshToken = "",
): Promise<Credentials> {
  const version = generation;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) disconnectSpotify();
    throw new Error(
      "Spotify sign-in expired or was rejected. Check your Client ID and redirect URI, then reconnect.",
    );
  }
  const data = await res.json();
  if (!data.access_token || !Number.isFinite(data.expires_in))
    throw new Error("Spotify returned an invalid sign-in response.");
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires: Date.now() + data.expires_in * 1000,
    clientId,
  };
  if (version !== generation) throw new Error("Spotify was disconnected.");
  sessionStorage.setItem(PREFIX + "tokens", JSON.stringify(tokens));
  return tokens;
}
let callback: Promise<boolean> | undefined;
/** Verify the one-use callback state before exchanging its code. */
export function finishSpotifyLogin(): Promise<boolean> {
  if (callback) return callback;
  const query = new URLSearchParams(location.search);
  if (!query.has("code") && !query.has("error")) return Promise.resolve(false);
  callback = (async () => {
    const pending = read<Pending>("pending");
    // Remove authorization codes before loading external scripts or artwork.
    const valid = !!pending && query.get("state") === pending.state && Date.now() - pending.created <= 600000 && pending.redirect === spotifyRedirect();
    history.replaceState(null, "", location.pathname + (valid ? spotifyReturnHash(pending.returnHash || "") : musicHash()));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    sessionStorage.removeItem(PREFIX + "pending");
    if (!valid || !pending) throw new Error("Spotify sign-in could not be verified. Please connect again from this tab.");
    if (query.has("error")) throw new Error("Spotify connection was canceled. You can connect again when ready.");
    await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", code: query.get("code")!, redirect_uri: pending.redirect, client_id: pending.clientId, code_verifier: pending.verifier }), pending.clientId);
    return true;
  })();
  return callback;
}
let refresh: Promise<Credentials> | undefined;
/** Return an access token, sharing concurrent refresh requests. */
export async function spotifyToken(force = false): Promise<string> {
  const tokens = read<Credentials>("tokens");
  if (!tokens) throw new Error("Connect Spotify to continue.");
  if (!force && tokens.expires > Date.now() + 60000) return tokens.access_token;
  if (!refresh)
    refresh = tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: tokens.clientId,
      }),
      tokens.clientId,
      tokens.refresh_token,
    ).finally(() => {
      refresh = undefined;
    });
  return (await refresh).access_token;
}
let retryAfter = 0;
/** Send an authorized API request and respect rate limiting. */
export async function spotifyApi<T>(
  path: string,
  method = "GET",
  body?: unknown,
  retry = true,
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Invalid Spotify API path.");
  if (Date.now() < retryAfter)
    throw new Error(
      `Spotify is busy. Try again in ${Math.ceil(
        (retryAfter - Date.now()) / 1000,
      )} seconds.`,
    );
  const res = await fetch("https://api.spotify.com/v1" + path, {
    method,
    headers: {
      Authorization: `Bearer ${await spotifyToken()}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 && retry) {
    await spotifyToken(true);
    return spotifyApi<T>(path, method, body, false);
  }
  if (res.status === 429) {
    retryAfter =
      Date.now() + (Number(res.headers.get("Retry-After")) || 30) * 1000;
    throw new Error(
      "Spotify rate limit reached. Playback can continue; requests will resume after the cooldown.",
    );
  }
  if (!res.ok) {
    if (res.status === 403)
      throw new Error(
        "Spotify denied access. Check Premium, your app's allowed users, and reconnect to grant playback permissions.",
      );
    if (res.status === 404)
      throw new Error(
        path.startsWith("/me/player")
          ? "No active playback device. Enable browser playback or select a connected device."
          : "Spotify does not make this content available to this app.",
      );
    throw new Error(`Spotify request failed (${res.status}). Try again.`);
  }
  const text = await res.text();
  // Player commands may succeed with 204, an empty body or a plain-text "OK" instead of JSON.
  if (res.status === 204 || !text || text === "OK") return null as T;
  if (method === "GET" || res.headers.get("content-type")?.includes("json")) {
    try { return JSON.parse(text) as T; } catch { return null as T; }
  }
  return null as T;
}
/** Parse supported catalog URLs or URIs at the input boundary. */
export function spotifyUri(input: string): string | null {
  if (/^spotify:(track|album|playlist|artist):[a-zA-Z0-9]+$/.test(input))
    return input;
  try {
    const u = new URL(input);
    const m = u.pathname.match(
      /^\/(?:intl-[a-z]+\/)?(track|album|playlist|artist)\/([a-zA-Z0-9]+)\/?$/,
    );
    return u.hostname === "open.spotify.com" && u.protocol === "https:" && m
      ? `spotify:${m[1]}:${m[2]}`
      : null;
  } catch {
    return null;
  }
}
/** Browser playback methods supplied by Spotify’s official SDK. */
export interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  activateElement(): Promise<void>;
  pause(): Promise<void>;
  addListener(event: string, callback: (event: any) => void): boolean;
}
declare global {
  interface Window {
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume: number;
      }) => SpotifyPlayer;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}
let sdk: Promise<void> | undefined;
/** Load the patched SDK bootstrap once, allowing retry after failure. */
export function loadSpotifySdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  if (sdk) return sdk;
  sdk = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(() => {
      script.remove();
      sdk = undefined;
      reject(
        new Error(
          "Spotify player timed out. Check your connection and try Enable browser playback again.",
        ),
      );
    }, 20000);
    window.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timeout);
      resolve();
    };
    script.src = "/spotify-sdk.js";
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      sdk = undefined;
      reject(
        new Error(
          "Spotify player could not load. You can still use another Spotify device.",
        ),
      );
    };
    document.head.appendChild(script);
  });
  return sdk;
}

/** Convert a Spotify pagination URL to a confined API path. */
export function spotifyPagePath(next: string): string {
  const url = new URL(next);
  if (
    url.origin !== "https://api.spotify.com" ||
    !url.pathname.startsWith("/v1/")
  )
    throw new Error("Invalid Spotify pagination URL.");
  return url.pathname.slice(3) + url.search;
}
