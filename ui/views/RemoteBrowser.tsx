// Embedded remote browser: renders the daemon's CDP screencast on a canvas and
// forwards pointer, keyboard and wheel input. Node-aware through browserWsUrl.
import { useEffect, useRef, useState } from "react";
import { browserWsUrl } from "../lib/api";

type Props = { profile: string; url?: string; onState?: (s: { url: string; title: string }) => void; className?: string };
type Frame = { data: string; w: number; h: number };

const KEY_MODS = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
// CDP wants the Windows virtual key code for non-printable keys to be recognised by pages.
const VK: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Meta: 91 };

export function RemoteBrowser({ profile, url, onState, className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ w: 1280, h: 800 });
  const [status, setStatus] = useState<"connecting" | "live" | "closed" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState({ url: "", title: "" });
  const [bar, setBar] = useState("");
  const [focused, setFocused] = useState(false);
  const [frames, setFrames] = useState(0);

  const send = (o: unknown) => { const ws = wsRef.current; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

  // connect
  useEffect(() => {
    let alive = true;
    const ws = new WebSocket(browserWsUrl(profile));
    wsRef.current = ws;
    setStatus("connecting"); setError(null);
    ws.onopen = () => { if (url) send({ t: "nav", url }); fit(); };
    ws.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === "frame") { setStatus("live"); draw(m as Frame); }
      else if (m.t === "state") { setState({ url: m.url, title: m.title }); setBar((b) => (document.activeElement?.getAttribute("data-urlbar") ? b : m.url)); onState?.({ url: m.url, title: m.title }); }
      else if (m.t === "error") { setError(m.message); setStatus("error"); }
    };
    ws.onclose = () => { if (alive) setStatus((s) => (s === "error" ? s : "closed")); };
    ws.onerror = () => { if (alive) setStatus("error"); };
    return () => { alive = false; ws.close(); wsRef.current = null; };
  }, [profile]);

  // navigate when the url prop changes after connect
  useEffect(() => { if (url) send({ t: "nav", url }); }, [url]);

  const draw = (f: Frame) => {
    const c = canvasRef.current; if (!c) return;
    const img = new Image();
    img.onload = () => {
      if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height; }
      c.getContext("2d")?.drawImage(img, 0, 0);
      setFrames((n) => n + 1);
    };
    img.src = `data:image/jpeg;base64,${f.data}`;
  };

  // page viewport follows the container width (so text stays readable on narrow screens)
  const fit = () => {
    const el = wrapRef.current; if (!el) return;
    const w = Math.max(320, Math.min(1280, Math.floor(el.clientWidth)));
    const h = Math.max(240, Math.min(1400, Math.round(w * 0.65)));
    if (sizeRef.current.w !== w || sizeRef.current.h !== h) { sizeRef.current = { w, h }; send({ t: "resize", w, h }); }
  };
  useEffect(() => { const ro = new ResizeObserver(() => fit()); if (wrapRef.current) ro.observe(wrapRef.current); return () => ro.disconnect(); }, []);

  // pointer mapping: canvas CSS px → page px (canvas backing size == page viewport size)
  const pos = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!; const r = c.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * c.width), y: Math.round(((e.clientY - r.top) / r.height) * c.height) };
  };
  const btn = (b: number): "left" | "right" | "middle" => (b === 2 ? "right" : b === 1 ? "middle" : "left");
  const mouse = (type: "mousePressed" | "mouseReleased" | "mouseMoved") => (e: React.MouseEvent) => {
    if (type !== "mouseMoved") e.preventDefault();
    const { x, y } = pos(e);
    send({ t: "mouse", type, x, y, button: type === "mouseMoved" ? (e.buttons ? btn(e.button) : "none") : btn(e.button), clickCount: type === "mouseMoved" ? 0 : Math.min(3, Math.max(1, e.detail || 1)), modifiers: KEY_MODS(e) });
  };
  const onWheel = (e: React.WheelEvent) => { e.preventDefault(); const { x, y } = pos(e); send({ t: "wheel", x, y, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) }); };
  const onKey = (type: "keyDown" | "keyUp") => (e: React.KeyboardEvent) => {
    if (e.key === "Tab" || e.key === " " || e.key.startsWith("Arrow") || e.key === "Backspace") e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const vk = VK[e.key] ?? (printable ? e.key.toUpperCase().charCodeAt(0) : undefined);
    send({ t: "key", type, key: e.key, code: e.code, text: type === "keyDown" && printable ? e.key : undefined, modifiers: KEY_MODS(e), windowsVirtualKeyCode: vk });
    if (type === "keyDown" && printable) send({ t: "key", type: "char", key: e.key, code: e.code, text: e.key, modifiers: KEY_MODS(e), windowsVirtualKeyCode: vk });
    if (type === "keyDown" && e.key === "Enter") send({ t: "key", type: "char", key: "Enter", code: "Enter", text: "\r", modifiers: KEY_MODS(e), windowsVirtualKeyCode: 13 });
  };
  const onPaste = (e: React.ClipboardEvent) => { e.preventDefault(); const text = e.clipboardData.getData("text"); for (const ch of text.slice(0, 4000)) send({ t: "key", type: "char", key: ch, text: ch }); };

  const led = status === "live" ? "led led-on" : status === "connecting" ? "led led-run" : "led led-err";
  return (
    <div className={`flex flex-col ${className}`}>
      <form className="flex items-center gap-1 pb-2" onSubmit={(e) => { e.preventDefault(); if (bar.trim()) send({ t: "nav", url: bar.trim() }); canvasRef.current?.focus(); }}>
        <button type="button" onClick={() => send({ t: "back" })} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800" title="back">←</button>
        <button type="button" onClick={() => send({ t: "forward" })} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800" title="forward">→</button>
        <button type="button" onClick={() => send({ t: "reload" })} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800" title="reload">↻</button>
        <input value={bar} data-urlbar="1" onChange={(e) => setBar(e.target.value)} onFocus={(e) => e.target.select()} placeholder="https://" className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-100 outline-none focus:border-cyan-500/60" />
        <span className={led} title={status} />
        <span className="hidden text-[10px] text-zinc-500 sm:inline">{status === "live" ? `${profile} · ${frames} frames` : status}</span>
      </form>
      <div ref={wrapRef} className="relative w-full overflow-hidden rounded border border-zinc-800 bg-black" style={{ boxShadow: focused ? "0 0 0 1px rgba(34,211,238,.6), 0 0 12px rgba(34,211,238,.25)" : undefined }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          width={1280}
          height={832}
          className="block w-full cursor-default outline-none"
          onMouseDown={(e) => { canvasRef.current?.focus(); mouse("mousePressed")(e); }}
          onMouseUp={mouse("mouseReleased")}
          onMouseMove={mouse("mouseMoved")}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={onWheel}
          onKeyDown={onKey("keyDown")}
          onKeyUp={onKey("keyUp")}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {status !== "live" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-4 text-center font-mono text-[12px] text-zinc-400">
            {status === "connecting" ? <span>starting browser profile <span className="text-cyan-300">{profile}</span>…<span className="hud-cursor" /></span> : status === "error" ? <span className="text-red-300">{error ?? "browser error"}</span> : "disconnected"}
          </div>
        )}
        {status === "live" && !focused && (
          <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/70 px-2 py-0.5 text-[10px] uppercase tracking-widest text-cyan-300/80">click to type</div>
        )}
      </div>
      <div className="truncate pt-1 text-[10px] text-zinc-600">{state.title || state.url}</div>
    </div>
  );
}
