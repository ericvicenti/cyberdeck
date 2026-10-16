import { useEffect, useRef, useState } from "react";
import {
  getMusicRecordingAudio,
  readMusicRecordings,
  refreshMusicRecordings,
  type MusicRecording,
} from "../lib/spotify-storage";
import { PlayIcon, PauseIcon } from "../lib/icons";

const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** Offline audio recorded by the SDK tap, playable without a Spotify session or network. */
export function SpotifyRecordings({
  account,
  onStart,
}: {
  account: string;
  onStart: (audio: HTMLAudioElement) => Promise<void>;
}) {
  const [recordings, setRecordings] = useState<MusicRecording[]>([]);
  const [selected, setSelected] = useState<MusicRecording>();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const url = useRef("");
  const generation = useRef(0);
  useEffect(() => {
    let canceled = false;
    const update = () =>
      void readMusicRecordings(account)
        .then((items) => {
          if (!canceled) setRecordings(items);
        })
        .catch((e) => {
          if (!canceled) setError(e.message);
        });
    update();
    if (navigator.onLine)
      void refreshMusicRecordings(account)
        .then((items) => {
          if (!canceled) setRecordings(items);
        })
        .catch(() => {});
    window.addEventListener("cyberdeck-audio-saved", update);
    return () => {
      canceled = true;
      generation.current++;
      window.removeEventListener("cyberdeck-audio-saved", update);
      audio.current?.pause();
      URL.revokeObjectURL(url.current);
    };
  }, [account]);
  const play = async (record: MusicRecording) => {
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const blob = await getMusicRecordingAudio(record);
      if (version !== generation.current || !audio.current) return;
      await onStart(audio.current);
      if (version !== generation.current || !audio.current) return;
      URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob);
      audio.current.src = url.current;
      setSelected(record);
      setPosition(0);
      await audio.current.play();
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  return (
    <section className="music-recordings" aria-label="Saved audio">
      <div className="music-section-heading">
        <h3>Saved audio</h3>
        <span className="music-eyebrow">PLAYABLE OFFLINE</span>
      </div>
      <p className="music-fine">
        Audio captured as you listen in this browser. Each recording shows the
        portion saved; playback on other devices is not captured here.
      </p>
      {error && <p role="alert">{error}</p>}
      <audio
        ref={audio}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() =>
          setPosition((audio.current?.currentTime || 0) * 1000)
        }
        onError={() =>
          setError("This saved interval could not be decoded by this browser.")
        }
      />
      {selected && (
        <div className="music-saved-player">
          <div>
            <strong>{selected.track.name}</strong>
            <div className="music-muted">
              Saved recording · starts at {time(selected.startMs)}
            </div>
          </div>
          <button
            className="music-play"
            aria-label={playing ? "Pause saved audio" : "Resume saved audio"}
            onClick={() => {
              if (playing) audio.current?.pause();
              else if (audio.current)
                void onStart(audio.current)
                  .then(() => audio.current?.play())
                  .catch((e) => setError(e.message));
            }}
          >
            {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <span>{time(position)}</span>
          <input
            aria-label="Saved audio position"
            type="range"
            min={0}
            max={selected.durationMs}
            value={position}
            onChange={(e) => {
              if (audio.current)
                audio.current.currentTime = Number(e.target.value) / 1000;
              setPosition(Number(e.target.value));
            }}
          />
          <span>{time(selected.durationMs)}</span>
        </div>
      )}
      {!recordings.length && (
        <p className="music-muted">
          No recorded audio yet. Play a song in this browser to start saving it.
        </p>
      )}
      <div className="music-recording-list">
        {recordings.map((record) => (
          <div className="music-recording" key={record.id}>
            <button
              className="music-button"
              disabled={busy}
              aria-label={`Play saved ${record.track.name} from ${time(record.startMs)}`}
              onClick={() => void play(record)}
            >
              <PlayIcon size={15} />
              <span>{record.track.name}</span>
            </button>
            <span className="music-muted">
              {time(record.startMs)}–{time(record.endMs)} ·{" "}
              {record.local ? "On this browser" : "On Cyberdeck node"}
              {!record.finalized ? " · checkpoint" : ""}
            </span>
            <button
              className="music-text"
              disabled={busy}
              onClick={() =>
                void getMusicRecordingAudio(record)
                  .then((blob) => {
                    const objectUrl = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = objectUrl;
                    a.download = `${record.track.name.replace(/[\\/:*?"<>|]/g, "_")}-${Math.floor(record.startMs / 1000)}.${record.mime.includes("mp4") ? "m4a" : "webm"}`;
                    a.click();
                    URL.revokeObjectURL(objectUrl);
                  })
                  .catch((e) => setError(e.message))
              }
            >
              Export audio
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
