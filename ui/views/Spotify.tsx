import { useEffect, useRef, useState } from "react";
import {
  connectSpotify,
  disconnectSpotify,
  finishSpotifyLogin,
  loadSpotifySdk,
  spotifyApi,
  spotifyClientId,
  spotifyConnected,
  spotifyPagePath,
  spotifyRedirect,
  spotifyToken,
  spotifyUri,
  type SpotifyAlbum,
  type SpotifyArtist,
  type SpotifyDevice,
  type SpotifyPage,
  type SpotifyPlayback,
  type SpotifyPlayer,
  type SpotifyPlaylist,
  type SpotifyTrack,
} from "../lib/spotify";
import {
  clearSpotifyArchive,
  readSpotifyArchive,
  saveSpotifyRecord,
} from "../lib/spotify-storage";
import { readRoute, routeHash, useRouteTitle, writeRoute } from "../lib/navigation";
import {
  spotifyLocation,
  spotifyRouteParams,
  type SpotifyLocation,
} from "../lib/spotify-navigation";
import {
  MusicIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipFwdIcon,
} from "../lib/icons";
import "./spotify.css";
import { SpotifyRecordings } from "./SpotifyRecordings";
import { SpotifyVisualizer } from "./SpotifyVisualizer";

type Card = (SpotifyAlbum | SpotifyArtist | SpotifyPlaylist) & {
  kind: "album" | "artist" | "playlist";
};
type Shelf = {
  title: string;
  subtitle?: string;
  tracks: SpotifyTrack[];
  cards: Card[];
  next?: string | null;
  kind: string;
  entity?: Card;
  snapshot?: string;
};
type PlaylistItem = { item?: SpotifyTrack | null; track?: SpotifyTrack | null };
const emptyShelf: Shelf = {
  title: "Your rotation",
  subtitle: "A place for everything you come back to.",
  tracks: [],
  cards: [],
  kind: "home",
};
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(
    2,
    "0",
  )}`;
const playable = (t: SpotifyTrack | null | undefined): t is SpotifyTrack =>
  !!t?.id && !!t.uri && !t.is_local && t.type !== "episode";

/** Cyberdeck's persistent custom music surface; stays mounted while navigating the deck. */
export function Spotify({
  visible,
  params,
}: {
  visible: boolean;
  params: URLSearchParams;
}) {
  const [connected, setConnected] = useState(spotifyConnected);
  const clientId = spotifyClientId();
  const [error, setError] = useState("");
  const [needsPermissions, setNeedsPermissions] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [account, setAccount] = useState(
    () => localStorage.getItem("cyberdeck-spotify-account") || "",
  );
  const [audioCacheStatus, setAudioCacheStatus] = useState(
    "Browser playback saves audio to your listening journal",
  );
  const savedAudio = useRef<HTMLAudioElement | null>(null);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [playlistNext, setPlaylistNext] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [shelf, setShelf] = useState<Shelf>(emptyShelf);
  const [resolvedRouteKey, setResolvedRouteKey] = useState("");
  const [back, setBack] = useState<Shelf[]>([]);
  const [devices, setDevices] = useState<SpotifyDevice[]>([]);
  const [selected, setSelected] = useState("");
  const [browserId, setBrowserId] = useState("");
  const [sdkStatus, setSdkStatus] = useState("");
  const [playback, setPlayback] = useState<SpotifyPlayback | null>(null);
  const [seek, setSeek] = useState<number | null>(null);
  const [volume, setVolume] = useState(50);
  const [immersive, setImmersive] = useState(false);
  const [videoActive, setVideoActive] = useState(false);
  const [addTrack, setAddTrack] = useState<SpotifyTrack | null>(null);
  const [playlistName, setPlaylistName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState(false);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [archiveStatus, setArchiveStatus] = useState(
    "Metadata saves on this browser and this Cyberdeck node",
  );
  const player = useRef<SpotifyPlayer | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const sdkGeneration = useRef(0);
  const accountGeneration = useRef(0);
  const viewGeneration = useRef(0);
  const routeGeneration = useRef(0);
  const immersiveClosing = useRef(false);
  const accountRef = useRef("");
  const lastListen = useRef("");
  const archiveWrites = useRef(Promise.resolve());
  const alive = useRef(true);
  let redirect = "",
    originError = "";
  try {
    redirect = spotifyRedirect();
  } catch (e) {
    originError = (e as Error).message;
  }
  const routeKey = params.toString();
  const currentLocation = spotifyLocation(params).location;
  const navigateMusic = (
    next: Pick<SpotifyLocation, "shelf"> &
      Partial<
        Pick<
          SpotifyLocation,
          "id" | "query" | "page" | "immersive" | "radio"
        >
      >,
    mode: "push" | "replace" = "push",
  ) =>
    writeRoute(
      "spotify",
      spotifyRouteParams(readRoute().params, next),
      mode,
    );
  const navigateEntity = (entity: Card) =>
    navigateMusic({ shelf: entity.kind, id: entity.id });
  const navigateCollection = (kind: string) =>
    navigateMusic({ shelf: kind as SpotifyLocation["shelf"] });
  const navigateSearch = (value = query.trim(), radio = false) =>
    navigateMusic({ shelf: "search", query: value, radio });
  const closeImmersive = () => {
    if (immersiveClosing.current) return;
    immersiveClosing.current = true;
    setImmersive(false);
    const next = spotifyRouteParams(readRoute().params, {
      shelf: currentLocation.shelf,
      id: currentLocation.id,
      query: currentLocation.query,
      page: currentLocation.page,
      radio: currentLocation.radio,
    });
    const nextHash = routeHash("spotify", next);
    if (history.state?.cyberdeckSpotifyImmersiveFrom === nextHash)
      history.back();
    else writeRoute("spotify", next, "replace");
  };

  const report = (e: unknown) => {
    if (alive.current) {
      setError((e as Error).message || "Spotify is unavailable.");
      setConnected(spotifyConnected());
    }
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      report(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const archive = (kind: "response" | "listen", key: string, data: unknown) => {
    const owner = accountRef.current;
    if (!owner) return;
    archiveWrites.current = archiveWrites.current
      .then(() =>
        saveSpotifyRecord({
          key: `${owner}:${kind}:${key}`,
          account: owner,
          kind,
          at: Date.now(),
          data,
        }),
      )
      .catch(() => {
        if (alive.current)
          setArchiveStatus(
            "Archive save failed — check browser/node storage; export any saved records",
          );
      });
  };
  const readApi = async <T,>(path: string): Promise<T> => {
    const version = accountGeneration.current;
    const data = await spotifyApi<T>(path);
    if (version !== accountGeneration.current)
      throw new Error("Account changed. Please try again.");
    archive("response", path, data);
    return data;
  };
  const refreshDevices = async () => {
    const version = accountGeneration.current;
    const data = await readApi<{ devices: SpotifyDevice[] }>(
      "/me/player/devices",
    );
    if (alive.current && version === accountGeneration.current)
      setDevices(data.devices.filter((d) => d.id && !d.is_restricted));
  };
  const refreshPlayback = async () => {
    const version = accountGeneration.current;
    const state = await readApi<SpotifyPlayback | null>("/me/player");
    if (!alive.current || version !== accountGeneration.current) return;
    // Podcasts and local files do not have the album shape used by this music client.
    if (state && !playable(state.item)) state.item = null;
    setPlayback(state);
    if (state?.device.volume_percent != null)
      setVolume(state.device.volume_percent);
    if (
      state?.is_playing &&
      state.item &&
      lastListen.current !== state.item.uri
    ) {
      lastListen.current = state.item.uri;
      archive("listen", `${Date.now()}:${crypto.randomUUID()}`, state.item);
    }
  };
  const loadPlaylists = async (next?: string) => {
    const version = accountGeneration.current;
    const data = await readApi<SpotifyPage<SpotifyPlaylist | null>>(
      next || "/me/playlists?limit=50",
    );
    if (alive.current && version === accountGeneration.current) {
      setPlaylists((old) =>
        next
          ? [...old, ...(data.items.filter(Boolean) as SpotifyPlaylist[])]
          : (data.items.filter(Boolean) as SpotifyPlaylist[]),
      );
      setPlaylistNext(data.next);
    }
  };
  useEffect(() => {
    alive.current = true;
    finishSpotifyLogin()
      .then(() => {
        if (alive.current) setConnected(spotifyConnected());
      })
      .catch(report);
    return () => {
      alive.current = false;
      sdkGeneration.current++;
      player.current?.disconnect();
      player.current = null;
    };
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        'iframe[src$="/spotify-player.html"]',
      );
      if (
        event.origin !== location.origin ||
        event.source !== frame?.contentWindow ||
        !event.data?.cyberdeckAudio
      )
        return;
      setAudioCacheStatus(event.data.message);
      if (event.data.saved)
        window.dispatchEvent(new Event("cyberdeck-audio-saved"));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (!connected) {
      sdkGeneration.current++;
      player.current?.disconnect();
      player.current = null;
      setBrowserId("");
      return;
    }
    let canceled = false;
    // Preload the SDK so Play can activate audio inside the user's click gesture.
    void loadSpotifySdk().catch(() => {});
    const init = async () => {
      const me = await spotifyApi<{ id: string; display_name: string }>("/me");
      if (canceled) return;
      accountRef.current = me.id;
      setAccount(me.id);
      localStorage.setItem("cyberdeck-spotify-account", me.id);
      setName(me.display_name);
      archive("response", "/me", me);
      const results = await Promise.allSettled([
        loadPlaylists(),
        refreshDevices(),
        refreshPlayback(),
      ]);
      if (!canceled)
        for (const result of results)
          if (result.status === "rejected") report(result.reason);
    };
    void init().catch(report);
    return () => {
      canceled = true;
    };
  }, [connected]);
  useEffect(() => {
    if (!connected || !account) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      // Keep the listening journal current even when another Cyberdeck view is open.
      if (
        !document.hidden &&
        navigator.onLine &&
        (!savedAudio.current || savedAudio.current.paused)
      )
        try {
          await refreshPlayback();
        } catch (e) {
          if (!canceled) report(e);
        }
      if (!canceled) timer = setTimeout(poll, 10000);
    };
    timer = setTimeout(poll, 10000);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [connected, account]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (immersive) closeImmersive();
        setAddTrack(null);
        setCreateOpen(false);
      }
    };
    const fullscreen = () => {
      if (!document.fullscreenElement && immersive) closeImmersive();
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("fullscreenchange", fullscreen);
    };
  }, [immersive, routeKey]);
  useEffect(() => {
    if (!visible) {
      setVideoActive(false);
      setImmersive(false);
      if (document.fullscreenElement === root.current)
        void document.exitFullscreen().catch(report);
    }
  }, [visible]);
  useEffect(() => {
    setSeek(null);
    setVideoActive(false);
  }, [playback?.item?.id]);

  const enableBrowser = async (activateAudio = false): Promise<string> => {
    player.current?.disconnect();
    player.current = null;
    setBrowserId("");
    const version = ++sdkGeneration.current;
    setSdkStatus("Connecting browser…");
    setNotice("Connecting browser…");
    try {
      if (!window.Spotify) await loadSpotifySdk();
      if (!alive.current || version !== sdkGeneration.current)
        throw new Error("Browser connection canceled.");
      let ready!: (deviceId: string) => void;
      let failed!: (error: Error) => void;
      const readiness = new Promise<string>((resolve, reject) => {
        ready = resolve;
        failed = reject;
      });
      const p = new window.Spotify!.Player({
        name: "Cyberdeck",
        getOAuthToken: (cb) => {
          spotifyToken()
            .then(cb)
            .catch((e) => {
              failed(e);
              report(e);
            });
        },
        volume: 0.5,
      });
      player.current = p;
      const valid = () => alive.current && version === sdkGeneration.current;
      p.addListener("ready", ({ device_id }) => {
        if (valid()) {
          setBrowserId(device_id);
          setSelected(device_id);
          setSdkStatus("Browser ready");
          ready(device_id);
          void refreshDevices().catch(report);
        }
      });
      p.addListener("not_ready", ({ device_id }) => {
        if (valid()) {
          setBrowserId("");
          setSelected((old) => (old === device_id ? "" : old));
          setPlayback((old) => (old?.device.id === device_id ? null : old));
          setSdkStatus("Browser offline — press Play to reconnect");
          failed(new Error("Browser went offline. Press Play to reconnect."));
        }
      });
      p.addListener("player_state_changed", (state) => {
        if (!valid() || !state) return;
        const t = state.track_window?.current_track as SpotifyTrack | undefined;
        if (playable(t))
          document
            .querySelector<HTMLIFrameElement>(
              'iframe[src$="/spotify-player.html"]',
            )
            ?.contentWindow?.postMessage(
              {
                cyberdeckCaptureState: {
                  account: accountRef.current,
                  track: t,
                  paused: state.paused,
                  position: state.position,
                },
              },
              location.origin,
            );
        if (!state.paused && playable(t) && lastListen.current !== t.uri) {
          lastListen.current = t.uri;
          archive("listen", `${Date.now()}:${crypto.randomUUID()}`, t);
        }
      });
      for (const event of [
        "initialization_error",
        "authentication_error",
        "account_error",
        "playback_error",
      ])
        p.addListener(event, ({ message }) => {
          if (valid()) {
            const detail =
              event === "authentication_error"
                ? "Spotify needs renewed permissions for browser playback. Use Renew Spotify permissions to reconnect."
                : message;
            if (event === "authentication_error") setNeedsPermissions(true);
            setError(detail);
            setSdkStatus("Browser playback unavailable");
            failed(new Error(detail));
          }
        });
      p.addListener("autoplay_failed", () => {
        if (valid())
          setError(
            "Your browser blocked autoplay. Press Play here to allow audio.",
          );
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const [deviceId] = await Promise.race([
          Promise.all([
            readiness,
            // Activate before awaiting connection to preserve the click gesture.
            activateAudio ? p.activateElement() : Promise.resolve(),
            p.connect().then((ok) => {
              if (!ok)
                throw new Error(
                  "This browser cannot play protected audio. Choose another connected device.",
                );
            }),
          ]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Spotify browser connection timed out. Retry or choose another device.",
                  ),
                ),
              20000,
            );
          }),
        ]);
        if (!valid()) throw new Error("Browser connection canceled.");
        return deviceId;
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      if (version === sdkGeneration.current) {
        player.current?.disconnect();
        player.current = null;
        setBrowserId("");
        setSdkStatus("Browser playback unavailable");
      }
      throw e;
    } finally {
      if (alive.current && version === sdkGeneration.current) setNotice("");
    }
  };
  const target = selected || browserId;
  const activeTarget = !!playback && playback.device.id === target;
  const track = playback?.item;
  const activate = () =>
    target === browserId && player.current
      ? player.current.activateElement()
      : Promise.resolve();
  const playUri = async (uri?: string, offset?: string) => {
    savedAudio.current?.pause();
    if (!uri && !track) {
      uri =
        shelf.entity && ["playlist", "album"].includes(shelf.kind)
          ? shelf.entity.uri
          : shelf.tracks.find((t) => playable(t) && t.is_playable !== false)
              ?.uri;
      if (!uri) throw new Error("Choose a song or playlist, then press Play.");
    }
    setVideoActive(false);
    // Use the ready event's ID directly; React state updates arrive after this click.
    const deviceId = target || (await enableBrowser(true));
    if (target) await activate();
    if (!uri && track && playback?.device.id !== deviceId) uri = track.uri;
    await spotifyApi(
      "/me/player/play?device_id=" + encodeURIComponent(deviceId),
      "PUT",
      uri
        ? uri.startsWith("spotify:track:")
          ? { uris: [uri] }
          : { context_uri: uri, ...(offset ? { offset: { uri: offset } } : {}) }
        : undefined,
    );
    await refreshPlayback();
  };
  const command = async (
    path: string,
    method = "PUT",
    params?: Record<string, string>,
  ) => {
    setVideoActive(false);
    const q = new URLSearchParams({
      ...(target ? { device_id: target } : {}),
      ...params,
    });
    await spotifyApi(`/me/player/${path}?${q}`, method);
    await refreshPlayback();
  };
  const show = async (
    load: () => Promise<Shelf>,
    replace = false,
  ): Promise<Shelf | undefined> => {
    const version = ++viewGeneration.current;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await load();
      if (!alive.current || version !== viewGeneration.current) return;
      if (!replace) setBack((old) => [...old, shelf]);
      setShelf(next);
      content.current?.scrollTo({ top: 0 });
      return next;
    } catch (e) {
      if (version === viewGeneration.current) report(e);
    } finally {
      if (version === viewGeneration.current) setLoading(false);
    }
  };
  const openEntity = (entity: Card, replace = false) =>
    show(async () => {
      if (entity.kind === "artist") {
        const [artist, albums] = await Promise.all([
          readApi<SpotifyArtist>(`/artists/${entity.id}`),
          readApi<SpotifyPage<SpotifyAlbum>>(
            `/artists/${entity.id}/albums?limit=50&include_groups=album,single`,
          ),
        ]);
        return {
          kind: "artist",
          title: artist.name,
          subtitle: "Artist · albums & singles",
          entity: { ...artist, kind: "artist" },
          tracks: [],
          cards: albums.items.map((a) => ({ ...a, kind: "album" })),
          next: albums.next,
        };
      }
      if (entity.kind === "album") {
        const album = await readApi<
          SpotifyAlbum & { tracks: SpotifyPage<SpotifyTrack> }
        >(`/albums/${entity.id}`);
        return {
          kind: "album",
          title: album.name,
          subtitle: album.release_date,
          entity: { ...album, kind: "album" },
          tracks: album.tracks.items
            .filter(playable)
            .map((t) => ({ ...t, album })),
          cards: [],
          next: album.tracks.next,
        };
      }
      const playlist = await readApi<
        SpotifyPlaylist & {
          items?: SpotifyPage<PlaylistItem>;
          tracks?: SpotifyPage<PlaylistItem>;
        }
      >(`/playlists/${entity.id}`);
      const page = playlist.items || playlist.tracks;
      return {
        kind: "playlist",
        title: playlist.name,
        subtitle: page
          ? "Playlist"
          : "Spotify restricts track listings for this playlist. You can still play its context here.",
        entity: { ...playlist, kind: "playlist" },
        snapshot: playlist.snapshot_id,
        tracks:
          page?.items.map((i) => i.item ?? i.track).filter(playable) || [],
        cards: [],
        next: page?.next,
      };
    }, replace);
  const loadArchive = async () => {
    await archiveWrites.current;
    try {
      return await readSpotifyArchive(account);
    } catch {
      setArchiveStatus(
        "Node unavailable — using the browser copy; node sync is pending",
      );
      return readSpotifyArchive(account, true);
    }
  };
  const collection = (kind: string, replace = false) =>
    show(async () => {
      if (kind === "history") {
        const records = await loadArchive();
        return {
          kind,
          title: "Listening journal",
          subtitle:
            "Your listening history and saved audio · replay recorded portions offline",
          tracks: records
            .filter((r) => r.kind === "listen")
            .sort((a, b) => b.at - a.at)
            .map((r) => r.data as SpotifyTrack),
          cards: [],
        };
      }
      if (kind === "queue") {
        const data = await readApi<{ queue: SpotifyTrack[] }>(
          "/me/player/queue",
        );
        return {
          kind,
          title: "Up next",
          subtitle: "Live Spotify queue · add songs from any track menu",
          tracks: data.queue.filter(playable),
          cards: [],
        };
      }
      if (kind === "liked" || kind === "recent") {
        const data = await readApi<SpotifyPage<{ track: SpotifyTrack }>>(
          kind === "liked"
            ? "/me/tracks?limit=50"
            : "/me/player/recently-played?limit=50",
        );
        if (kind === "liked")
          setSaved((old) => ({
            ...old,
            ...Object.fromEntries(
              data.items
                .filter((i) => playable(i.track))
                .map((i) => [i.track.uri, true]),
            ),
          }));
        return {
          kind,
          title: kind === "liked" ? "Liked songs" : "Recently played",
          tracks: data.items.map((i) => i.track).filter(playable),
          cards: [],
          next: data.next,
        };
      }
      if (kind === "albums") {
        const data = await readApi<SpotifyPage<{ album: SpotifyAlbum }>>(
          "/me/albums?limit=50",
        );
        return {
          kind,
          title: "Saved albums",
          tracks: [],
          cards: data.items.map((i) => ({ ...i.album, kind: "album" })),
          next: data.next,
        };
      }
      const data = await readApi<{ artists: SpotifyPage<SpotifyArtist> }>(
        "/me/following?type=artist&limit=50",
      );
      return {
        kind,
        title: "Followed artists",
        tracks: [],
        cards: data.artists.items.map((a) => ({ ...a, kind: "artist" })),
        next: data.artists.next,
      };
    }, replace);
  const search = (q = query.trim(), radio = false, replace = false) =>
    show(async () => {
      const params = new URLSearchParams({
        q,
        type: radio ? "playlist" : "track,album,artist,playlist",
        limit: "10",
      });
      const data = await readApi<{
        tracks?: SpotifyPage<SpotifyTrack>;
        albums?: SpotifyPage<SpotifyAlbum>;
        artists?: SpotifyPage<SpotifyArtist>;
        playlists?: SpotifyPage<SpotifyPlaylist | null>;
      }>(`/search?${params}`);
      params.set("offset", "10");
      const next = Object.values(data).some((page) => !!page?.next)
        ? `https://api.spotify.com/v1/search?${params}`
        : null;
      return {
        kind: "search",
        next,
        title: radio ? "Radio mixes" : `Results for “${q}”`,
        subtitle: radio
          ? "Spotify playlist search. Personalized radio is not exposed to this app."
          : "Songs, albums, artists & playlists",
        tracks: data.tracks?.items.filter(playable) || [],
        cards: [
          ...(data.artists?.items || []).map((a) => ({
            ...a,
            kind: "artist" as const,
          })),
          ...(data.albums?.items || []).map((a) => ({
            ...a,
            kind: "album" as const,
          })),
          ...(data.playlists?.items || [])
            .filter(Boolean)
            .map((p) => ({ ...p!, kind: "playlist" as const })),
        ],
      };
    }, replace);
  const loadMore = async (current: Shelf): Promise<Shelf> => {
    if (!current.next) return current;
    const version = viewGeneration.current;
    const data = await readApi<any>(spotifyPagePath(current.next));
    if (version !== viewGeneration.current) return current;
    if (current.kind === "search") {
      const url = new URL(current.next);
      url.searchParams.set(
        "offset",
        String(Number(url.searchParams.get("offset") || 0) + 10),
      );
      const cards: Card[] = ["artists", "albums", "playlists"].flatMap((key) =>
        (data[key]?.items || []).filter(Boolean).map((item: Card) => ({
          ...item,
          kind: key.slice(0, -1) as Card["kind"],
        })),
      );
      return {
        ...current,
        tracks: [
          ...current.tracks,
          ...(data.tracks?.items || []).filter(playable),
        ],
        cards: [...current.cards, ...cards],
        next: Object.values(data).some((page: any) => !!page?.next)
          ? url.toString()
          : null,
      };
    }
    const page = current.kind === "artists" ? data.artists : data;
    const additions: SpotifyTrack[] = ["liked", "recent", "playlist"].includes(
      current.kind,
    )
      ? page.items.map((i: PlaylistItem) => i.item ?? i.track).filter(playable)
      : current.kind === "album"
        ? page.items
            .filter(playable)
            .map((t: SpotifyTrack) => ({ ...t, album: current.entity }))
        : [];
    const cards: Card[] =
      current.kind === "artist"
        ? page.items.map((a: SpotifyAlbum) => ({ ...a, kind: "album" }))
        : current.kind === "albums"
          ? page.items.map((i: { album: SpotifyAlbum }) => ({
              ...i.album,
              kind: "album",
            }))
          : current.kind === "artists"
            ? page.items.map((a: SpotifyArtist) => ({ ...a, kind: "artist" }))
            : [];
    return {
      ...current,
      tracks: [...current.tracks, ...additions],
      cards: [...current.cards, ...cards],
      next: page.next,
    };
  };
  const more = async () => {
    const version = viewGeneration.current;
    const next = await loadMore(shelf);
    if (version !== viewGeneration.current) return;
    setShelf(next);
    navigateMusic({
      shelf: currentLocation.shelf,
      id: currentLocation.id,
      query: currentLocation.query,
      page: currentLocation.page + 1,
      immersive,
    });
  };
  useEffect(() => {
    if (!visible) return;
    const parsed = spotifyLocation(params);
    if (routeHash("spotify", parsed.canonical) !== location.hash) {
      writeRoute("spotify", parsed.canonical, "replace");
      return;
    }
    const requested = parsed.location;
    immersiveClosing.current = false;
    setQuery(requested.query);
    setImmersive(requested.immersive);
    setBack([]);
    setResolvedRouteKey("");
    if (!connected || !account) return;
    const generation = ++routeGeneration.current;
    const restore = async () => {
      let next: Shelf | undefined;
      if (requested.shelf === "home") {
        viewGeneration.current++;
        setLoading(false);
        setShelf(emptyShelf);
        next = emptyShelf;
      } else if (["artist", "album", "playlist"].includes(requested.shelf)) {
        next = await openEntity(
          {
            id: requested.id,
            uri: `spotify:${requested.shelf}:${requested.id}`,
            name: "",
            images: [],
            kind: requested.shelf as Card["kind"],
          },
          true,
        );
      } else if (requested.shelf === "search") {
        next = await search(requested.query, requested.radio, true);
      } else {
        next = await collection(requested.shelf, true);
      }
      if (!next || generation !== routeGeneration.current) return;
      for (let page = 1; page < requested.page && next.next; page++) {
        next = await loadMore(next);
        if (generation !== routeGeneration.current) return;
      }
      if (generation !== routeGeneration.current) return;
      setShelf(next);
      setResolvedRouteKey(routeKey);
    };
    void restore();
  }, [visible, connected, account, routeKey]);
  useRouteTitle(
    visible && resolvedRouteKey === routeKey
      ? shelf.kind === "home"
        ? "Spotify"
        : `${shelf.title} · Spotify`
      : undefined,
  );
  const toggleSave = async (uri: string) => {
    let wasSaved = saved[uri];
    if (wasSaved === undefined)
      [wasSaved] = await spotifyApi<boolean[]>(
        `/me/library/contains?uris=${encodeURIComponent(uri)}`,
      );
    await spotifyApi(
      `/me/library?uris=${encodeURIComponent(uri)}`,
      wasSaved ? "DELETE" : "PUT",
    );
    setSaved((old) => ({ ...old, [uri]: !wasSaved }));
    setNotice(
      wasSaved
        ? "Removed from your Spotify library"
        : "Saved to your Spotify library",
    );
  };
  const exportArchive = async () => {
    const records = await loadArchive();
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              version: 1,
              exportedAt: new Date().toISOString(),
              account,
              records,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `cyberdeck-music-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const storageControls = (
    <details className="music-storage">
      <summary>Music archive</summary>
      <p>
        {archiveStatus}. History and fetched metadata have no automatic expiry.
        The node’s SQLite archive survives browser data removal. Browser audio
        is recorded as it plays, checkpointed locally, and backed up to this
        node. Skipped or partially played songs contain only the recorded
        portions. Videos are not saved.
      </p>
      <button
        className="music-button"
        onClick={() =>
          void run(async () => {
            const persisted = await navigator.storage?.persist?.();
            setArchiveStatus(
              persisted
                ? "Persistent browser storage granted"
                : "Browser did not grant persistent storage; export a backup",
            );
          })
        }
      >
        Protect storage
      </button>
      <button className="music-button" onClick={() => void run(exportArchive)}>
        Export metadata
      </button>
      <p>
        Disconnect removes this account’s browser and node archives and tokens.
        Export first to keep a backup.
      </p>
    </details>
  );
  const startSavedAudio = async (audio: HTMLAudioElement) => {
    if (savedAudio.current !== audio) savedAudio.current?.pause();
    if (player.current) await player.current.pause();
    savedAudio.current = audio;
    setPlayback((old) => (old ? { ...old, is_playing: false } : old));
  };

  const disconnect = async () => {
    savedAudio.current?.pause();
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[src$="/spotify-player.html"]',
    );
    if (frame?.contentWindow)
      await new Promise<void>((resolve, reject) => {
        const receive = (event: MessageEvent) => {
          if (
            event.origin === location.origin &&
            event.source === frame.contentWindow &&
            event.data?.cyberdeckCaptureStopped
          ) {
            clearTimeout(timeout);
            window.removeEventListener("message", receive);
            resolve();
          }
        };
        const timeout = setTimeout(() => {
          window.removeEventListener("message", receive);
          reject(new Error("Audio is still saving. Try disconnecting again."));
        }, 10000);
        window.addEventListener("message", receive);
        frame.contentWindow!.postMessage(
          { cyberdeckCaptureStop: true },
          location.origin,
        );
      });
    const owner = accountRef.current;
    accountRef.current = "";
    accountGeneration.current++;
    await archiveWrites.current;
    try {
      if (owner) await clearSpotifyArchive(owner);
    } catch (e) {
      accountRef.current = owner;
      throw e;
    }
    accountGeneration.current++;
    sdkGeneration.current++;
    viewGeneration.current++;
    accountRef.current = "";
    player.current?.disconnect();
    player.current = null;
    disconnectSpotify();
    localStorage.removeItem("cyberdeck-spotify-account");
    setConnected(false);
    setAccount("");
    setName("");
    setPlaylists([]);
    setShelf(emptyShelf);
    setBack([]);
    setDevices([]);
    setPlayback(null);
    setBrowserId("");
    setSelected("");
    setError("");
    setSdkStatus("");
    setSaved({});
    setImmersive(false);
    setAddTrack(null);
    setCreateOpen(false);
    lastListen.current = "";
    if (document.fullscreenElement === root.current)
      await document.exitFullscreen();
  };
  const fullscreen = async () => {
    setVideoActive(false);
    if (immersive) {
      closeImmersive();
      setImmersive(false);
      if (document.fullscreenElement === root.current)
        await document.exitFullscreen();
    } else {
      const next = spotifyRouteParams(readRoute().params, {
        ...currentLocation,
        immersive: true,
      });
      const hash = routeHash("spotify", next);
      if (location.hash !== hash) {
        history.pushState(
          { cyberdeckSpotifyImmersiveFrom: location.hash },
          "",
          hash,
        );
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
      setImmersive(true);
      if (root.current?.requestFullscreen)
        try {
          await root.current.requestFullscreen();
        } catch {
          /* Full-viewport layout also works where browser fullscreen is unavailable. */
        }
    }
  };
  const artistLinks = (artists: SpotifyArtist[] = []) =>
    artists.map((a, i) => (
      <span key={a.id || i}>
        {i > 0 && ", "}
        <button
          className="music-text"
          onClick={() => {
            setImmersive(false);
            navigateEntity({ ...a, kind: "artist" });
          }}
        >
          {a.name}
        </button>
      </span>
    ));
  const canEdit =
    shelf.entity?.kind === "playlist" &&
    ((shelf.entity as SpotifyPlaylist).owner?.id === account ||
      (shelf.entity as SpotifyPlaylist).collaborative);
  const trackRows = (tracks: SpotifyTrack[]) => (
    <div className="music-tracks">
      {tracks.map((t, i) => (
        <div
          className="music-track"
          key={`${t.uri}:${i}`}
          data-testid="music-track"
        >
          <button
            className="music-track-play"
            disabled={busy || t.is_playable === false}
            aria-label={`Play ${t.name}`}
            onClick={() =>
              void run(() =>
                playUri(
                  shelf.entity && ["playlist", "album"].includes(shelf.kind)
                    ? shelf.entity.uri
                    : t.uri,
                  shelf.entity ? t.uri : undefined,
                ),
              )
            }
          >
            <span className="music-number">
              {String(i + 1).padStart(2, "0")}
            </span>
            <PlayIcon size={16} />
          </button>
          <button
            className="music-thumb"
            aria-label={`Open album ${t.album?.name || t.name}`}
            disabled={!t.album?.id}
            onClick={() => navigateEntity({ ...t.album, kind: "album" })}
          >
            {t.album?.images?.[0] ? (
              <img src={t.album.images[0].url} alt="" />
            ) : (
              <MusicIcon size={20} />
            )}
          </button>
          <div className="music-track-title">
            <button
              className="music-text music-song"
              onClick={() => void run(() => playUri(t.uri))}
              disabled={busy || t.is_playable === false}
            >
              {t.name}
            </button>
            <div className="music-muted">{artistLinks(t.artists)}</div>
          </div>
          <span className="music-duration">{time(t.duration_ms)}</span>
          <details className="music-track-menu">
            <summary aria-label={`Actions for ${t.name}`}>•••</summary>
            <div className="music-menu">
              <button
                disabled={busy || !target}
                onClick={() =>
                  void run(async () => {
                    await command("queue", "POST", { uri: t.uri });
                    setNotice(`Added ${t.name} to queue`);
                  })
                }
              >
                Add to queue
              </button>
              <button
                disabled={busy}
                onClick={() => void run(() => toggleSave(t.uri))}
              >
                {saved[t.uri] ? "Unlike song" : "Like / unlike song"}
              </button>
              <button onClick={() => setAddTrack(t)}>Add to playlist</button>
              <button
                onClick={() =>
                  navigateSearch(
                    `${t.name} ${t.artists[0]?.name || ""} radio`,
                    true,
                  )
                }
              >
                Find radio mixes
              </button>
              {canEdit && (
                <>
                  <button
                    disabled={busy || i === 0}
                    onClick={() =>
                      void run(async () => {
                        await spotifyApi(
                          `/playlists/${shelf.entity!.id}/items`,
                          "PUT",
                          {
                            range_start: i,
                            insert_before: i - 1,
                            range_length: 1,
                            snapshot_id: shelf.snapshot,
                          },
                        );
                        await openEntity(shelf.entity!);
                      })
                    }
                  >
                    Move up
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await spotifyApi(
                          `/playlists/${shelf.entity!.id}/items`,
                          "DELETE",
                          {
                            items: [{ uri: t.uri }],
                            snapshot_id: shelf.snapshot,
                          },
                        );
                        await openEntity(shelf.entity!);
                      })
                    }
                  >
                    Remove song from playlist
                  </button>
                </>
              )}
            </div>
          </details>
        </div>
      ))}
    </div>
  );
  const cards = (items: Card[]) => (
    <div className="music-cards">
      {items.map((c, i) => (
        <button
          key={`${c.uri}:${i}`}
          aria-label={`Open ${c.kind} ${c.name}`}
          className={`music-card ${c.kind === "artist" ? "music-artist" : ""}`}
          onClick={() => navigateEntity(c)}
        >
          <div className="music-card-art">
            {c.images?.[0] ? (
              <img loading="lazy" src={c.images[0].url} alt="" />
            ) : (
              <MusicIcon size={42} />
            )}
            <span aria-hidden="true">→</span>
          </div>
          <strong>{c.name}</strong>
          <small>{c.kind}</small>
        </button>
      ))}
    </div>
  );
  return (
    <section
      ref={root}
      className={`music-app ${!visible ? "music-hidden" : ""} ${
        immersive ? "music-immersive" : ""
      }`}
      aria-label="Spotify music"
      data-testid="spotify-app"
    >
      <header className="music-header">
        <div>
          <span className="music-eyebrow">CYBERDECK / MUSIC</span>
          <h1>
            Listening room<span className="music-dot">●</span>
          </h1>
        </div>
        <div className="music-header-actions">
          <span className="music-provider">Spotify</span>
          {connected && (
            <button
              className="music-button"
              disabled={busy}
              onClick={() => void run(disconnect)}
            >
              Disconnect & clear archive
            </button>
          )}
        </div>
      </header>
      {error && (
        <div role="alert" className="music-alert">
          {error}
          {needsPermissions && (
            <button
              className="music-button"
              disabled={busy}
              onClick={() => void run(() => connectSpotify(clientId))}
            >
              Renew Spotify permissions
            </button>
          )}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {connected &&
        (archiveStatus.startsWith("Archive save failed") ||
          archiveStatus.startsWith("Node unavailable")) && (
          <div role="alert" className="music-alert">
            {archiveStatus}
          </div>
        )}
      {notice && (
        <div role="status" className="music-notice">
          {notice}
        </div>
      )}
      {!connected ? (
        <div className="music-welcome">
          <div className="music-welcome-art" aria-hidden="true">
            <div className="music-record">
              <span>
                CYBERDECK
                <br />
                SIDE A<br />♫
              </span>
            </div>
          </div>
          <div className="music-welcome-copy">
            <span className="music-eyebrow">YOUR CUSTOM CYBERDECK PLAYER</span>
            <h2>
              Make room
              <br />
              for music.
            </h2>
            <p>
              Your playlists. Your queue. Your album covers, filling the screen.
              All inside Cyberdeck.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => connectSpotify(clientId));
              }}
            >
              <button
                className="music-button music-primary"
                disabled={busy || !!originError || !clientId.trim()}
              >
                Connect Spotify
              </button>
            </form>
            <p className="music-fine">
              Spotify Premium required. Secure sign-in returns here. Audio
              streams from Spotify. Browser playback, listening history and
              browsed metadata are saved here and backed up to this Cyberdeck
              node.
            </p>
            <details>
              <summary>Connection details</summary>
              <p className="music-fine">
                Your existing Cyberdeck app is configured. This browser returns
                to:
              </p>
              <code data-testid="spotify-redirect">
                {redirect || "HTTPS or loopback required"}
              </code>
              <p className="music-fine">
                No client secret is needed. Sign-in permissions cover playback,
                library and playlist editing.
              </p>
            </details>
            {originError && <p role="alert">{originError}</p>}
            {account && (
              <SpotifyRecordings account={account} onStart={startSavedAudio} />
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="music-workspace">
            <aside className="music-sidebar">
              <span className="music-eyebrow">YOUR COLLECTION</span>
              <nav>
                {[
                  ["home", "Overview"],
                  ["liked", "Liked songs"],
                  ["albums", "Albums"],
                  ["artists", "Artists"],
                  ["recent", "Recently played"],
                  ["queue", "Queue"],
                  ["history", "Listening journal"],
                ].map(([kind, label]) => (
                  <button
                    key={kind}
                    aria-current={shelf.kind === kind ? "page" : undefined}
                    disabled={!account}
                    onClick={() => navigateCollection(kind)}
                  >
                    {label}
                    <span aria-hidden="true">→</span>
                  </button>
                ))}
              </nav>
              <div className="music-sidebar-label">
                <span className="music-eyebrow">PLAYLISTS</span>
                <button
                  aria-label="Create playlist"
                  onClick={() => {
                    setEditingPlaylist(false);
                    setPlaylistName("");
                    setCreateOpen(true);
                  }}
                >
                  +
                </button>
              </div>
              <div className="music-playlist-links">
                {playlists.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => navigateEntity({ ...p, kind: "playlist" })}
                  >
                    {p.name}
                  </button>
                ))}
                {playlistNext && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        loadPlaylists(spotifyPagePath(playlistNext)),
                      )
                    }
                  >
                    More playlists
                  </button>
                )}
              </div>
              {storageControls}
            </aside>
            <div className="music-content" ref={content}>
              {playback?.is_playing && !immersive && (
                <SpotifyVisualizer active={visible && !immersive} device={playback.device.name} />
              )}
              <form
                className="music-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  const uri = spotifyUri(query.trim());
                  if (uri) {
                    const [, kind, id] = uri.split(":");
                    if (kind === "track") void run(() => playUri(uri));
                    else
                      navigateEntity({
                        id: id!,
                        uri,
                        name: "",
                        images: [],
                        kind: kind as Card["kind"],
                      });
                  } else navigateSearch();
                }}
              >
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label="Search Spotify"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Songs, artists, albums, playlists…"
                />
                <button
                  className="music-button"
                  disabled={!query.trim() || !account}
                >
                  Search
                </button>
              </form>
              <div className="music-shelf-heading">
                {shelf.kind !== "home" && (
                  <button
                    className="music-button"
                    aria-label="Back in music"
                    onClick={() => navigateMusic({ shelf: "home" })}
                  >
                    ←
                  </button>
                )}
                <div>
                  <span className="music-eyebrow">
                    {shelf.kind === "home"
                      ? "ON REPEAT / ON DISCOVERY"
                      : shelf.kind}
                  </span>
                  <h2>{shelf.title}</h2>
                  {shelf.subtitle && (
                    <p className="music-muted">{shelf.subtitle}</p>
                  )}
                </div>
              </div>
              {shelf.kind === "history" && account && (
                <>
                  <p className="music-fine" role="status">
                    {audioCacheStatus}
                  </p>
                  <SpotifyRecordings
                    account={account}
                    onStart={startSavedAudio}
                  />
                </>
              )}
              {loading ? (
                <div className="music-empty" role="status">
                  Loading your music…
                </div>
              ) : (
                <>
                  {shelf.entity && (
                    <div className="music-entity">
                      {shelf.entity.images?.[0] && (
                        <img
                          src={shelf.entity.images[0].url}
                          alt={`${shelf.title} artwork`}
                        />
                      )}
                      <div>
                        {"artists" in shelf.entity && (
                          <p>{artistLinks(shelf.entity.artists)}</p>
                        )}
                        <div className="music-actions">
                          <button
                            className="music-button music-primary"
                            disabled={busy}
                            onClick={() =>
                              void run(() => playUri(shelf.entity!.uri))
                            }
                          >
                            Play {shelf.entity.kind}
                          </button>
                          {shelf.entity.kind !== "artist" && (
                            <button
                              className="music-button"
                              disabled={busy}
                              onClick={() =>
                                void run(() => toggleSave(shelf.entity!.uri))
                              }
                            >
                              Save / unsave
                            </button>
                          )}
                          <button
                            className="music-button"
                            onClick={() =>
                              navigateSearch(`${shelf.title} radio`, true)
                            }
                          >
                            Radio mixes
                          </button>
                          {canEdit && (
                            <button
                              className="music-button"
                              onClick={() => {
                                setEditingPlaylist(true);
                                setPlaylistName(shelf.title);
                                setCreateOpen(true);
                              }}
                            >
                              Rename playlist
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {shelf.kind === "home" ? (
                    <>
                      <div className="music-feature">
                        <div>
                          <span className="music-eyebrow">
                            CONNECTED AS {name}
                          </span>
                          <h3>
                            The next record
                            <br />
                            is yours.
                          </h3>
                          <p>
                            Pick a playlist, follow a credit, find a new
                            favorite.
                          </p>
                          <button
                            className="music-button music-primary"
                            onClick={() => navigateCollection("recent")}
                          >
                            Pick up where you left off
                          </button>
                        </div>
                        <button
                          className="music-feature-art"
                          disabled={!track}
                          aria-label="Fullscreen artwork"
                          onClick={() => void fullscreen()}
                        >
                          {track?.album?.images?.[0] ? (
                            <img
                              src={track.album.images[0].url}
                              alt={track.album.name}
                            />
                          ) : (
                            <MusicIcon size={100} />
                          )}
                        </button>
                      </div>
                      <div className="music-section-title">
                        <h3>Your playlists</h3>
                        <button
                          className="music-text"
                          onClick={() => {
                            setEditingPlaylist(false);
                            setPlaylistName("");
                            setCreateOpen(true);
                          }}
                        >
                          + New playlist
                        </button>
                      </div>
                      {cards(
                        playlists.map((p) => ({ ...p, kind: "playlist" })),
                      )}
                      {playlistNext && (
                        <button
                          className="music-button"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              loadPlaylists(spotifyPagePath(playlistNext)),
                            )
                          }
                        >
                          More playlists
                        </button>
                      )}
                      {!playlists.length && (
                        <p className="music-muted">
                          Your playlists will appear here after connecting.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      {cards(shelf.cards)}
                      {trackRows(shelf.tracks)}
                      {!shelf.cards.length &&
                        !shelf.tracks.length &&
                        !shelf.entity && (
                          <div className="music-empty">
                            Nothing here yet. Find something you love.
                          </div>
                        )}
                      {shelf.next && (
                        <button
                          className="music-button"
                          disabled={busy}
                          onClick={() => void run(more)}
                        >
                          Load more
                        </button>
                      )}
                      {shelf.kind === "queue" && (
                        <>
                          <button
                            className="music-button"
                            onClick={() => void collection("queue")}
                          >
                            Refresh queue
                          </button>
                          <p className="music-fine">
                            Spotify’s API supports viewing and adding to the
                            queue. Removing or reordering its existing entries
                            is not available.
                          </p>
                        </>
                      )}
                    </>
                  )}
                </>
              )}
              {track && (
                <section className="music-video">
                  <div className="music-section-title">
                    <h3>Music video</h3>
                    <span className="music-eyebrow">FROM SPOTIFY</span>
                  </div>
                  <p className="music-fine">
                    Spotify automatically displays the video here when this
                    track is eligible. Availability and sign-in depend on
                    Spotify.
                  </p>
                  <div className="music-video-frame">
                    <iframe
                      key={`${track.id}:${videoActive}`}
                      title={`Spotify video for ${track.name}`}
                      src={`https://open.spotify.com/embed/track/${encodeURIComponent(
                        track.id,
                      )}`}
                      sandbox="allow-scripts allow-same-origin allow-forms"
                      allow="encrypted-media; fullscreen; picture-in-picture"
                      allowFullScreen
                      tabIndex={videoActive ? 0 : -1}
                      inert={!videoActive}
                    />
                    {!videoActive && (
                      <button
                        className="music-video-start"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            if (playback?.is_playing) {
                              await spotifyApi(
                                `/me/player/pause?device_id=${encodeURIComponent(
                                  playback.device.id || "",
                                )}`,
                                "PUT",
                              );
                              await refreshPlayback();
                            }
                            setVideoActive(true);
                          })
                        }
                      >
                        <span className="music-button music-primary">
                          Watch here
                        </span>
                        <small>
                          Pauses audio before enabling the video player
                        </small>
                      </button>
                    )}
                  </div>
                  {videoActive && (
                    <button
                      className="music-button"
                      onClick={() => setVideoActive(false)}
                    >
                      Close video playback
                    </button>
                  )}
                </section>
              )}
              <details className="music-devices">
                <summary>
                  Playback & connection{" "}
                  <span>{sdkStatus || "Press Play to listen here"}</span>
                </summary>
                <p className="music-fine">Connected as {name}</p>
                <div className="music-actions">
                  <button
                    className="music-button"
                    disabled={busy}
                    onClick={() => void run(() => enableBrowser())}
                  >
                    {browserId
                      ? "Reconnect browser"
                      : "Enable browser playback"}
                  </button>
                  <label>
                    Device{" "}
                    <select
                      aria-label="Playback device"
                      value={target || ""}
                      onChange={(e) => setSelected(e.target.value)}
                    >
                      <option value="">This browser (connect on Play)</option>
                      {browserId && (
                        <option value={browserId}>
                          This browser — Cyberdeck
                        </option>
                      )}
                      {devices
                        .filter((d) => d.id !== browserId)
                        .map((d) => (
                          <option key={d.id} value={d.id!}>
                            {d.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    className="music-button"
                    disabled={busy}
                    onClick={() => void run(refreshDevices)}
                  >
                    Refresh devices
                  </button>
                  <button
                    className="music-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        savedAudio.current?.pause();
                        const deviceId = target || (await enableBrowser(true));
                        if (target) await activate();
                        await spotifyApi("/me/player", "PUT", {
                          device_ids: [deviceId],
                          play: true,
                        });
                        await refreshPlayback();
                      })
                    }
                  >
                    Listen here
                  </button>
                  <button
                    className="music-button"
                    disabled={busy}
                    onClick={() => void run(() => connectSpotify(clientId))}
                  >
                    Renew permissions
                  </button>
                </div>
                <p className="music-fine">
                  Custom controls play audio through Spotify’s SDK. The in-app
                  video panel uses Spotify’s own embedded player; video
                  availability and controls belong to Spotify.
                </p>
              </details>
              <div className="music-mobile-storage">{storageControls}</div>
            </div>
          </div>
          {immersive && (
            <div className="music-art-stage">
              <header>
                <span className="music-eyebrow">CYBERDECK / NOW PLAYING</span>
                <button
                  className="music-button"
                  onClick={() => void fullscreen()}
                >
                  Close fullscreen
                </button>
              </header>
              {playback?.is_playing && (
                <SpotifyVisualizer active={visible && immersive} device={playback.device.name} />
              )}
              <div className="music-art-composition">
                {track?.album?.images?.[0] ? (
                  <img
                    className="music-full-art"
                    src={track.album.images[0].url}
                    alt={`${track.album.name} album artwork`}
                  />
                ) : (
                  <div className="music-full-art music-art-placeholder">
                    <MusicIcon size={100} />
                  </div>
                )}
                <div className="music-art-caption">
                  <span className="music-eyebrow">
                    {playback?.is_playing ? "ON THE DECK" : "PAUSED"}
                  </span>
                  <h2>{track?.name || "Choose your soundtrack"}</h2>
                  <div>{artistLinks(track?.artists)}</div>
                  <button
                    className="music-text"
                    onClick={() => {
                      setImmersive(false);
                      if (track?.album)
                        navigateEntity({ ...track.album, kind: "album" });
                    }}
                  >
                    {track?.album?.name}
                  </button>
                </div>
              </div>
            </div>
          )}
          <footer className="music-player">
            <div className="music-now">
              <button
                className="music-now-art"
                aria-label="Expand artwork"
                onClick={() => void fullscreen()}
              >
                {track?.album?.images?.[0] ? (
                  <img src={track.album.images[0].url} alt="Album artwork" />
                ) : (
                  <MusicIcon />
                )}
              </button>
              <div>
                <button
                  className="music-text music-song"
                  onClick={() => void fullscreen()}
                >
                  {track?.name || "Ready when you are"}
                </button>
                <div className="music-muted">{artistLinks(track?.artists)}</div>
              </div>
            </div>
            <div className="music-transport">
              <div className="music-transport-buttons">
                <button
                  aria-label="Shuffle"
                  aria-pressed={!!playback?.shuffle_state}
                  disabled={busy || !activeTarget}
                  onClick={() =>
                    void run(() =>
                      command("shuffle", "PUT", {
                        state: String(!playback?.shuffle_state),
                      }),
                    )
                  }
                >
                  ⤨
                </button>
                <button
                  aria-label="Previous track"
                  disabled={busy || !activeTarget}
                  onClick={() => void run(() => command("previous", "POST"))}
                >
                  <SkipBackIcon size={20} />
                </button>
                <button
                  className="music-play"
                  aria-label={
                    activeTarget && playback?.is_playing ? "Pause" : "Play"
                  }
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      activeTarget && playback?.is_playing
                        ? command("pause")
                        : playUri(),
                    )
                  }
                >
                  {activeTarget && playback?.is_playing ? (
                    <PauseIcon size={22} />
                  ) : (
                    <PlayIcon size={22} />
                  )}
                </button>
                <button
                  aria-label="Next track"
                  disabled={busy || !activeTarget}
                  onClick={() => void run(() => command("next", "POST"))}
                >
                  <SkipFwdIcon size={20} />
                </button>
                <button
                  aria-label={`Repeat: ${playback?.repeat_state || "off"}`}
                  aria-pressed={!!playback && playback.repeat_state !== "off"}
                  disabled={busy || !activeTarget}
                  onClick={() =>
                    void run(() =>
                      command("repeat", "PUT", {
                        state:
                          playback?.repeat_state === "off"
                            ? "context"
                            : playback?.repeat_state === "context"
                              ? "track"
                              : "off",
                      }),
                    )
                  }
                >
                  {playback?.repeat_state === "track" ? "↻¹" : "↻"}
                </button>
              </div>
              <div className="music-progress">
                <span>{time(seek ?? playback?.progress_ms ?? 0)}</span>
                <input
                  aria-label="Playback position"
                  type="range"
                  min={0}
                  max={track?.duration_ms || 1}
                  value={seek ?? playback?.progress_ms ?? 0}
                  disabled={busy || !activeTarget || !track}
                  onChange={(e) => setSeek(Number(e.target.value))}
                  onPointerUp={(e) => {
                    const value = Number(e.currentTarget.value);
                    void run(async () => {
                      await command("seek", "PUT", {
                        position_ms: String(value),
                      });
                      setSeek(null);
                    });
                  }}
                  onKeyUp={(e) => {
                    if (
                      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                    ) {
                      const value = e.currentTarget.value;
                      void run(async () => {
                        await command("seek", "PUT", { position_ms: value });
                        setSeek(null);
                      });
                    }
                  }}
                />
                <span>{time(track?.duration_ms || 0)}</span>
              </div>
            </div>
            <div className="music-player-right">
              <button
                aria-label="Show queue"
                onClick={() => {
                  setImmersive(false);
                  navigateCollection("queue");
                }}
              >
                Queue
              </button>
              <button
                aria-label="Toggle fullscreen artwork"
                onClick={() => void fullscreen()}
              >
                ⛶
              </button>
              {activeTarget &&
                playback.device.supports_volume !== false &&
                playback.device.volume_percent !== null && (
                  <input
                    aria-label="Volume"
                    type="range"
                    min={0}
                    max={100}
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    onPointerUp={(e) => {
                      const value = e.currentTarget.value;
                      void run(() =>
                        command("volume", "PUT", { volume_percent: value }),
                      );
                    }}
                    onKeyUp={(e) => {
                      if (
                        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          e.key,
                        )
                      ) {
                        const value = e.currentTarget.value;
                        void run(() =>
                          command("volume", "PUT", { volume_percent: value }),
                        );
                      }
                    }}
                  />
                )}
            </div>
          </footer>
        </>
      )}
      {(addTrack || createOpen) && (
        <div
          className="music-modal"
          role="dialog"
          aria-modal="true"
          aria-label={addTrack ? "Add to playlist" : "Playlist details"}
        >
          <div>
            <button
              className="music-modal-close"
              aria-label="Close dialog"
              onClick={() => {
                setAddTrack(null);
                setCreateOpen(false);
              }}
            >
              ×
            </button>
            {addTrack ? (
              <>
                <h2>Add to playlist</h2>
                <p>{addTrack.name}</p>
                {playlists
                  .filter((p) => p.owner?.id === account || p.collaborative)
                  .map((p) => (
                    <button
                      className="music-button"
                      key={p.id}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await spotifyApi(`/playlists/${p.id}/items`, "POST", {
                            uris: [addTrack.uri],
                          });
                          setNotice(`Added to ${p.name}`);
                          setAddTrack(null);
                        })
                      }
                    >
                      {p.name}
                    </button>
                  ))}
                {playlistNext && (
                  <button
                    className="music-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        loadPlaylists(spotifyPagePath(playlistNext)),
                      )
                    }
                  >
                    More playlists
                  </button>
                )}
                <button
                  className="music-button"
                  onClick={() => {
                    setEditingPlaylist(false);
                    setPlaylistName("");
                    setCreateOpen(true);
                    setAddTrack(null);
                  }}
                >
                  Create a playlist
                </button>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    if (
                      editingPlaylist &&
                      canEdit &&
                      playlistName &&
                      shelf.entity
                    ) {
                      await spotifyApi(`/playlists/${shelf.entity.id}`, "PUT", {
                        name: playlistName.trim(),
                      });
                      await openEntity(shelf.entity);
                    } else {
                      const p = await spotifyApi<SpotifyPlaylist>(
                        "/me/playlists",
                        "POST",
                        { name: playlistName.trim(), public: false },
                      );
                      navigateEntity({ ...p, kind: "playlist" });
                    }
                    await loadPlaylists();
                    setCreateOpen(false);
                  });
                }}
              >
                <h2>{editingPlaylist ? "Rename playlist" : "New playlist"}</h2>
                <label htmlFor="music-playlist-name">Playlist name</label>
                <input
                  id="music-playlist-name"
                  autoFocus
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                />
                <button
                  className="music-button music-primary"
                  disabled={busy || !playlistName.trim()}
                >
                  Save playlist
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
