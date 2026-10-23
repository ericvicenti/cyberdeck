import { useEffect, useRef, useState } from "react";
import { token } from "../lib/api";
import { updateParams, useRouteTitle } from "../lib/navigation";

// Matches the authenticated media endpoint. A link never carries a bearer token,
// blob URL, arbitrary fetch target or a command to capture new media.
export const caseworkMediaName = (name: string) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,179}$/.test(name);
export const caseworkMediaPath = (path: unknown): string | null => {
  if (typeof path !== "string" || !path.startsWith("/api/media/")) return null;
  const name = path.slice("/api/media/".length);
  return caseworkMediaName(name) ? name : null;
};

/** Retain received players across view/history changes. Only a selected link
 * fetches a file; opening it never records, uploads or starts playback. */
export function CaseworkMedia({ name, visible, title, received }: {
  name: string; visible: boolean; title: string; received: string | null;
}) {
  const visited = useRef(new Set<string>());
  if (visible && name) visited.current.add(name);
  return <section className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5" data-testid="casework-media">
    <h2 className="text-lg">Media arriving from the device</h2>
    {received && received !== name && <button className="mt-2 text-sm text-cyan-300" onClick={() => updateParams({ media: received })}>View {received}</button>}
    {!name && <p className="mt-2 text-sm text-zinc-500">Captured photos, audio and video appear here after upload.</p>}
    {[...visited.current].map(file => <Preview key={file} name={file} visible={visible && file === name} title={title} />)}
  </section>;
}

function Preview({ name, visible, title }: { name: string; visible: boolean; title: string }) {
  const [media, setMedia] = useState<{ url: string; bytes: number } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const valid = caseworkMediaName(name);
  const kind = /\.(jpe?g|png|webp|gif)$/i.test(name) ? "img" : /\.(mov|mp4|webm)$/i.test(name) ? "video" : /\.(m4a|wav|mp3|ogg)$/i.test(name) ? "audio" : null;
  useRouteTitle(visible ? `${!valid ? "Invalid media link" : error ? `${name} unavailable` : name} · ${title}` : undefined);
  useEffect(() => {
    if (!valid) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    setError(""); setMedia(null);
    void fetch(`/api/media/${encodeURIComponent(name)}`, { signal: abort.signal, headers: { authorization: `Bearer ${token()}` } })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 404 ? "Media not found" : response.status === 401 || response.status === 403 ? "Media access denied" : "Media unavailable");
        return response.blob();
      })
      .then(blob => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setMedia({ url: objectUrl, bytes: blob.size });
      }).catch(error => { if (!abort.signal.aborted) setError(String(error.message ?? error)); });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [name, retry, valid]);
  return <div ref={host} className={visible ? "mt-3 space-y-2" : "hidden"} inert={!visible} aria-hidden={!visible} data-casework-media={name}>
    <div className="flex items-center justify-between gap-3"><strong className="break-all text-sm">{name}</strong><button className="text-sm text-cyan-300" onClick={() => { host.current?.querySelectorAll<HTMLMediaElement>("audio,video").forEach(player => player.pause()); updateParams({ media: null }); }}>Close preview</button></div>
    {!valid ? <p role="alert">Invalid media link.</p> : error ? <p role="alert">{error}. <button className="underline" onClick={() => setRetry(n => n + 1)}>Retry preview</button></p> : !media ? <p role="status">Loading media…</p> : <>
      {kind === "img" && <img onError={() => setError("Image preview unavailable")} src={media.url} alt={name} className="max-h-80 w-full rounded-lg object-contain" />}
      {kind === "video" && <video onError={() => setError("Media playback unavailable")} src={media.url} controls className="max-h-80 w-full rounded-lg" />}
      {kind === "audio" && <audio onError={() => setError("Media playback unavailable")} src={media.url} controls className="w-full" />}
      <a href={media.url} download={name} className="block text-sm text-cyan-300">Download {media.bytes.toLocaleString()} bytes received from the device</a>
    </>}
  </div>;
}
