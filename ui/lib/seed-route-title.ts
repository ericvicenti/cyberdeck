import { useEffect, useState } from "react";
import { createSeedAgentsClient, seedAgentsRouteToPath, type SeedAgentsClient, type SeedAgentsHost, type SeedAgentsRoute } from "@seed-hypermedia/agents-ui";

const tabs = { sessions: "Sessions", triggers: "Triggers", memory: "Memory", tools: "Tools", prompt: "Prompt", collaborators: "Collaborators", settings: "Settings" };
const label = (value: string | undefined, fallback: string) => value?.trim() || fallback;

/** Only metadata reads. A title must never create a session, message an agent,
 * fire a trigger, resume a run or download a memory file. */
export async function seedEntityTitle(client: SeedAgentsClient, route: SeedAgentsRoute): Promise<string | undefined> {
  if (route.key === "agent") {
    const { agent } = await client.send({ _: "GetAgent", agentId: route.agentId });
    const name = label(agent.definition.name, route.agentId);
    const detail = route.memoryPath || (route.triggerId
      ? label((await client.send({ _: "GetAgentTrigger", triggerId: route.triggerId })).trigger.name, route.triggerId)
      : tabs[route.tab || "sessions"]);
    return `${detail} · ${name} · Seed`;
  }
  if (route.key === "agent-session") {
    const { session } = await client.send({ _: "GetSession", sessionId: route.sessionId, limit: 1 });
    return `${label(session.title, "Untitled session")} · Seed session`;
  }
  if (route.key === "agent-run") {
    const { run } = await client.send({ _: "GetRun", runId: route.runId });
    return `${label(run.title, route.runId)} · Seed run`;
  }
}

function failureTitle(error: unknown, route: SeedAgentsRoute): string {
  const status = (error as { status?: number })?.status;
  const entity = route.key === "agent-session" ? "Session" : route.key === "agent-run" ? "Run" : route.key === "agent" && route.triggerId ? "Agent or trigger" : "Agent";
  return status === 401 || status === 403 ? "Access denied · Seed"
    : `${entity} ${status === 404 ? "not found" : "unavailable"} · Seed`;
}

/** Results are scoped to both the exact route and signing host. Revalidate on
 * return/focus and periodically while visible so renamed entities don't stick
 * in the tab title. No title-only signatures are sent to URL-supplied servers. */
export function useSeedEntityTitle(host: SeedAgentsHost | null, route: SeedAgentsRoute): string | undefined {
  const path = seedAgentsRouteToPath(route);
  const [result, setResult] = useState<{ host: SeedAgentsHost; path: string; title: string | undefined }>();
  useEffect(() => {
    if (!host?.signer || !["agent", "agent-session", "agent-run"].includes(route.key)) return;
    if ("serverUrl" in route && route.serverUrl && route.serverUrl.replace(/\/$/, "") !== host.serverUrl.replace(/\/$/, "")) return;
    let alive = true, loading = false;
    const signer = host.signer;
    const client = createSeedAgentsClient({ serverUrl: host.serverUrl, signer: {
      ...signer,
      sign: data => alive ? signer.sign(data) : Promise.reject(new Error("Title request cancelled")),
    } });
    const refresh = async () => {
      if (!alive || loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const title = await seedEntityTitle(client, route);
        if (alive) setResult({ host, path, title });
      } catch (error) {
        if (alive) setResult({ host, path, title: failureTitle(error, route) });
      } finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false; clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [host, path]);
  return result?.host === host && result.path === path ? result.title : undefined;
}
