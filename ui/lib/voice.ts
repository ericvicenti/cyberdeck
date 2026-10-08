// Voice on the Desk: one LiveKit room per call, minted by this node's daemon
// (/api/voice/*), which bridges to the Seed agents server. The browser joins,
// publishes the mic, plays the agent's audio track and mirrors the voice
// worker's pipeline state (participant attribute `lk.agent.state`). Mirrors the
// desktop hook in Seed (frontend/packages/ui/src/agents/voice.ts) with a
// transcript, a mic level and a mute switch on top.
import type { Room, LocalAudioTrack, Participant, RemoteTrack, TranscriptionSegment } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, activeNode, ApiError, type ApiInit } from "./api";

export type VoicePhase = "idle" | "connecting" | "live" | "ending" | "error";
/** The worker's published pipeline state; `initializing` until it says otherwise. */
export type AgentState = "initializing" | "listening" | "thinking" | "speaking" | "idle";
export type TranscriptLine = { id: string; who: "me" | "agent"; text: string; final: boolean; at: number };

export type VoiceConfig = { configured: boolean; provider: "livekit" | "none"; reason?: string; agentId?: string; sessionId?: string };
type LivekitGrant = { url: string; token: string; room: string; identity: string; expiresAt?: number };

export type Voice = {
  phase: VoicePhase;
  agentState: AgentState;
  /** The LiveKit room of the current call (null when not connected); the Desk hands it to session resets. */
  room: string | null;
  /** Readable reason for `phase === 'error'`; cleared by the next start. */
  error?: string;
  /** Last `/api/voice/config` answer; null until loaded, `configured:false` + `reason` when voice is off. */
  config: VoiceConfig | null;
  configError?: string;
  /** Set when the calls go to another node because the one in view has no voice; the Desk sends its own requests there too. */
  route: VoiceRoute | null;
  transcript: TranscriptLine[];
  /** Local mic level 0..1 while live (0 when muted or idle). */
  level: number;
  muted: boolean;
  /** Send "Hi" on lk.chat right after joining so the agent greets first (the iPad client does). */
  greet: boolean;
  setGreet: (on: boolean) => void;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => void;
  toggleMute: () => void;
  refreshConfig: () => Promise<void>;
  clearTranscript: () => void;
};

/** A paired node whose daemon answers for voice when the one in view has no voice bridge. */
export type VoiceRoute = { node: string; name: string };

