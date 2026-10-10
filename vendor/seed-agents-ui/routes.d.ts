/** One tab of the agent page. */
export type SeedAgentTab = 'sessions' | 'triggers' | 'memory' | 'tools' | 'prompt' | 'collaborators' | 'settings';
/** A place in the agents UI. Mirrors Seed's agent NavRoutes, so links are interchangeable with the apps. */
export type SeedAgentsRoute = 
/** Every agent the account can use, across its servers. */
{
    key: 'agents';
}
/** One agents server: its agents and providers. */
 | {
    key: 'agent-server';
    serverUrl: string;
}
/** One agent, on one of its tabs. */
 | {
    key: 'agent';
    agentId: string;
    serverUrl?: string;
    tab?: SeedAgentTab;
    triggerId?: string;
    /** Memory tab: the file to open. */
    memoryPath?: string;
}
/** One session (a conversation). */
 | {
    key: 'agent-session';
    sessionId: string;
    serverUrl?: string;
    agentId?: string;
}
/** One durable run (a script or delegated model run). */
 | {
    key: 'agent-run';
    runId: string;
    serverUrl?: string;
    agentId?: string;
};
/** True when a Seed NavRoute is one the agents UI renders itself. */
export declare function isSeedAgentsRoute(route: {
    key: string;
}): route is SeedAgentsRoute;
/**
 * The route as a relative path with query, e.g. `session/<id>?agent=<id>`, or `''` for the agents
 * list. It is the part after `/hm/agents/` in Seed's web URLs, so a host can mount it anywhere.
 */
export declare function seedAgentsRouteToPath(route: SeedAgentsRoute): string;
/** Parses a path produced by {@link seedAgentsRouteToPath}. Unknown paths open the agents list. */
export declare function seedAgentsRouteFromPath(path: string): SeedAgentsRoute;
/** Seed's public web URL for a route, e.g. to open it in the Seed web app. */
export declare function seedAgentsRouteToWebUrl(route: SeedAgentsRoute, gatewayUrl?: string): string;
