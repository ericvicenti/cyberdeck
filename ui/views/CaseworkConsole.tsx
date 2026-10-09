// The browser half of a Casework example app (the kitchen sink): send the app to a paired device,
// drive it, and watch what the device really did. A port of Casework's proof dashboard and call
// console (remote-control/server/public/demo.js, console.js) onto this node's Casework server
// (src/daemon/api/casework.ts): REST for commands, the `/control` socket as a console peer for
// events and WebRTC call signalling.
import { useEffect, useRef, useState } from "react";
import { api, post, token, ApiError } from "../lib/api";

export type CaseworkApp = { id: string; name: string; description: string; title?: string };
type Device = { id: string; info?: { name?: string; model?: string; os?: string }; scene?: string };
type DeviceEvent = { deviceId?: string; at: number; name?: string; data?: any; result?: any; error?: string; ok?: boolean; path?: string };
type Pairing = { url: string; key: string; qr: string };
type Media = { url: string; kind: "img" | "video" | "audio" | null; name: string; bytes: number };
type Signal = { type: "offer" | "answer" | "ice" | "hangup"; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; video?: boolean };

export const KITCHEN_TABS = ["Agent", "Overview", "Camera + QR", "Audio + calls", "Video", "Graphics", "Device", "Files + OS", "Web + forms"];
/** True inside the Casework Desk app's WebView (the Deck tab of casework/cyberdeck.tsx). */
export const inCasework = (): boolean => typeof (window as any).ReactNativeWebView?.postMessage === "function";
/** Ask the app around this page to open a native scene. */
export const openNative = (name: string) => (window as any).ReactNativeWebView.postMessage(JSON.stringify({ cyberdeck: "scene", name }));

const deviceName = (d: Device) => d.info?.name || d.info?.model || d.id.slice(0, 8);
const isSimulator = (d: Device) => /simulator/i.test(d.info?.model ?? "");
const btn = "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 hover:border-cyan-500 disabled:opacity-40";
const panel = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-5";

