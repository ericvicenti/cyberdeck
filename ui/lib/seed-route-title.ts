import type { SeedAgentsRoute } from "@seed-hypermedia/agents-ui";

const tabs = { sessions: "Sessions", triggers: "Triggers", memory: "Memory", tools: "Tools", prompt: "Prompt", collaborators: "Collaborators", settings: "Settings" };

/** Titles describe the displayed read. This module never signs or fetches metadata. */
export function seedAgentTitle(route: Extract<SeedAgentsRoute, { key: "agent" }>, name?: string, triggerName?: string) {
  const detail = route.memoryPath || (route.triggerId ? triggerName?.trim() || route.triggerId : tabs[route.tab || "sessions"]);
  const pages = (!route.tab || route.tab === "sessions") && route.sessionPages ? ` · ${route.sessionPages} pages` : "";
  return `${detail}${pages}${seedExpandedTitle(route)} · ${name?.trim() || route.agentId} · Seed`;
}

export function seedReadFailureTitle(error: unknown, entity: string) {
  const status = (error as { status?: number })?.status;
  return status === 401 || status === 403 ? "Access denied · Seed"
    : `${entity} ${status === 404 ? "not found" : "unavailable"} · Seed`;
}

export function seedListTitle(route: Extract<SeedAgentsRoute, { key: "agents" | "agent-server" }>) {
  if (route.key === "agent-server" && route.serverDialog) return `${route.serverDialog === "accounts" ? "Server accounts" : "Model providers"} · ${route.serverUrl} · Seed server`;
  const pages = (route.sessionPages ? ` · ${route.sessionPages} pages` : "") + seedExpandedTitle(route);
  return route.key === "agent-server" ? `Sessions${pages} · ${route.serverUrl} · Seed server`
    : pages ? `Sessions${pages} · Seed` : "Seed";
}

function seedExpandedTitle(route: { expandedSessions?: string[] }) {
  const count = route.expandedSessions?.length || 0;
  return count ? count === 1 ? " · Sub-sessions" : ` · ${count} sub-session lists` : "";
}
