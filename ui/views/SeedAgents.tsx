// Seed's own agents UI, embedded: agents, sessions with their tool calls and runs, triggers, memory,
// tools and MCP servers, system prompt, collaborators and settings. Cyberdeck only supplies the host
// (ui/lib/seed-agents.ts) and keeps the route in its hash URL (#/seed?r=<path>), so this view gains
// every feature Seed ships when vendor/seed-agents-ui is refreshed (scripts/seed-agents-ui.ts).
import { useMemo } from "react";
import { SeedAgentsProvider, SeedAgentsView, seedAgentsRouteFromPath, seedAgentsRouteToPath, type SeedAgentsRoute } from "@seed-hypermedia/agents-ui";
import "@seed-hypermedia/agents-ui/styles.css";
import "./seed-agents.css";
import { navigate } from "../lib/api";
import { seedHash, useSeedAgentsHost } from "../lib/seed-agents";

/** The whole agents UI at the route in the hash (`#/seed?r=…`). */
export default function SeedAgents({ params }: { params: URLSearchParams }) {
  const path = params.get("r") ?? "";
  const route = useMemo(() => seedAgentsRouteFromPath(path), [path]);
  return (
    <SeedAgentsEmbed
      route={route}
      onRouteChange={(_next, mode, r) => {
        if (mode === "replace") history.replaceState(null, "", seedHash(r));
        else navigate("seed", r ? { r } : {});
      }}
    />
  );
}

type RouteChange = (route: SeedAgentsRoute, mode: "push" | "replace", path: string) => void;

/** The agents UI at one route, for other views to embed (Sessions shows Seed sessions with it). */
export function SeedAgentsEmbed({ route, onRouteChange }: { route: SeedAgentsRoute; onRouteChange?: RouteChange }) {
  const { host, session, error, retry } = useSeedAgentsHost();
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
        openRouteInNewWindow={(next) => window.open(seedHash(seedAgentsRouteToPath(next)), "_blank", "noopener")}
      >
        <SeedAgentsView className="min-h-0 flex-1 overflow-auto" />
      </SeedAgentsProvider>
    </div>
  );
}