export function CaseworkConsole({ app, onLocked }: { app: CaseworkApp; onLocked: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState("");
  const [online, setOnline] = useState(false);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [motion, setMotion] = useState("");
  const [scanned, setScanned] = useState("");
  const [identity, setIdentity] = useState("");
  const [media, setMedia] = useState<Media | null>(null);
  const [qr, setQr] = useState<{ text: string; qr: string } | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [incoming, setIncoming] = useState<{ from: string; video: boolean } | null>(null);
  const [callStatus, setCallStatus] = useState("");
  const [callVideo, setCallVideo] = useState(false);

  const socket = useRef<WebSocket | null>(null);
  const selectedRef = useRef("");
  const call = useRef<{ pc: RTCPeerConnection; stream: MediaStream; target: string; pending: RTCIceCandidateInit[] } | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  selectedRef.current = selected;

  const fail = (e: unknown) => { if (e instanceof ApiError && e.status === 401) onLocked(); setError(e instanceof Error ? e.message : String(e)); };
  const act = (fn: () => Promise<unknown>, done = "") => { setError(""); setNote(""); fn().then(() => setNote(done)).catch(fail); };
  const show = (list: Device[]) => {
    // Prefer real hardware when a simulator is connected too.
    const sorted = [...list].sort((a, b) => Number(isSimulator(a)) - Number(isSimulator(b)));
    setDevices(sorted);
    setSelected((keep) => (sorted.some((d) => d.id === keep) ? keep : sorted[0]?.id ?? ""));
  };
  const command = async (name: string, args: Record<string, unknown> = {}) => {
    if (!selectedRef.current) throw new Error("Connect a device first");
    return post<{ id: string; sent: number }>("/api/command", { deviceId: selectedRef.current, action: { name, args } });
  };
  const send = (scene: string, deviceId?: string) => post<{ sent: number }>(`/api/preset/${scene}`, deviceId ? { deviceId } : {}).then((r) => { if (!r.sent) throw new Error("No device is connected"); });

  const signal = (message: Signal) => { const c = call.current; if (c && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "signal", to: c.target, signal: message })); };
  const endCall = (notify = true) => {
    const c = call.current;
    if (!c) return;
    if (notify) signal({ type: "hangup" });
    call.current = null;
    c.pc.close();
    c.stream.getTracks().forEach((t) => t.stop());
    if (localVideo.current) localVideo.current.srcObject = null;
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    setCallStatus("call ended");
  };
  // The browser places the call: the device answers the offer (also when the device asked for it).
  const startCall = async (video: boolean, deviceId = selectedRef.current) => {
    if (!deviceId) throw new Error("Connect a device first");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This page has no microphone access: open Cyberdeck over https or on localhost");
    endCall();
    setCallVideo(video); setCallStatus("requesting media…"); setIncoming(null);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video });
    const pc = new RTCPeerConnection({ iceServers: [] });
    call.current = { pc, stream, target: deviceId, pending: [] };
    if (localVideo.current) localVideo.current.srcObject = stream;
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    const early: RTCIceCandidate[] = [];
    let offered = false;
    pc.onicecandidate = ({ candidate }) => { if (!candidate) return; if (offered) signal({ type: "ice", candidate }); else early.push(candidate); };
    pc.ontrack = ({ streams }) => { if (remoteVideo.current) { remoteVideo.current.srcObject = streams[0]; remoteVideo.current.play().catch(() => setNote("Press play to hear the call")); } };
    pc.onconnectionstatechange = () => { if (call.current?.pc !== pc) return; setCallStatus(pc.connectionState); if (pc.connectionState === "failed") { endCall(); setError("Call failed. Check that both ends are on the same network."); } };
    await pc.setLocalDescription(await pc.createOffer());
    signal({ type: "offer", description: pc.localDescription!, video });
    offered = true;
    early.forEach((candidate) => signal({ type: "ice", candidate }));
    setCallStatus("connecting to the device…");
  };
  const receiveSignal = async (from: string, message: Signal) => {
    const c = call.current;
    if (!c || from !== c.target) return;
    if (message.type === "answer" && message.description) { await c.pc.setRemoteDescription(message.description); for (const candidate of c.pending.splice(0)) await c.pc.addIceCandidate(candidate); }
    if (message.type === "ice" && message.candidate) { if (c.pc.remoteDescription) await c.pc.addIceCandidate(message.candidate); else c.pending.push(message.candidate); }
    if (message.type === "hangup") endCall(false);
  };

  const onEvent = (e: DeviceEvent) => {
    if (e.deviceId && e.deviceId !== selectedRef.current) return;
    if (e.name === "sensor.motion") { setMotion(JSON.stringify({ at: new Date(e.at).toLocaleTimeString(), ...e.data }, null, 2)); return; }
    if (e.name === "camera.barcode") setScanned(String(e.data?.data ?? ""));
    if (e.name === "device.info") setIdentity(JSON.stringify(e.data, null, 2));
    setEvents((prev) => [e, ...prev].slice(0, 45));
    // An upload is reported twice (the device's own event and the server's receipt); show it once.
    const path: string | undefined = e.name === "files.upload" ? e.data?.path : undefined;
    if (path) void fetch(path, { headers: { authorization: `Bearer ${token()}` } }).then((r) => { if (!r.ok) throw new Error(`upload ${r.status}`); return r.blob(); }).then((blob) => {
      const kind = /\.(jpe?g|png)$/i.test(path) ? "img" : /\.(mov|mp4)$/i.test(path) ? "video" : /\.(m4a|wav)$/i.test(path) ? "audio" : null;
      setMedia((prev) => { if (prev) URL.revokeObjectURL(prev.url); return { url: URL.createObjectURL(blob), kind, name: path.split("/").pop() ?? "upload", bytes: blob.size }; });
    }).catch(fail);
  };

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = (key: string) => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/control`);
      socket.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "console", token: key }));
      ws.onmessage = ({ data }) => {
        let m: any;
        try { m = JSON.parse(data); } catch { return; }
        if (m.type === "welcome") setOnline(true);
        if (m.type === "welcome" || m.type === "devices") show(m.devices ?? []);
        if (m.type === "event") onEvent(m.event);
        if (m.type === "signal") void receiveSignal(m.from, m.signal).catch(fail);
        if (m.type === "call.request") setIncoming({ from: m.from, video: Boolean(m.video) });
        if (m.type === "peer.left" && m.id === call.current?.target) endCall(false);
        if (m.type === "error") setError(String(m.error));
      };
      ws.onclose = () => { setOnline(false); endCall(false); if (alive) timer = setTimeout(() => connect(key), 1500); };
    };
    api<Pairing>(`/api/casework/pairing?url=${encodeURIComponent(location.origin)}`, { local: true }).then((p) => { if (!alive) return; setPairing(p); connect(p.key); }).catch(fail);
    api<{ text: string; qr: string }>("/api/casework/demo-qr", { local: true }).then((q) => { if (alive) setQr(q); }).catch(() => {});
    return () => { alive = false; clearTimeout(timer); endCall(); socket.current?.close(); setMedia((prev) => { if (prev) URL.revokeObjectURL(prev.url); return null; }); };
  }, []);
  // Another device's results are not this device's: start clean when the selection changes.
  useEffect(() => { setEvents([]); setMotion(""); setScanned(""); setIdentity(""); }, [selected]);

  const device = devices.find((d) => d.id === selected);
  const onApp = device?.scene === app.id;
  const here = inCasework();
  const inCall = Boolean(callStatus) && callStatus !== "call ended";

  return <div className="h-full overflow-auto p-6" data-testid="casework-console">
    <div className="flex flex-wrap items-center gap-3">
      <span className={`led ${online ? "led-on" : "led-off"}`} /><span className="hud-label">{online ? "console online" : "connecting"}</span>
      <span className="flex-1" />
      {devices.length > 0 && <select aria-label="Device" value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">{devices.map((d) => <option key={d.id} value={d.id}>{deviceName(d)}{d.scene ? ` · ${d.scene}` : ""}</option>)}</select>}
    </div>
    <h1 className="mt-4 text-3xl font-semibold tracking-tight">{app.name}</h1>
    <p className="mt-2 max-w-3xl text-sm text-zinc-400">{app.description} It runs natively in the Casework Desk app, served from this node; this page sends it to a paired device, drives it, and shows what the device really did.</p>

    {here && <div className={`${panel} mt-5 border-lime-800`}><p className="text-sm text-zinc-300">You are in the Casework Desk app: {app.name} runs right here.</p><button data-testid="casework-open-native" className={`${btn} mt-3 border-lime-600 text-lime-300`} onClick={() => openNative(app.id)}>Open {app.name} on this device →</button></div>}

    {!devices.length ? <div className={`${panel} mt-5 flex flex-wrap gap-6`} data-testid="casework-pair">
      {pairing && <div className="w-56 shrink-0 rounded-lg bg-[#e8fbff] p-2 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: pairing.qr }} />}
      <div className="min-w-64 flex-1 text-sm text-zinc-300"><h2 className="text-lg text-zinc-100">No device is connected</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-zinc-400"><li>Keep Tailscale connected on the iPad or phone.</li><li>Open Casework Desk → <b>Server settings</b> → <b>Scan pairing QR</b> and point it at this code.</li><li>Choose <b>Use this server</b>. The device shows the whole deck; {app.name} is under <b>Apps</b>, or send it from here.</li></ol>
        {pairing && <p className="mt-3 font-mono text-xs text-zinc-500">{pairing.url}</p>}
      </div>
    </div> : <>
      <div className="mt-5 flex flex-wrap gap-2">
        <button data-testid="casework-send" className={`${btn} border-lime-700 text-lime-300`} onClick={() => act(() => send(app.id, selected), `${app.name} sent to ${device ? deviceName(device) : "the device"}`)}>{onApp ? `${app.name} is open on the device` : `Send ${app.name} to the device ↗`}</button>
        {devices.length > 1 && <button className={btn} onClick={() => act(() => send(app.id), `${app.name} sent to ${devices.length} devices`)}>Send to all {devices.length}</button>}
        <button className={btn} onClick={() => act(() => send("cyberdeck", selected), "Back on Cyberdeck")}>Back to Cyberdeck</button>
        <button className={btn} onClick={() => act(() => command("device.info"))}>Read device info</button>
        <button className={btn} onClick={() => act(() => command("speech.say", { text: "Hello from Cyberdeck. This is your real iPad speaking." }))}>Make it speak</button>
        <button className={btn} onClick={() => act(async () => { for (const name of ["sensors.stop", "audio.stop", "speech.stop", "call.stop"]) await command(name); })}>Stop motion + audio + calls</button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">{KITCHEN_TABS.map((name) => <button key={name} className={`${btn} text-xs`} onClick={() => act(() => command("demo.tab", { name }))}>{name}</button>)}</div>
    </>}
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    {note && <p role="status" className="mt-3 text-sm text-lime-300">{note}</p>}

    {incoming && <div className={`${panel} mt-4 border-lime-600`} role="dialog" aria-label="Incoming call"><strong>{deviceName(devices.find((d) => d.id === incoming.from) ?? { id: incoming.from })} is calling ({incoming.video ? "video" : "audio"})</strong>
      <div className="mt-3 flex gap-2"><button className={`${btn} border-lime-600 text-lime-300`} onClick={() => act(() => startCall(incoming.video, incoming.from))}>Accept</button><button className={btn} onClick={() => setIncoming(null)}>Ignore</button></div></div>}

    {devices.length > 0 && <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <section className={panel}><h2 className="text-lg">Scan this on the device</h2><p className="mt-1 text-sm text-zinc-400">Camera + QR tab: point the camera here. The decoded text comes back below.</p>
        {qr && <div className="my-4 w-56 rounded-lg bg-white p-2 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qr.qr }} />}
        <p data-testid="casework-scanned" className={scanned ? "text-lime-300" : "text-zinc-500"}>{scanned ? `✓ ${scanned}` : "Waiting for a real camera scan."}</p>
        <h2 className="mt-5 text-lg">Device identity</h2><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-xs text-zinc-400">{identity || "Read device info to see the hardware, OS and battery."}</pre>
      </section>
      <section className={panel}><h2 className="text-lg">Calls</h2><p className="mt-1 text-sm text-zinc-400">Call the device, or accept the call it places from Audio + calls. Audio and video go peer to peer over the local network.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2"><button className={btn} disabled={inCall} onClick={() => act(() => startCall(false))}>Audio call</button><button className={btn} disabled={inCall} onClick={() => act(() => startCall(true))}>Video call</button><button className={btn} disabled={!inCall} onClick={() => endCall()}>Hang up</button><span className="hud-label">{callStatus}</span></div>
        <div className="mt-3 flex gap-3"><video ref={remoteVideo} autoPlay playsInline className={`min-w-0 flex-1 rounded-lg bg-black ${inCall ? "" : "hidden"}`} /><video ref={localVideo} autoPlay playsInline muted className={`w-32 rounded-lg bg-black ${inCall && callVideo ? "" : "hidden"}`} /></div>
        <h2 className="mt-5 text-lg">Native video player</h2><div className="mt-2 flex flex-wrap gap-2">{([["Play", "video.play", {}], ["Pause", "video.pause", {}], ["Seek to 3 s", "video.seek", { seconds: 3 }], ["Status", "video.status", {}]] as const).map(([label, name, args]) => <button key={name} className={btn} onClick={() => act(() => command(name, args))}>{label}</button>)}</div>
        <p className="mt-2 text-xs text-zinc-500">These reach the player on the Video tab while it is on screen.</p>
      </section>
      <section className={panel}><h2 className="text-lg">Live motion</h2><p className="mt-1 text-sm text-zinc-400">Device tab → Stream motion, then tilt it.</p><pre className="mt-2 min-h-24 whitespace-pre-wrap font-mono text-xs text-zinc-400">{motion || "Waiting for sensor data."}</pre></section>
      <section className={panel}><h2 className="text-lg">Media arriving from the device</h2>
        {media ? <div className="mt-3 space-y-2">{media.kind === "img" && <img src={media.url} alt="Upload from the device" className="max-h-80 w-full rounded-lg object-contain" />}{media.kind === "video" && <video src={media.url} controls className="max-h-80 w-full rounded-lg" />}{media.kind === "audio" && <audio src={media.url} controls className="w-full" />}<a href={media.url} download={media.name} className="block text-sm text-cyan-300">Download {media.bytes.toLocaleString()} bytes received from the device</a></div> : <p className="mt-2 text-sm text-zinc-500">Captured photos, audio and video appear here after upload.</p>}
      </section>
      <section className={`${panel} lg:col-span-2`}><h2 className="text-lg">Actual results</h2>
        <div className="mt-2 max-h-96 overflow-auto" data-testid="casework-events">{events.length ? events.map((e, i) => <div key={`${e.at}-${i}`} className="border-b border-zinc-800 py-2"><strong className={e.ok === false || e.name === "error" ? "text-red-300" : "text-lime-300"}>{e.name || (e.ok === false ? "command failed" : "command completed")}</strong><small className="text-zinc-500"> · {new Date(e.at).toLocaleTimeString()}</small><pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-xs text-zinc-400">{JSON.stringify(e.data ?? e.result ?? e.error ?? (e.path ? { path: e.path } : null), null, 2)}</pre></div>) : <p className="text-sm text-zinc-500">Waiting for device events.</p>}</div>
      </section>
    </div>}
  </div>;
}
