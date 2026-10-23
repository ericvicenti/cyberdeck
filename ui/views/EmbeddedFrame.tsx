import { useEffect, useRef, useState } from "react";
import { navigate } from "../lib/api";
import { claimRouteTitle, routeHash, writeRoute } from "../lib/navigation";

/** Only same-origin, root-relative SPA routes are carried by the generic bridge. */
export function embeddedRoute(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try { const url = new URL(value, "https://embedded.invalid"); return url.origin === "https://embedded.invalid" ? url.pathname + url.search + url.hash : null; } catch { return null; }
}

export function EmbeddedFrame({ app, params, visible }: {
  app: { id: string; name: string; url: string }; params: URLSearchParams; visible: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef(params); current.current = params;
  const connect = useRef<(force?: boolean) => void>(() => {});
  const [problem, setProblem] = useState("");
  const origin = new URL(app.url).origin;
  const hash = routeHash("applications", params);
  useEffect(() => {
    if (!visible) return;
    let release = claimRouteTitle(app.name);
    // getRandomValues also works on private HTTP origins, unlike randomUUID.
    const channel = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join("-");
    let request = 0, acknowledged = false, invalid = false, expectedHash = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => location.hash === expectedHash;
    const send = (force = false) => {
      const nextHash = routeHash("applications", current.current);
      if (location.hash !== nextHash || (!force && nextHash === expectedHash)) return;
      expectedHash = nextHash;
      const requested = current.current.get("route");
      const route = requested === null ? null : embeddedRoute(requested);
      invalid = requested !== null && route === null;
      acknowledged = false;
      clearTimeout(timer);
      setProblem(invalid ? "Invalid embedded application route" : "");
      release(); release = claimRouteTitle(invalid ? "Invalid application route" : app.name);
      if (invalid) return;
      frame.current?.contentWindow?.postMessage({ type: "cyberdeck:connect", version: 1, channel, request: ++request, route }, origin);
      timer = setTimeout(() => {
        if (active() && requested !== null && !acknowledged) {
          setProblem("This application has not connected its navigation bridge. The requested view could not be restored.");
          release(); release = claimRouteTitle(`View unavailable · ${app.name}`);
        }
      }, 5000);
    };
    connect.current = send;
    const receive = (event: MessageEvent) => {
      if (!active() || invalid || event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const data = event.data;
      if (data?.type === "embedded:ready" && data.version === 1) { send(true); return; }
      if (data?.version !== 1 || data.channel !== channel || data.request !== request) return;
      const nextRoute = embeddedRoute(data.route);
      if (!nextRoute) return;
      if (data.type === "embedded:ack") { if (acknowledged) return; acknowledged = true; }
      else if (!acknowledged || !["embedded:navigation", "embedded:title"].includes(data.type)) return;
      if (data.type === "embedded:title" && nextRoute !== current.current.get("route")) return;
      setProblem("");
      if (data.type !== "embedded:title") {
        const next = new URLSearchParams(current.current); next.set("route", nextRoute);
        current.current = next;
        // Our own URL write is already rendered by the child. Do not restore it
        // again or invalidate a user event queued just after this acknowledgement.
        expectedHash = routeHash("applications", next);
        writeRoute("applications", next, data.type === "embedded:navigation" && data.mode !== "replace" ? "push" : "replace");
      }
      const title = typeof data.title === "string" && data.title.length <= 512 && !/[\u0000-\u001f]/.test(data.title) ? data.title.trim() : "";
      release(); release = claimRouteTitle(title ? `${title} · ${app.name}` : app.name);
    };
    window.addEventListener("message", receive);
    send();
    return () => { clearTimeout(timer); window.removeEventListener("message", receive); connect.current = () => {}; release(); };
  }, [app.name, origin, visible]);
  useEffect(() => { if (visible) connect.current(); }, [hash, visible]);
  return <section className="flex h-full flex-col" aria-label={app.name}>
    <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
      <button data-tv-frame-back onClick={() => navigate("applications")} className="text-cyan-300">← Applications</button>
      <strong>{app.name}</strong><span className="flex-1" />
      <button onClick={() => { connect.current(true); frame.current?.contentWindow?.location.replace(app.url); }}>Reload</button>
    </div>
    {problem && <p role="alert" className="p-3 text-amber-300">{problem}</p>}
    <iframe ref={frame} data-tv-autofocus onLoad={event => {
      connect.current(true);
      const input = window as Window & { __cyberdeckInputBridge?: unknown; __cyberdeckTV?: { focusElement: (element: HTMLElement) => void } };
      if (visible && input.__cyberdeckInputBridge) input.__cyberdeckTV?.focusElement(event.currentTarget);
    }} title={app.name} src={app.url} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen className="min-h-0 w-full flex-1 border-0 bg-black" />
  </section>;
}
