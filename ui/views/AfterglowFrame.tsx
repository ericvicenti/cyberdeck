import { claimRouteTitle, routeHash, readRoute } from "../lib/navigation";
import { useEffect, useRef, useState } from "react";

function cleanRoute(value: unknown): string | null {
  return typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f]/.test(value)
    ? value.replace(/^#\/?/, "") || "discover" : null;
}
export function AfterglowFrame({ url, params, name }: { url: string; params: URLSearchParams; name: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef(params);
  current.current = params;
  const route = cleanRoute(params.get("route")) || "discover";
  const origin = new URL(url).origin;
  // Updating the outer route must not reload the iframe or destroy playback.
  const [src] = useState(() => {
    const target = new URL(url);
    target.searchParams.set("cyberdeck", location.origin);
    target.hash = route;
    return target.href;
  });
  const sendRoute = () => frame.current?.contentWindow?.postMessage({ type: "cyberdeck:navigate", route: cleanRoute(current.current.get("route")) || "discover" }, origin);
  useEffect(() => {
    let releaseTitle = claimRouteTitle(name);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const data = event.data, incoming = cleanRoute(data?.route);
      if (!incoming) return;
      if (data.type === "afterglow:ready") { sendRoute(); return; }
      if (data.type === "afterglow:navigation") {
        const next = new URLSearchParams(current.current);
        next.set("route", incoming);
        const hash = routeHash("applications", next);
        if (location.hash !== hash) {
          history[data.mode === "replace" ? "replaceState" : "pushState"](null, "", hash);
          // pushState does not emit hashchange; update the existing Cyberdeck router.
          current.current = next;
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }
      }
      if ((data.type === "afterglow:title" || data.type === "afterglow:navigation") && incoming === (cleanRoute(current.current.get("route")) || "discover") && typeof data.title === "string") {
        releaseTitle();
        releaseTitle = claimRouteTitle(data.title);
      }
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); releaseTitle(); };
  }, [origin, name]);
  useEffect(sendRoute, [route, origin]);
  return <section className="flex h-full flex-col" aria-label={name}>
    <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
      <a data-tv-frame-back href={routeHash("applications", readRoute().params.has("node") ? { node: readRoute().params.get("node")! } : {})} className="text-cyan-300">← Applications</a>
      <strong>{name}</strong><span className="flex-1" />
      <button onClick={() => {
        // Same route, fresh document, with no extra history entry.
        frame.current?.contentWindow?.postMessage({ type: "cyberdeck:reload" }, origin);
      }}>Reload</button>
    </div>
    <iframe ref={frame} referrerPolicy="origin" data-tv-autofocus onLoad={e => { sendRoute(); const input = window as Window & { __cyberdeckInputBridge?: unknown; __cyberdeckTV?: { focusElement: (el: HTMLElement) => void } }; if (input.__cyberdeckInputBridge) input.__cyberdeckTV?.focusElement(e.currentTarget); }} title={name} src={src} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen className="min-h-0 w-full flex-1 border-0 bg-black" />
  </section>;
}
