import { useEffect, useMemo, useRef, useState } from "react";
import { seedAgentTitle, seedListTitle, seedReadFailureTitle as failure } from "./seed-route-title";
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
  const [results, setResults] = useState<{ host: SeedAgentsHost; values: Partial<Record<string, Outcome>> }>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const owns = (selected: SeedAgentsRoute, outcome: Outcome) => {
    if (!host || host.signer?.accountUid !== outcome.accountUid ||
      serverKey("serverUrl" in selected && selected.serverUrl || host.serverUrl) !== serverKey(outcome.serverUrl)) return false;
    switch (outcome.kind) {
      case "server-dialog": return selected.key === "agent-server" && selected.serverDialog === outcome.path;
      case "child-session-list": return (selected.key === "agents" || selected.key === "agent-server" || selected.key === "agent" && (!selected.tab || selected.tab === "sessions")) && !!selected.expandedSessions?.includes(outcome.path) && outcome.listOwner === JSON.stringify([selected.key, selected.key === "agent" ? selected.agentId : "", selected.sessionPages || 1]);
      case "global-session-list": return selected.key === outcome.routeKey && (selected.key === "agents" || selected.key === "agent-server") && String(selected.sessionPages || 1) === outcome.path;
      case "memory-selection":
      case "memory-file": return selected.key === "agent" && selected.agentId === outcome.agentId && selected.memoryPath === outcome.path;
      case "session-list": return selected.key === "agent" && selected.agentId === outcome.agentId && (!selected.tab || selected.tab === "sessions") && String(selected.sessionPages || 1) === outcome.path;
      case "agent": return selected.key === "agent" && selected.agentId === outcome.agentId;
      case "session": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId;
      case "session-event": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && selected.eventId === outcome.path;
      case "session-thinking": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && !!selected.expandedThinking?.length && JSON.stringify(selected.expandedThinking) === outcome.path;
      case "session-tool": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && selected.panel === "tool" && selected.toolId === outcome.toolId && (selected.fullPayload || "") === outcome.path;
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
        const key = outcome.kind === "child-session-list" ? `${outcome.kind}:${outcome.listOwner}:${outcome.path}` : outcome.kind;
        const old = values[key];
        if (old && old.error === outcome.error) {
          const { error: _oldError, ...oldValue } = old;
          const { error: _error, ...value } = outcome;
          if (JSON.stringify(oldValue) === JSON.stringify(value)) return previous;
        }
        return { host, values: { ...values, [key]: outcome } };
      });
    },
  } satisfies SeedAgentsHost), [host]);
  const get = (kind: Outcome["kind"]) => {
    const value = results?.host === host ? results.values[kind] : undefined;
    return value && owns(route, value) ? value : undefined;
  };
  let title: string | undefined = route.key === "agents" || route.key === "agent-server" ? "Loading sessions · Seed" : undefined;
  const memory = get("memory-file"), agent = get("agent"), session = get("session"), run = get("run"), event = get("session-event");
  const list = get("session-list"), selection = get("memory-selection"), trigger = get("trigger");
  const tool = get("session-tool"), globalList = get("global-session-list"), thinking = get("session-thinking");
  const children = results?.host === host ? Object.values(results.values).filter((value): value is Outcome => !!value && value.kind === "child-session-list" && owns(route, value)) : [];
  const child = children.find(value => value.error) || children.find(value => value.pending);
  const dialog = get("server-dialog");
  if (route.key === "agent-server" && route.serverDialog) {
    const label = route.serverDialog === "accounts" ? "Server accounts" : "Model providers";
    title = dialog?.error ? failure(dialog.error, label)
      : !dialog || dialog.pending ? `Loading ${label.toLowerCase()} · Seed`
      : `${label} · ${route.serverUrl} · Seed server`;
  }
  else if (globalList?.error) title = failure(globalList.error, "Sessions");
  else if (agent?.error && route.key === "agent") title = failure(agent.error, "Agent");
  else if (list?.error) title = failure(list.error, "Sessions");
  else if (child?.error) title = failure(child.error, (child.error as { missingEntry?: boolean }).missingEntry ? "Sub-session parent" : "Sub-sessions");
  else if (child?.pending) title = "Loading sub-sessions · Seed";
  else if (globalList && (route.key === "agents" || route.key === "agent-server")) title = globalList.pending ? "Loading sessions · Seed" : seedListTitle(route);
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
      : tool?.error ? failure(tool.error, tool.name && route.fullPayload ? "Tool payload" : "Tool call")
      : event?.error ? failure(event.error, "Message")
      : thinking?.error ? failure(thinking.error, "Tool group")
      : `${route.panel === "prompt" ? "Current system prompt · " : route.panel === "tool" ? `${!tool || tool.pending ? "Loading tool payload · " : route.fullPayload ? `Full ${route.fullPayload === "both" ? "input/output" : route.fullPayload} · ` : "Tool input/output · "}${tool?.name || route.toolId} · ` : route.eventId ? "Message · " : ""}${!route.panel && route.expandedThinking?.length ? `${route.expandedThinking.length} expanded tool group${route.expandedThinking.length === 1 ? "" : "s"} · ` : ""}${session.name?.trim() || "Untitled session"} · Seed session`;
  } else if (run && route.key === "agent-run") {
    title = run.error ? failure(run.error, "Run") : `${run.name?.trim() || route.runId} · Seed run`;
  }
  return { host: observed, title };
}