/** A voice request, sent to the node in view or through the local daemon's proxy to `route`. */
export function voiceApi<T>(route: VoiceRoute | null, path: string, init?: ApiInit): Promise<T> {
  if (!route) return api<T>(path, init);
  return api<T>(route.node === "local" ? path : `/api/nodes/${route.node}/proxy/${path.slice("/api/".length)}`, { ...init, local: true });
}
const voicePost = <T,>(route: VoiceRoute | null, path: string, body: unknown): Promise<T> =>
  voiceApi<T>(route, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const ROUTE_KEY = "cyberdeck-voice-route";
const askVoiceNode = (route: VoiceRoute) => voiceApi<VoiceConfig>(route, "/api/voice/config").then((config) => ({ route, config })).catch(() => null);

/** The first other node of the fleet (this daemon included, when a remote node is in view) with voice set up. */
async function findVoiceNode(): Promise<{ route: VoiceRoute; config: VoiceConfig } | null> {
  const viewed = activeNode();
  // The node that took the last call answers in milliseconds; the fleet listing probes every peer first.
  try {
    const last = JSON.parse(localStorage.getItem(ROUTE_KEY) ?? "null") as VoiceRoute | null;
    const again = last?.node && last.node !== (viewed || "local") ? await askVoiceNode(last) : null;
    if (again?.config.configured) return again;
  } catch {}
  const fleet = await api<{ self?: { name?: string }; nodes?: { id: string; name: string; online?: boolean }[] }>("/api/fleet/nodes").catch(() => null);
  if (!fleet) return null;
  const routes: VoiceRoute[] = [
    ...(viewed ? [{ node: "local", name: fleet.self?.name ?? "this node" }] : []),
    ...(fleet.nodes ?? []).filter((n) => n.online && n.id !== viewed).map((n) => ({ node: n.id, name: n.name })),
  ];
  const found = (await Promise.all(routes.map(askVoiceNode))).find((a) => a?.config.configured) ?? null;
  try { if (found) localStorage.setItem(ROUTE_KEY, JSON.stringify(found.route)); } catch {}
  return found;
}

type LiveKit = typeof import("livekit-client");
let livekitModule: Promise<LiveKit> | undefined;
const loadLiveKit = (): Promise<LiveKit> => (livekitModule ??= import("livekit-client"));

const AGENT_STATE_ATTRIBUTE = "lk.agent.state";
const AGENT_STATES: ReadonlySet<string> = new Set(["initializing", "listening", "thinking", "speaking", "idle"]);
const GREET_KEY = "cyberdeck-voice-greet";
const MAX_LINES = 200;

const toAgentState = (value: string | undefined): AgentState | null => (value && AGENT_STATES.has(value) ? (value as AgentState) : null);

/** Turns the failures a start can hit into the one line the button shows. */
export function describeVoiceError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Signed out: unlock Cyberdeck again";
    if (err.status === 404) return "This daemon has no voice routes (update Cyberdeck)";
    if (err.status === 503) return err.message || "Voice is not configured on this node";
    if (err.status === 502) return err.message || "The agents server rejected the call";
    return err.message || `Request failed (${err.status})`;
  }
  const name = typeof err === "object" && err ? (err as { name?: unknown }).name : undefined;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Microphone access was denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No microphone was found";
  if (name === "NotReadableError") return "The microphone is in use by another app";
  if (name === "SecurityError") return "The microphone needs HTTPS or localhost";
  if (err instanceof Error && err.message) return err.message;
  return "Could not start voice";
}

/** The browser only hands out getUserMedia on a secure context. */
export const micAllowedHere = (): boolean => typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

