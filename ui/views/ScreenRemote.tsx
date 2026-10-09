import { useEffect, useRef, useState } from "react";
import { token } from "../lib/api";
import { VolumeControl } from "../components/VolumeControl";

export function ScreenRemote() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const gesture = useRef<{ x: number; y: number; scroll: boolean } | null>(null);
  const [status, setStatus] = useState("Connecting to enuc…");
  const [live, setLive] = useState(false);
  const [scroll, setScroll] = useState(false);
  const [text, setText] = useState("");
  const [generation, setGeneration] = useState(0);
  const send = (value: unknown) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value)); };
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/kiosk/stream?${new URLSearchParams({ token: token() })}`);
      socket.current = ws;
      ws.onmessage = e => {
        const m = JSON.parse(String(e.data));
        if (m.t === "frame") {
          const image = new Image();
          image.onload = () => {
            const c = canvas.current;
            if (stopped || socket.current !== ws || !c) return;
            // CDP coordinates are CSS pixels, independent of the screen's pixel ratio.
            c.width = m.w; c.height = m.h;
            c.getContext("2d")?.drawImage(image, 0, 0, c.width, c.height);
            setLive(true); setStatus("Controlling enuc");
          };
          image.src = `data:image/jpeg;base64,${m.data}`;
        } else if (m.t === "error") { setStatus(m.message); setLive(false); }
      };
      ws.onclose = () => { if (!stopped) { setLive(false); setStatus("Disconnected · reconnecting…"); timer = setTimeout(connect, 2000); } };
      ws.onerror = () => { if (!stopped) setStatus("Cannot reach enuc's screen"); };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); socket.current?.close(); gesture.current = null; };
  }, [generation]);
  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current!, r = c.getBoundingClientRect();
    return { x: Math.max(0, Math.min(c.width - 1, (e.clientX - r.left) * c.width / r.width)), y: Math.max(0, Math.min(c.height - 1, (e.clientY - r.top) * c.height / r.height)) };
  };
  const key = (name: string, vk: number, value?: string) => {
    send({ t: "key", type: "keyDown", key: name, windowsVirtualKeyCode: vk, text: value });
    send({ t: "key", type: "keyUp", key: name, windowsVirtualKeyCode: vk });
  };
  const nav = (hash: string) => send({ t: "nav", url: `${location.origin}/${hash}` });
  const buttonClass = "rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40";
  return <div className="flex h-[100dvh] flex-col overflow-auto bg-zinc-950 p-3 text-zinc-100" data-testid="screen-remote">
    <header className="mb-3 flex flex-wrap items-center gap-2">
      <strong className="mr-2 text-cyan-300">Enuc remote</strong><span role="status" className="mr-auto text-xs text-zinc-400">{status}</span>
      <button className={buttonClass} disabled={!live} onClick={() => nav("#/fleet")}>Home</button>
      <button className={buttonClass} disabled={!live} onClick={() => nav("#/applications?app=afterglow")}>Afterglow</button>
      <button className={buttonClass} onClick={() => setGeneration(n => n + 1)}>Reconnect</button>
    </header>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-black">
      <canvas ref={canvas} width={1920} height={1200} tabIndex={0} aria-label="Enuc live screen" className="block max-h-full max-w-full outline-none" style={{ touchAction: "none" }}
        onPointerDown={e => { if (!live) return; e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); const p = point(e); gesture.current = { ...p, scroll }; if (!scroll) send({ t: "mouse", type: "mousePressed", ...p, button: e.button === 2 ? "right" : "left", clickCount: 1 }); }}
        onPointerMove={e => { const g = gesture.current, p = point(e); if (g?.scroll) { send({ t: "wheel", ...p, deltaX: g.x - p.x, deltaY: g.y - p.y }); gesture.current = { ...p, scroll: true }; } else send({ t: "mouse", type: "mouseMoved", ...p, button: g ? "left" : "none" }); }}
        onPointerUp={e => { if (gesture.current && !gesture.current.scroll) send({ t: "mouse", type: "mouseReleased", ...point(e), button: e.button === 2 ? "right" : "left", clickCount: 1 }); gesture.current = null; }}
        onPointerCancel={e => { if (gesture.current && !gesture.current.scroll) send({ t: "mouse", type: "mouseReleased", ...point(e), button: "left" }); gesture.current = null; }}
        onContextMenu={e => e.preventDefault()}
        onWheel={e => { send({ t: "wheel", ...point(e), deltaX: Math.max(-5000, Math.min(5000, e.deltaX)), deltaY: Math.max(-5000, Math.min(5000, e.deltaY)) }); }}
        onKeyDown={e => { e.preventDefault(); send({ t: "key", type: "keyDown", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0), text: e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined }); }}
        onKeyUp={e => { e.preventDefault(); send({ t: "key", type: "keyUp", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode }); }} />
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button className={buttonClass} aria-pressed={scroll} onClick={() => setScroll(s => !s)}>{scroll ? "Scroll mode" : "Tap / drag mode"}</button>
      {([['Back', 'back'], ['Reload', 'reload']] as const).map(([label, t]) => <button key={t} className={buttonClass} disabled={!live} onClick={() => send({ t })}>{label}</button>)}
      {([['Esc', 'Escape', 27], ['Tab', 'Tab', 9], ['←', 'ArrowLeft', 37], ['→', 'ArrowRight', 39], ['↑', 'ArrowUp', 38], ['↓', 'ArrowDown', 40], ['Space / play', ' ', 32], ['⌫', 'Backspace', 8], ['Enter', 'Enter', 13]] as const).map(([label, name, vk]) => <button key={name} className={buttonClass} disabled={!live} onClick={() => key(name, vk, name === ' ' ? ' ' : undefined)}>{label}</button>)}
    </div>
    <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); for (const ch of text.slice(0, 2000)) send({ t: "key", type: "char", text: ch }); setText(""); }}>
      <input aria-label="Type on enuc" placeholder="Tap a field on enuc, then type here…" value={text} onChange={e => setText(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2" />
      <button className={buttonClass} disabled={!live || !text}>Send text</button>
    </form>
    <div className="mt-3 flex items-center gap-2"><span className="w-14 shrink-0 text-xs uppercase tracking-widest text-zinc-500">Sound</span><VolumeControl className="min-w-0 flex-1" /></div>
    <p className="mt-2 text-xs text-zinc-500">Touch controls the screen on enuc. Sound plays on the media PC; the Sound row sets its volume.</p>
  </div>;
}
