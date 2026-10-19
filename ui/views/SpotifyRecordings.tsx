import { useEffect, useRef, useState } from "react";
import {
  getMusicRecordingAudio,
  readMusicRecordings,
  refreshMusicRecordings,
  type MusicRecording,
} from "../lib/spotify-storage";
import { useRouteTitle } from "../lib/navigation";
import { PlayIcon, PauseIcon } from "../lib/icons";

const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** The audio owner outlives shelves/details; navigation never invokes play. */
export function useRecordingPlayback(account: string, onStart: (audio: HTMLAudioElement) => Promise<void>) {
  const [selected, setSelected] = useState<MusicRecording>();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const url = useRef("");
  const generation = useRef(0);
  useEffect(() => {
    const element = audio.current;
    setSelected(undefined); setPlaying(false); setPosition(0); setError(""); setBusy(false);
    return () => { generation.current++; element?.pause(); element?.removeAttribute("src"); element?.load(); URL.revokeObjectURL(url.current); url.current = ""; };
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
  return { selected, playing, position, error, busy, audio, play, setPosition, setError,
    resume: async () => { if (audio.current) { await onStart(audio.current); await audio.current.play(); } },
    element: (<audio
        ref={audio}
        data-testid="saved-recording-audio"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() =>
          setPosition((audio.current?.currentTime || 0) * 1000)
        }
        onError={() =>
          setError("This saved interval could not be decoded by this browser.")
        }
      />) };
}

/** Browsing metadata is read-only; playing/exporting audio requires a separate action. */
export function SpotifyRecordings({ account, playback, recordingId = "", visible = true, onSelect }: {
  account: string; playback: ReturnType<typeof useRecordingPlayback>; recordingId?: string;
  visible?: boolean; onSelect: (id: string) => void;
}) {
  const { selected, playing, position, error, busy, audio, play, setPosition, setError } = playback;
  const [recordings, setRecordings] = useState<MusicRecording[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let canceled = false;
    let revision = 0;
    const update = async () => {
      const version = ++revision;
      const current = () => !canceled && version === revision;
      try {
        const local = await readMusicRecordings(account);
        if (current()) setRecordings(local);
        if (navigator.onLine) {
          try {
            const all = await refreshMusicRecordings(account, { sync: false });
            if (current()) { setRecordings(all); setUnavailable(false); }
          } catch { if (current()) setUnavailable(true); }
        } else if (current()) setUnavailable(true);
      } catch { if (current()) setUnavailable(true); }
      finally { if (current()) setLoaded(true); }
    };
    setRecordings([]); setLoaded(false); setUnavailable(false); void update();
    window.addEventListener("cyberdeck-audio-saved", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { canceled = true; window.removeEventListener("cyberdeck-audio-saved", update); window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, [account]);
  const detail = recordings.find(record => record.id === recordingId);
  const heading = detail?.track.name || (!loaded ? "Loading recording…" : unavailable ? "Recording unavailable" : "Recording not found");
  useRouteTitle(visible && recordingId ? `${heading} · Saved audio · Spotify` : undefined);
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
      {recordingId && <section className="music-saved-player" aria-label="Recording details">
        <div>
          <h4>{heading}</h4>
          {detail ? <>
            <p className="music-muted">{detail.track.artists.map(artist => artist.name).join(", ")}</p>
            <p>Saved portion {time(detail.startMs)}–{time(detail.endMs)} · {time(detail.durationMs)} recorded</p>
            <p className="music-fine">{detail.local ? "Saved on this browser" : "Saved on the Cyberdeck node"}{!detail.finalized ? " · checkpoint" : ""}</p>
            {!detail.local && !navigator.onLine && <p role="status">Reconnect to the Cyberdeck node to play this recording.</p>}
            <button className="music-button" disabled={busy} onClick={() => void play(detail)}>Play this recording</button>
          </> : loaded && <p role="status">{unavailable ? "This recording is not available in this browser. Reconnect to its Cyberdeck node to check the saved copy." : "No recording with this ID is saved for this account."}</p>}
        </div>
        <button className="music-text" onClick={() => onSelect("")}>Close recording details</button>
      </section>}
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
                void playback.resume()
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
            <button className="music-text" aria-label={`Details for saved ${record.track.name} from ${time(record.startMs)}`} onClick={() => onSelect(record.id)}>Details</button>
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
