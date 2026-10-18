import { useCallback, useEffect, useRef, useState } from "react";
import { navigate } from "../lib/api";
import { claimRouteTitle, routeHash, readRoute } from "../lib/navigation";

const DEFAULT_ROUTE = "discover";

function cleanRoute(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f]/.test(value)) return null;
  return value.replace(/^#\/?/, "") || DEFAULT_ROUTE;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f]/.test(value)) return null;
  return value.trim() || null;
}

function applicationHash(params: URLSearchParams): string {
  return routeHash("applications", params);
}

/**
 * Afterglow cooperates with this wrapper through a small, origin-bound
 * postMessage protocol. Cyberdeck owns the browser history while embedded;
 * the iframe keeps a single document alive so URL changes do not stop media.
 */
export function AfterglowFrame({
  url,
  params,
  name,
  visible = true,
}: {
  url: string;
  params: URLSearchParams;
  name: string;
  visible?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pendingRoute = useRef<string | null>(null);
  const currentParams = useRef(params);
  currentParams.current = params;

  const route = cleanRoute(params.get("route")) || DEFAULT_ROUTE;
  const target = new URL(url);
  const origin = target.origin;

  // Keep the iframe document stable across outer Back/Forward navigation.
  const [src] = useState(() => {
    target.searchParams.set("cyberdeck", location.origin);
    target.hash = route;
    return target.href;
  });

  const sendRoute = useCallback(() => {
    if (!visible || location.hash !== applicationHash(currentParams.current)) return;
    pendingRoute.current = cleanRoute(currentParams.current.get("route")) || DEFAULT_ROUTE;
    frame.current?.contentWindow?.postMessage(
      {
        type: "cyberdeck:navigate",
        route: cleanRoute(currentParams.current.get("route")) || DEFAULT_ROUTE,
      },
      origin,
    );
  }, [origin, visible]);

  useEffect(() => {
    if (!visible) return;
    let releaseTitle = claimRouteTitle(name);

    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;

      if (readRoute().view !== "applications" || readRoute().params.get("app") !== currentParams.current.get("app")) return;
      const data = event.data;
      const incoming = cleanRoute(data?.route);
      if (!incoming) return;

      if (data.type === "afterglow:ready") {
        sendRoute();
        return;
      }

      // Parent Back/Forward wins over child events queued for the old route.
      // A title/navigation acknowledgement for the requested route reopens it.
      if (pendingRoute.current && incoming !== pendingRoute.current) return;
      if (data.type === "afterglow:title" || data.type === "afterglow:navigation") pendingRoute.current = null;

      if (data.type === "afterglow:navigation") {
        const next = new URLSearchParams(currentParams.current);
        next.set("route", incoming);
        const hash = applicationHash(next);
        if (location.hash !== hash) {
          history[data.mode === "replace" ? "replaceState" : "pushState"](null, "", hash);
          currentParams.current = next;
          // History state methods do not emit hashchange themselves.
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }
      }

      const activeRoute = cleanRoute(currentParams.current.get("route")) || DEFAULT_ROUTE;
      if ((data.type === "afterglow:title" || data.type === "afterglow:navigation") && incoming === activeRoute) {
        const childTitle = cleanTitle(data.title);
        if (childTitle) {
          releaseTitle();
          releaseTitle = claimRouteTitle(childTitle);
        }
      }
    };

    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      releaseTitle();
    };
  }, [name, origin, sendRoute, visible]);

  const hash = applicationHash(params);
  useEffect(sendRoute, [hash, sendRoute]);

  return (
    <section className="flex h-full flex-col" aria-label={name}>
      <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
        <button onClick={() => navigate("applications")} className="text-cyan-300">
          ← Applications
        </button>
        <strong>{name}</strong>
        <span className="flex-1" />
        <button
          onClick={() =>
            frame.current?.contentWindow?.postMessage({ type: "cyberdeck:reload" }, origin)
          }
        >
          Reload
        </button>
      </div>
      <iframe
        ref={frame}
        data-testid="afterglow-frame"
        referrerPolicy="origin"
        onLoad={sendRoute}
        title={name}
        src={src}
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
        allowFullScreen
        className="min-h-0 w-full flex-1 border-0 bg-black"
      />
    </section>
  );
}
