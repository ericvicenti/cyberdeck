import {
  saveMusicRecording,
  syncMusicRecording,
  type MusicRecording,
} from "./spotify-storage";
import type { SpotifyTrack } from "./spotify";

// Runs inside the SDK's local playback frame, before its player code. Uses the
// media element's ordinary Web Audio output; neither keys nor licenses are read.
type CaptureState = {
  account: string;
  track: SpotifyTrack;
  paused: boolean;
  position: number;
};
let current: CaptureState | undefined;
const elements = new Set<HTMLMediaElement>();
const sources = new Map<HTMLMediaElement, MediaElementAudioSourceNode>();
let active:
  | {
      recorder: MediaRecorder;
      element: HTMLMediaElement;
      record: MusicRecording;
      started: number;
      pausedAt?: number;
      pausedMs: number;
      chunks: Blob[];
      analyser: AnalyserNode;
      peak: number;
    }
  | undefined;
let writes = Promise.resolve();
let backups = Promise.resolve();
let stopped = false;
const notify = (message: string, saved = false) =>
  parent.postMessage({ cyberdeckAudio: true, message, saved }, location.origin);

function finish() {
  const take = active;
  if (!take) return;
  active = undefined;
  take.record.endMs = Math.max(
    take.record.startMs,
    take.element.currentTime * 1000,
  );
  if (take.recorder.state !== "inactive") take.recorder.stop();
}

function record(element: HTMLMediaElement) {
  if (
    stopped ||
    !current?.account ||
    current.paused ||
    element.paused ||
    !element.mediaKeys
  )
    return;
  if (
    active?.element === element &&
    active.record.track.uri === current.track.uri
  ) {
    if (active.recorder.state === "paused") {
      active.pausedMs +=
        performance.now() - (active.pausedAt || performance.now());
      active.pausedAt = undefined;
      active.recorder.resume();
    }
    return;
  }
  finish();
  try {
    let source = sources.get(element);
    if (!source) {
      const context = new AudioContext();
      source = context.createMediaElementSource(element);
      source.connect(context.destination);
    }
    void (source.context as AudioContext)
      .resume()
      .catch((e) => notify(`Audio cache unavailable: ${e.message}`));
    const destination = (
      source.context as AudioContext
    ).createMediaStreamDestination();
    const analyser = source.context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(destination);
    source.connect(analyser);
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    if (!mime) throw new Error("This browser cannot encode saved audio.");
    const recorder = new MediaRecorder(destination.stream, {
      mimeType: mime,
      audioBitsPerSecond: 192000,
    });
    const take = {
      recorder,
      element,
      analyser,
      chunks: [] as Blob[],
      peak: 0,
      started: performance.now(),
      pausedMs: 0,
      pausedAt: undefined as number | undefined,
      record: {
        id: crypto.randomUUID(),
        account: current.account,
        at: Date.now(),
        track: current.track,
        startMs: element.currentTime * 1000,
        endMs: element.currentTime * 1000,
        durationMs: 0,
        bytes: 0,
        mime,
        finalized: false,
        local: true,
      } satisfies MusicRecording,
    };
    active = take;
    const checkpoint = (finalized: boolean) => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      for (const sample of samples)
        take.peak = Math.max(take.peak, Math.abs(sample));
      const durationMs =
        (take.pausedAt || performance.now()) - take.started - take.pausedMs;
      if (!take.chunks.length || durationMs < 250) return;
      if (take.peak < 0.000001) {
        if (finalized)
          notify(
            "Audio cache received only silence; this interval was not marked available offline.",
          );
        return;
      }
      const audio = new Blob(take.chunks, { type: recorder.mimeType });
      const metadata: MusicRecording = {
        ...take.record,
        endMs: take.record.startMs + durationMs,
        durationMs,
        bytes: audio.size,
        mime: audio.type,
        finalized,
      };
      writes = writes
        .then(async () => {
          await saveMusicRecording(metadata, audio);
          notify(
            finalized
              ? `Saved ${metadata.track.name} for offline playback`
              : `Caching ${metadata.track.name}`,
            true,
          );
          if (finalized)
            backups = backups
              .then(() => syncMusicRecording(metadata, audio))
              .catch(() =>
                notify(
                  "Audio is saved in this browser; node backup is pending. Open the journal to retry.",
                ),
              );
        })
        .catch((e) => {
          stopped = true;
          notify(
            `Audio cache save failed: ${e.message}. Free storage and reconnect the player to retry.`,
          );
          finish();
        });
    };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) take.chunks.push(event.data);
      if (recorder.state !== "inactive") checkpoint(false);
      // Bound in-memory buffers, keeping long tracks as consecutive recordings.
      if (
        active === take &&
        performance.now() - take.started - take.pausedMs >= 600000
      ) {
        finish();
        record(element);
      }
    });
    recorder.addEventListener("stop", () => {
      checkpoint(true);
      source!.disconnect(destination);
      source!.disconnect(analyser);
      destination.stream.getTracks().forEach((track) => track.stop());
    });
    recorder.addEventListener("error", () => {
      notify(
        "Audio recording failed; previously saved intervals remain available.",
      );
      finish();
    });
    recorder.start(2000);
    notify(`Caching ${current.track.name}`);
  } catch (e) {
    notify(`Audio cache unavailable: ${(e as Error).message}`);
  }
}

const createSource = AudioContext.prototype.createMediaElementSource;
AudioContext.prototype.createMediaElementSource = function (element) {
  const existing = sources.get(element);
  if (existing) return existing;
  const source = createSource.call(this, element);
  sources.set(element, source);
  return source;
};
const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  if (!elements.has(this)) {
    elements.add(this);
    this.addEventListener("playing", () => record(this));
    this.addEventListener("pause", () => {
      if (active?.element === this && active.recorder.state === "recording") {
        finish();
      }
    });
    for (const event of ["seeking", "emptied", "ended"])
      this.addEventListener(event, () => {
        if (active?.element === this) finish();
        if (event === "emptied") current = undefined;
      });
    this.addEventListener("seeked", () => record(this));
  }
  return play.call(this);
};
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.cyberdeckCaptureState) {
    const next = event.data.cyberdeckCaptureState as CaptureState;
    if (!next.account || !next.track?.uri) return;
    if (
      current?.track.uri !== next.track.uri ||
      current.account !== next.account
    )
      finish();
    current = next;
    const element = [...elements].find((el) => !el.paused && !!el.mediaKeys);
    if (element) record(element);
  }
  if (event.data?.cyberdeckCaptureStop) {
    stopped = true;
    const recorder = active?.recorder;
    if (recorder)
      recorder.addEventListener(
        "stop",
        () =>
          void writes
            .then(() => backups)
            .then(() =>
              parent.postMessage(
                { cyberdeckCaptureStopped: true },
                location.origin,
              ),
            ),
        { once: true },
      );
    finish();
    if (!recorder)
      void writes
        .then(() => backups)
        .then(() =>
          parent.postMessage(
            { cyberdeckCaptureStopped: true },
            location.origin,
          ),
        );
  }
});
window.addEventListener("pagehide", finish);
const script = document.createElement("script");
script.src = "https://sdk.scdn.co/embedded/index.js";
script.onerror = () =>
  notify("Spotify's embedded playback code could not load.");
document.head.appendChild(script);