export function useVoice({ onLocked }: { onLocked?: () => void } = {}): Voice {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [agentState, setAgentState] = useState<AgentState>("initializing");
  const [error, setError] = useState<string | undefined>();
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [configError, setConfigError] = useState<string | undefined>();
  const [route, setRoute] = useState<VoiceRoute | null>(null);
  const routeRef = useRef<VoiceRoute | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [greet, setGreetState] = useState<boolean>(() => {
    try { return localStorage.getItem(GREET_KEY) === "1"; } catch { return false; }
  });

  const roomRef = useRef<Room | null>(null);
  const audioElsRef = useRef<HTMLMediaElement[]>([]);
  const analyserRef = useRef<{ cleanup: () => Promise<void> | void; timer: number } | null>(null);
  /** Bumped by every start and stop so a start still awaiting the grant or the connection
   * notices it was superseded and tears its room down instead of publishing a stale one. */
  const attemptRef = useRef(0);
  const phaseRef = useRef<VoicePhase>("idle");
  phaseRef.current = phase;
  const greetRef = useRef(greet);
  greetRef.current = greet;
  const onLockedRef = useRef(onLocked);
  onLockedRef.current = onLocked;

  const setGreet = useCallback((on: boolean) => {
    setGreetState(on);
    try { localStorage.setItem(GREET_KEY, on ? "1" : "0"); } catch {}
  }, []);

  const refreshConfig = useCallback(async () => {
    let own: VoiceConfig;
    let ownError: string | undefined;
    try {
      own = await api<VoiceConfig>("/api/voice/config");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { onLockedRef.current?.(); return; }
      // An older daemon without the voice routes reads as "not configured" with a reason.
      ownError = describeVoiceError(e);
      own = { configured: false, provider: "none", reason: ownError };
    }
    // The agents server lives on one machine of the fleet: when this node has no voice, a paired one takes the call.
    const other = own.configured ? null : await findVoiceNode();
    routeRef.current = other?.route ?? null;
    setRoute(other?.route ?? null);
    setConfig(other?.config ?? own);
    setConfigError(other ? undefined : ownError);
  }, []);

  useEffect(() => { void refreshConfig(); }, [refreshConfig]);

  const stopAnalyser = useCallback(() => {
    const a = analyserRef.current;
    analyserRef.current = null;
    if (a) { clearInterval(a.timer); void Promise.resolve(a.cleanup()).catch(() => {}); }
    setLevel(0);
  }, []);

  const startAnalyser = useCallback((track: LocalAudioTrack, createAudioAnalyser: LiveKit["createAudioAnalyser"]) => {
    stopAnalyser();
    try {
      const { calculateVolume, cleanup } = createAudioAnalyser(track, { fftSize: 256, smoothingTimeConstant: 0.6 });
      let last = -1;
      const timer = window.setInterval(() => {
        // Crest the quiet floor so a whisper still moves the ring; two decimals keeps renders rare.
        const v = Math.round(Math.min(1, calculateVolume() * 2.2) * 100) / 100;
        if (v !== last) { last = v; setLevel(track.isMuted ? 0 : v); }
      }, 60);
      analyserRef.current = { cleanup, timer };
    } catch {
      // Web Audio unavailable: the button just does not breathe with the mic.
    }
  }, [stopAnalyser]);

  const removeAudioElements = useCallback(() => {
    for (const el of audioElsRef.current) el.remove();
    audioElsRef.current = [];
  }, []);

  const resetLive = useCallback(() => {
    setAgentState("initializing");
    setMuted(false);
    setRoomName(null);
    stopAnalyser();
  }, [stopAnalyser]);

  /** Stable: reads everything through refs so effects and the button can hold onto it. */
  const stop = useCallback(() => {
    attemptRef.current += 1;
    const room = roomRef.current;
    roomRef.current = null;
    removeAudioElements();
    resetLive();
    setError(undefined);
    if (room) {
      setPhase("ending");
      phaseRef.current = "ending";
      room.removeAllListeners();
      void room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      void room.disconnect().catch(() => {}).finally(() => {
        // Only land on idle if nothing newer took over meanwhile.
        if (roomRef.current === null && phaseRef.current === "ending") { setPhase("idle"); phaseRef.current = "idle"; }
      });
    } else if (phaseRef.current !== "idle") {
      setPhase("idle");
      phaseRef.current = "idle";
    }
  }, [removeAudioElements, resetLive]);

  const upsertLine = useCallback((line: TranscriptLine) => {
    setTranscript((prev) => {
      const i = prev.findIndex((l) => l.id === line.id);
      if (i === -1) return [...prev, line].slice(-MAX_LINES);
      const next = prev.slice();
      next[i] = { ...prev[i], ...line, at: prev[i].at };
      return next;
    });
  }, []);

  const start = useCallback(async () => {
    if (phaseRef.current === "connecting" || phaseRef.current === "live") return;
    const attempt = ++attemptRef.current;
    const superseded = () => attemptRef.current !== attempt;
    setError(undefined);
    setPhase("connecting");
    phaseRef.current = "connecting";
    resetLive();

    let room: Room | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(window.isSecureContext ? "Microphone access is not available in this browser" : "The microphone needs HTTPS or localhost");
      // The LiveKit SDK is large; only the first call on this page pays for it.
      const [grant, { Room, RoomEvent, Track, createAudioAnalyser }] = await Promise.all([voicePost<LivekitGrant>(routeRef.current, "/api/voice/livekit", {}), loadLiveKit()]);
      if (superseded()) return;
      // An https page may not open a plain ws:// socket (other than to localhost), and the SDK only reports a generic failure.
      if (location.protocol === "https:" && /^ws:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/.test(grant.url)) throw new Error(`The call server is plain ${grant.url}, which an https page cannot reach: open Cyberdeck at http://localhost on this machine`);

      room = new Room({ adaptiveStream: true, dynacast: true });
      const current = room;
      const isLocal = (p?: Participant) => !!p && p.identity === current.localParticipant.identity;

      // The agent's audio plays through hidden elements on the body, so the view never lays them out.
      current.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.style.display = "none";
        document.body.appendChild(el);
        audioElsRef.current.push(el);
      });
      current.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        for (const el of track.detach()) {
          audioElsRef.current = audioElsRef.current.filter((a) => a !== el);
          el.remove();
        }
      });
      // The worker publishes its pipeline state as a participant attribute; it may already be
      // in the room (read after connect) or join after us.
      const readAgentState = (p: Participant) => {
        if (isLocal(p)) return;
        const next = toAgentState(p.attributes?.[AGENT_STATE_ATTRIBUTE]);
        if (next) setAgentState(next);
      };
      current.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => readAgentState(p));
      current.on(RoomEvent.ParticipantConnected, (p) => readAgentState(p));
      // Transcriptions arrive per segment (lk.transcription text streams, surfaced by the SDK);
      // the user's are attributed to the local participant, the agent's to the worker.
      current.on(RoomEvent.TranscriptionReceived, (segments: TranscriptionSegment[], p?: Participant) => {
        const who = isLocal(p) ? "me" : "agent";
        for (const seg of segments) {
          if (!seg.text?.trim() && !seg.final) continue;
          upsertLine({ id: `${who}:${seg.id}`, who, text: seg.text ?? "", final: !!seg.final, at: Date.now() });
        }
      });
      current.on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.track?.kind === Track.Kind.Audio) startAnalyser(pub.track as LocalAudioTrack, createAudioAnalyser);
      });
      current.on(RoomEvent.TrackMuted, (pub, p) => { if (isLocal(p) && pub.kind === Track.Kind.Audio) { setMuted(true); setLevel(0); } });
      current.on(RoomEvent.TrackUnmuted, (pub, p) => { if (isLocal(p) && pub.kind === Track.Kind.Audio) setMuted(false); });
      // No auto-reconnect: a dropped room turns the button off and the user taps again.
      current.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== current) return;
        roomRef.current = null;
        attemptRef.current += 1;
        current.removeAllListeners();
        removeAudioElements();
        resetLive();
        setPhase("idle");
        phaseRef.current = "idle";
      });

      await current.connect(grant.url, grant.token);
      if (superseded()) { current.removeAllListeners(); await current.disconnect(); return; }
      current.remoteParticipants.forEach((p) => readAgentState(p));
      await current.localParticipant.setMicrophoneEnabled(true);
      if (superseded()) { current.removeAllListeners(); await current.disconnect(); return; }
      // Browsers may hold playback until a gesture; the tap that started us counts.
      void current.startAudio().catch(() => {});
      roomRef.current = current;
      setRoomName(grant.room);
      setPhase("live");
      phaseRef.current = "live";
      if (greetRef.current) void current.localParticipant.sendText("Hi", { topic: "lk.chat" }).catch(() => {});
    } catch (err) {
      if (room) { room.removeAllListeners(); void room.disconnect().catch(() => {}); }
      removeAudioElements();
      if (superseded()) return;
      resetLive();
      if (err instanceof ApiError && err.status === 401) onLockedRef.current?.();
      setError(describeVoiceError(err));
      setPhase("error");
      phaseRef.current = "error";
    }
  }, [removeAudioElements, resetLive, startAnalyser, upsertLine]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "error") void start();
    else if (phaseRef.current !== "ending") stop();
  }, [start, stop]);

  const toggleMute = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = !room.localParticipant.isMicrophoneEnabled;
    void room.localParticipant.setMicrophoneEnabled(next).catch(() => {});
    setMuted(!next);
    if (!next) setLevel(0);
  }, []);

  const clearTranscript = useCallback(() => setTranscript([]), []);

  // Leave the room when the view unmounts or the page goes away.
  useEffect(() => {
    const onHide = () => stop();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      stop();
    };
  }, [stop]);

  return { phase, agentState, room: roomName, error, config, configError, route, transcript, level, muted, greet, setGreet, start, stop, toggle, toggleMute, refreshConfig, clearTranscript };
}
