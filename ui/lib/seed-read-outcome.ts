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
      case "session-context": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && selected.panel === "context" && selected.eventId === outcome.path;
      case "session-run-tools": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && !!(selected.inlineRunTools?.length || selected.inlineRunDetails?.length || selected.inlineRunTool || selected.inlineRunError) && JSON.stringify([selected.inlineRunTools || [], selected.inlineRunDetails || [], selected.inlineRunTool || "", selected.inlineRunError || ""]) === outcome.path;
      case "session-inline-journal":
      case "session-run-card": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && !!(selected.inlineRunTools?.some(value => value.slice(value.indexOf(":") + 1) === outcome.path) || [...(selected.inlineRunDetails || []), ...(selected.inlineRunTool ? [selected.inlineRunTool] : []), ...(selected.inlineRunError ? [selected.inlineRunError] : [])].some(value => JSON.parse(value)[0] === outcome.path));
      case "session-inline-error": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && selected.inlineRunError === outcome.path;
      case "session-inline-tools": {
        if (selected.key !== "agent-session" || selected.sessionId !== outcome.sessionId) return false;
        const [runId] = JSON.parse(outcome.path);
        const details = (selected.inlineRunDetails || []).filter(value => JSON.parse(value)[0] === runId);
        const tool = selected.inlineRunTool && JSON.parse(selected.inlineRunTool)[0] === runId ? JSON.parse(selected.inlineRunTool)[1] : "";
        const open = !!selected.inlineRunTools?.includes("open:" + runId);
        return !!(open || details.length || tool) && JSON.stringify([runId, details, tool, open]) === outcome.path;
      }
      case "session-inline-detail-read": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && !!selected.inlineRunDetails?.includes(outcome.path);
      case "session-thinking": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && !!selected.expandedThinking?.length && JSON.stringify(selected.expandedThinking) === outcome.path;
      case "session-trigger-context": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && !!selected.expandedTriggerContext?.length && JSON.stringify(selected.expandedTriggerContext) === outcome.path;
      case "session-handoff": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && JSON.stringify([selected.expandedHandoffs || [], selected.panel === "handoff" ? selected.eventId : ""]) === outcome.path;
      case "session-details": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && !!selected.expandedDetails?.length && JSON.stringify(selected.expandedDetails) === outcome.path;
      case "session-detail-read": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && !!selected.expandedDetails?.includes(outcome.path);
      case "session-tool": return selected.key === "agent-session" && selected.sessionId === outcome.sessionId && selected.panel === "tool" && selected.toolId === outcome.toolId && (selected.fullPayload || "") === outcome.path;
      case "trigger": return selected.key === "agent" && selected.triggerId === outcome.triggerId;
      case "run-details": return selected.key === "agent-run" && selected.runId === outcome.runId && JSON.stringify([selected.expandedDetails || [], selected.toolId || ""]) === outcome.path;
      case "run-detail-read": return selected.key === "agent-run" && selected.runId === outcome.runId && !!selected.expandedDetails?.includes(outcome.path);
      case "run-error": return selected.key === "agent-run" && selected.runId === outcome.runId && selected.errorRunId === outcome.path;
      case "run-tools": return selected.key === "agent-run" && selected.runId === outcome.runId && selected.runTools === outcome.path;
      case "run-disclosure": return selected.key === "agent-run" && selected.runId === outcome.runId && JSON.stringify([!!selected.runCode, !!selected.runActivity, selected.activityEntries || []]) === outcome.path;
      case "run-journal":
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
        const key = outcome.kind === "session-inline-tools" ? `${outcome.kind}:${outcome.sessionId}:${JSON.parse(outcome.path)[0]}` : outcome.kind === "session-inline-detail-read" ? `${outcome.kind}:${outcome.sessionId}:${outcome.path}` : outcome.kind === "child-session-list" ? `${outcome.kind}:${outcome.listOwner}:${outcome.path}` : (outcome.kind === "session-run-card" || outcome.kind === "session-inline-journal") ? `${outcome.kind}:${outcome.sessionId}:${outcome.path}` : outcome.kind === "session-detail-read" ? `${outcome.kind}:${outcome.sessionId}:${outcome.path}` : outcome.kind === "run-detail-read" ? `${outcome.kind}:${outcome.runId}:${outcome.path}` : outcome.kind;
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
  const tool = get("session-tool"), globalList = get("global-session-list"), thinking = get("session-thinking"), context = get("session-context");
  const children = results?.host === host ? Object.values(results.values).filter((value): value is Outcome => !!value && value.kind === "child-session-list" && owns(route, value)) : [];
  const child = children.find(value => value.error) || children.find(value => value.pending);
  const dialog = get("server-dialog"), disclosure = get("run-disclosure"), runError = get("run-error"), runTools = get("run-tools");
  const runDetails = get("run-details"), journal = get("run-journal");
  const runDetailReads = results?.host === host ? Object.values(results.values).filter((value): value is Outcome => !!value && value.kind === "run-detail-read" && owns(route, value)) : [];
  const runDetailRead = runDetailReads.find(value => value.error) || runDetailReads.find(value => value.pending);
  const inlineRuns = get("session-run-tools"), inlineError = get("session-inline-error");
  const inlineCards = results?.host === host ? Object.values(results.values).filter((value): value is Outcome => !!value && value.kind === "session-run-card" && owns(route, value)) : [];
  const inlineCard = inlineCards.find(value => value.error) || inlineCards.find(value => value.pending);
  const inlineJournals = results?.host === host ? Object.values(results.values).filter((value): value is Outcome => !!value && value.kind === "session-inline-journal" && owns(route, value)) : [];
  const inlineJournal = inlineJournals.find(value => value.error) || inlineJournals.find(value => value.pending);
  const inlineSelections = results?.host === host ? Object.values(results.values).filter((value): value is Outcome => !!value && value.kind === "session-inline-tools" && owns(route, value)) : [];
  const inlineSelection = inlineSelections.find(value => value.error) || inlineSelections.find(value => value.pending);
  const inlineInspector = route.key === "agent-session" && route.inlineRunTool ? inlineSelections.find(value => value.kind === "session-inline-tools" && JSON.parse(value.path)[0] === JSON.parse(route.inlineRunTool!)[0]) : undefined;
  const inlineDetailReads = results?.host === host ? Object.values(results.values).filter((value): value is Outcome => !!value && value.kind === "session-inline-detail-read" && owns(route, value)) : [];
  const inlineDetailRead = inlineDetailReads.find(value => value.error) || inlineDetailReads.find(value => value.pending);
  const triggerContext = get("session-trigger-context");
  const details = get("session-details"), handoff = get("session-handoff");
  const detailReads = results?.host === host ? Object.values(results.values).filter((value): value is Outcome => !!value && value.kind === "session-detail-read" && owns(route, value)) : [];
  const detailRead = detailReads.find(value => value.error) || detailReads.find(value => value.pending);
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
      : event?.pending ? "Loading earlier message · Seed"
      : event?.error && event.name === "Earlier message" ? failure(event.error, "Message")
      : tool?.error ? failure(tool.error, tool.name && route.fullPayload ? "Tool payload" : "Tool call")
      : inlineRuns?.error ? failure(inlineRuns.error, "Run cards")
      : inlineCard?.error ? failure(inlineCard.error, "Run card")
      : inlineRuns?.pending || inlineCard?.pending ? "Loading run cards · Seed"
      : inlineJournal?.error ? failure(inlineJournal.error, "Run updates")
      : inlineJournal?.pending ? "Reconnecting run updates · Seed"
      : inlineError?.error ? failure(inlineError.error, "Run error")
      : route.inlineRunError ? `${inlineError && !inlineError.pending ? "Error" : "Loading error"} · ${inlineError?.name || "Recorded run"} · Seed session`
      : inlineSelection?.error ? failure(inlineSelection.error, "Recorded tools")
      : inlineDetailRead?.error ? failure(inlineDetailRead.error, "Workflow run")
      : inlineDetailRead?.pending ? "Loading workflow run · Seed"
      : inlineSelection?.pending ? "Waiting for selected recorded tools · Seed"
      : triggerContext?.error ? failure(triggerContext.error, "Trigger context")
      : handoff?.error ? failure(handoff.error, "Handoff")
      : context?.error ? failure(context.error, "Message context")
      : event?.error ? failure(event.error, "Message")
      : thinking?.error ? failure(thinking.error, "Tool group")
      : details?.error ? failure(details.error, "Tool details")
      : detailRead?.error ? failure(detailRead.error, "Workflow run")
      : detailRead?.pending ? "Loading workflow run · Seed"
      : `${route.panel === "handoff" ? "Handoff projection · " : route.panel === "prompt" ? "Current system prompt · " : route.panel === "context" ? "Message context · " : route.panel === "tool" ? `${!tool || tool.pending ? "Loading tool payload · " : route.fullPayload ? `Full ${route.fullPayload === "both" ? "input/output" : route.fullPayload} · ` : "Tool input/output · "}${tool?.name || route.toolId} · ` : route.eventId ? "Message · " : ""}${route.inlineRunTool ? `Recorded tool input/output · ${inlineInspector?.name || "Loading tool"} · ` : ""}${route.inlineRunDetails?.length ? `${route.inlineRunDetails.length} recorded tool detail${route.inlineRunDetails.length === 1 ? "" : "s"} · ` : ""}${route.inlineRunTools?.length ? `${route.inlineRunTools.length === 1 ? `Run tool calls ${route.inlineRunTools[0].startsWith("open:") ? "open" : "collapsed"}` : `${route.inlineRunTools.length} run tool lists`} · ` : ""}${route.expandedTriggerContext?.length ? `${route.expandedTriggerContext.map(field => ({ activity: "Activity details", instructions: "Trigger instructions", prompt: "Trigger prompt" })[field]).join(" + ")} · ${triggerContext?.name ? `${triggerContext.name} · ` : ""}` : ""}${route.expandedHandoffs?.length ? `${route.expandedHandoffs.length} expanded handoff${route.expandedHandoffs.length === 1 ? "" : "s"} · ` : ""}${route.expandedDetails?.length ? `${route.expandedDetails.length} tool detail${route.expandedDetails.length === 1 ? "" : "s"} · ` : ""}${!route.panel && route.expandedThinking?.length ? `${route.expandedThinking.length} expanded tool group${route.expandedThinking.length === 1 ? "" : "s"} · ` : ""}${session.name?.trim() || "Untitled session"} · Seed session`;
  } else if (run && route.key === "agent-run") {
    title = run.error ? failure(run.error, "Run")
      : journal?.error ? failure(journal.error, "Run updates")
      : journal?.pending ? "Reconnecting run updates · Seed"
      : runError?.error ? failure(runError.error, "Run error")
      : route.errorRunId ? `${runError && !runError.pending ? "Error" : "Loading error"} · ${runError?.name || route.errorRunId} · Seed run`
      : route.toolId ? runDetails?.error && !runDetails.name ? failure(runDetails.error, "Run tools")
        : `${runDetails?.name ? "Tool input/output" : "Waiting for tool"} · ${runDetails?.name || route.toolId} · ${run.name?.trim() || route.runId} · Seed run`
      : runDetails?.error ? failure(runDetails.error, "Run tools")
      : runTools?.error ? failure(runTools.error, "Recorded tools")
      : runDetailRead?.error ? failure(runDetailRead.error, "Workflow run")
      : runDetailRead?.pending ? "Loading workflow run · Seed"
      : disclosure?.error ? failure(disclosure.error, disclosure.name || "Workflow source")
      : `${runDetails?.pending ? "Waiting for selected tools · " : ""}${route.expandedDetails?.length ? `${route.expandedDetails.length} tool detail${route.expandedDetails.length === 1 ? "" : "s"} · ` : ""}${runTools?.pending ? "Waiting for tool calls · " : ""}${disclosure?.pending ? "Waiting for activity · " : ""}${route.runCode ? "Code · " : ""}${route.runTools ? `Tool calls ${route.runTools === "open" ? "open" : "collapsed"} · ` : ""}${route.runActivity ? route.activityEntries?.length ? `${route.activityEntries.length} activity entr${route.activityEntries.length === 1 ? "y" : "ies"} · ` : "Activity · " : ""}${run.name?.trim() || route.runId} · Seed run`;
  }
  return { host: observed, title };
}
