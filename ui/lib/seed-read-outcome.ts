import { useEffect, useMemo, useRef, useState } from "react";
import { seedAgentTitle, seedReadFailureTitle as failure } from "./seed-route-title";
import { type SeedAgentsHost, type SeedAgentsRoute } from "@seed-hypermedia/agents-ui";

const serverKey = (value: string) => value.replace(/\/+$/, "");
type Outcome = Parameters<NonNullable<SeedAgentsHost["onReadOutcome"]>>[0];
/** Observe the content already displayed by Seed, including URL-supplied servers.
 * Ownership includes host, signer, server and selected entity. Panel/anchor edits
 * retain the displayed result and never fetch or sign another transcript read. */
export function useSeedReadOutcome(host: SeedAgentsHost | null, route: SeedAgentsRoute) {
  const current = useRef({ host, route });
  const mounted = useRef(true);
  current.current = { host, route };
  const [results, setResults] = useState<{ host: SeedAgentsHost; values: Partial<Record<Outcome["kind"], Outcome>> }>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const owns = (selected: SeedAgentsRoute, outcome: Outcome) => {
    if (!host || host.signer?.accountUid !== outcome.accountUid ||
      serverKey("serverUrl" in selected && selected.serverUrl || host.serverUrl) !== serverKey(outcome.serverUrl)) return false;
    switch (outcome.kind) {
      case "memory-selection":
      case "memory-file": return selected.key === "agent" && selected.agentId === outcome.agentId && selected.memoryPath === outcome.path;
      case "session-list": return selected.key === "agent" && selected.agentId === outcome.agentId && (!selected.tab || selected.tab === "sessions") && String(selected.sessionPages || 1) === outcome.path;
      case "agent": return selected.key === "agent" && selected.agentId === outcome.agentId;
      case "session": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId;
      case "session-event": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && selected.eventId === outcome.path;
      case "trigger": return selected.key === "agent" && selected.triggerId === outcome.triggerId;
      case "run": return selected.key === "agent-run" && selected.runId === outcome.runId;
    }
  };
  const observed = useMemo(() => host && ({
    ...host,
    onReadOutcome: outcome => {
      const owner = current.current;
      if (!mounted.current || owner.host !== host || !owns(owner.route, outcome)) return;
      setResults(previous => {
        const values = previous?.host === host ? previous.values : {};
        const old = values[outcome.kind];
        if (old && old.error === outcome.error) {
          const { error: _oldError, ...oldValue } = old;
          const { error: _error, ...value } = outcome;
          if (JSON.stringify(oldValue) === JSON.stringify(value)) return previous;
        }
        return { host, values: { ...values, [outcome.kind]: outcome } };
      });
    },
  } satisfies SeedAgentsHost), [host]);
  const get = (kind: Outcome["kind"]) => {
    const value = results?.host === host ? results.values[kind] : undefined;
    return value && owns(route, value) ? value : undefined;
  };
  let title: string | undefined;
  const memory = get("memory-file"), agent = get("agent"), session = get("session"), run = get("run"), event = get("session-event");
  const list = get("session-list"), selection = get("memory-selection"), trigger = get("trigger");
  if (agent?.error && route.key === "agent") title = failure(agent.error, "Agent");
  else if (list?.error) title = failure(list.error, "Sessions");
  else if (memory?.error) {
    const status = (memory.error as { status?: number })?.status;
    title = `Memory file ${status === 401 || status === 403 ? "access denied" : status === 404 ? "not found" : "unavailable"} · Seed`;
  } else if (agent && route.key === "agent") {
    if (selection?.error) {
      const status = (selection.error as { status?: number })?.status;
      title = status === 404 && (selection.error as { missingEntry?: boolean }).missingEntry ? `Memory file not found · ${agent.name?.trim() || route.agentId} · Seed` : failure(selection.error, "Memory file");
    } else if (trigger?.error) title = failure(trigger.error, "Agent or trigger");
    else title = seedAgentTitle(route, agent.name, trigger?.name);
  } else if (session && route.key === "agent-session") {
    title = session.error ? failure(session.error, "Session")
      : event?.error ? failure(event.error, "Message")
      : `${route.panel === "prompt" ? "Current system prompt · " : route.eventId ? "Message · " : ""}${session.name?.trim() || "Untitled session"} · Seed session`;
  } else if (run && route.key === "agent-run") {
    title = run.error ? failure(run.error, "Run") : `${run.name?.trim() || route.runId} · Seed run`;
  }
  return { host: observed, title };
}
