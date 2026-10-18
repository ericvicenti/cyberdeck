// Seed's own agents UI, embedded: agents, sessions with their tool calls and runs, triggers, memory,
// tools and MCP servers, system prompt, collaborators and settings. Cyberdeck only supplies the host
// (ui/lib/seed-agents.ts) and keeps the route in its hash URL (#/seed?r=<path>). The published
// package keeps this view aligned with the UI Seed ships without copying that UI into Cyberdeck.
import { useEffect, useMemo } from "react";
import { updateParams, useRouteTitle } from "../lib/navigation";
import { SeedAgentsProvider, SeedAgentsView, seedAgentsRouteFromPath, seedAgentsRouteToPath, type SeedAgentsRoute } from "@seed-hypermedia/agents-ui";
import "@seed-hypermedia/agents-ui/styles.css";
import "./seed-agents.css";
import { activeNode, navigate } from "../lib/api";
import { seedHash, useSeedAgentsHost } from "../lib/seed-agents";

/** The whole agents UI at the route in the hash (`#/seed?r=…`). */
export default function SeedAgents({ params }: { params: URLSearchParams }) {
  const path = params.get("r") ?? "";
  const parsed = useMemo(() => {
    try {
      const route = seedAgentsRouteFromPath(path);
      const canonical = seedAgentsRouteToPath(route);
      if (path.replace(/^\/+/, "") && !canonical) return null;
      return { route, canonical };
    } catch { return null; }
  }, [path]);
  useEffect(() => {
    if (parsed && path !== parsed.canonical) updateParams({ r: parsed.canonical || null }, "replace");
  }, [path, parsed]);
  useRouteTitle(parsed ? undefined : "Page not found · Seed");
  if (!parsed) return <section className="p-6"><h1>Page not found</h1><p>This Seed link is not recognised.</p><button onClick={() => navigate("seed")}>Open Seed agents</button></section>;
  const route = parsed.route;
  return (
    <SeedAgentsEmbed
      route={route}
      title={seedRouteTitle(route)}
      onRouteChange={(_next, mode, r) => {
        navigate("seed", r ? { r } : {}, mode);
      }}
    />
  );
}

function seedRouteTitle(route: SeedAgentsRoute): string {
  switch (route.key) {
    case "agents": return "Seed";
    case "agent-server": return `${route.serverUrl} · Seed server`;
    case "agent-session": return `${route.sessionId} · Seed session`;
    case "agent-run": return `${route.runId} · Seed run`;
    case "agent": return `${route.memoryPath || route.triggerId || route.tab || "sessions"} · ${route.agentId} · Seed`;
  }
}

type RouteChange = (route: SeedAgentsRoute, mode: "push" | "replace", path: string) => void;

/** The agents UI at one route, for other views to embed (Sessions shows Seed sessions with it). */
export function SeedAgentsEmbed({ route, onRouteChange, node = activeNode(), title }: { route: SeedAgentsRoute; onRouteChange?: RouteChange; node?: string; title?: string }) {
  const { host, session, error, retry } = useSeedAgentsHost(node);
  useRouteTitle(title ? error ? "Seed agents unavailable"
    : host && session && !session.available ? "Seed identity unavailable"
    : host && session && !session.reachable ? "Seed server unavailable"
    : title : undefined);
  if (error) {
    return (
      <div className="m-4 hud-card p-4 text-sm" role="alert">
        <div className="hud-label neon-red">Seed agents unavailable</div>
        <p className="mt-2 text-zinc-400">{error}</p>
        <button className="hud-badge mt-3 px-3 py-1 neon" onClick={retry}>Retry</button>
      </div>
    );
  }
  if (!host || !session) return <div className="p-6 text-xs text-zinc-500" role="status">Connecting to Seed agents…</div>;
  return (
    <div className="seed-agents-host flex h-full min-h-0 flex-1 flex-col" data-testid="seed-agents">
      {!session.available && (
        <div className="border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          This node cannot sign for Seed ({session.error ?? "no identity"}). Configure <code>seed.identity</code> in Cyberdeck's config.
        </div>
      )}
      {session.available && !session.reachable && (
        <div className="border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          The agents server at {session.agentsUrl} is not answering.
        </div>
      )}
      <SeedAgentsProvider
        host={host}
        route={route}
        onRouteChange={onRouteChange && ((next, mode) => onRouteChange(next, mode, seedAgentsRouteToPath(next)))}
        openRouteInNewWindow={(next) => window.open(seedHash(seedAgentsRouteToPath(next), node), "_blank", "noopener")}
      >
        <SeedAgentsView className="min-h-0 flex-1 overflow-auto" />
      </SeedAgentsProvider>
    </div>
  );
}
