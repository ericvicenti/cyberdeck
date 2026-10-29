// Live sessions client: daemon-owned PTYs on any node. Every helper names the node it
// talks to ("" = the daemon serving this page); the Sessions view and the prompt bar show
// every machine's sessions at once, each tagged with where it runs.
import { useEffect, useRef, useState } from "react";
import { token, apiOn, navigate, wsUrl, ApiError } from "./api";
import { fetchNodes, subscribeNodes, type FleetNodes } from "./fleet";
import type { Caps, Runner, Tool } from "../../src/shared/harness";

export { fetchNodes, type FleetNode, type FleetNodes } from "./fleet";
export { apiOn };

export type LiveSession = {
  id: string; title: string; cwd: string; cmd: string | null; tool: Tool; prompt: string | null; runner: Runner;
  state: "running" | "exited" | "lost"; createdAt: number; exitedAt: number | null; exitCode: number | null;
  clients: number; lastOutputAt: number | null; bells: number; busy: boolean;
  /** Added client-side: which node it lives on ("" = local). */
  node: string; nodeName: string;
};

const postOn = <T,>(node: string, path: string, body: unknown) => apiOn<T>(node, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type SessionsAnswer = { sessions: Omit<LiveSession, "node" | "nodeName">[]; seedError?: string };
export const listSessions = async (node: string, nodeName: string): Promise<LiveSession[]> =>
  (await apiOn<SessionsAnswer>(node, "/api/sessions")).sessions.map((s) => ({ ...s, node, nodeName }));

/** Idempotency key available on private HTTP fleet origins as well as HTTPS. */
export function messageRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type CreateSession = { cwd?: string; cmd?: string; title?: string; tool?: Tool; prompt?: string; runner?: Runner; cols?: number; rows?: number };
export const createSession = (node: string, nodeName: string, body: CreateSession) =>
  postOn<Omit<LiveSession, "node" | "nodeName">>(node, "/api/sessions", body).then((s) => ({ ...s, node, nodeName }) as LiveSession);
export const removeSession = (node: string, id: string) => apiOn<{ ok: true }>(node, `/api/sessions/${id}`, { method: "DELETE" });
export const renameSession = (node: string, id: string, title: string) => postOn<{ ok: true }>(node, `/api/sessions/${id}/rename`, { title });
export const sendInput = (node: string, id: string, data: string, enter = true) => postOn<{ ok: true }>(node, `/api/sessions/${id}/input`, { data, enter });

/** WebSocket URL to attach to a session on a node. */
export function attachUrl(node: string, id: string, size?: { cols: number; rows: number }): string {
  const path = node ? `/api/nodes/${encodeURIComponent(node)}/sessions/${id}/attach` : `/api/sessions/${id}/attach`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ token: token(), ...(size ? { cols: String(size.cols), rows: String(size.rows) } : {}) });
  return `${proto}://${location.host}${path}?${q}`;
}

// ---- capabilities per node (cached for the page lifetime) ----
const capsCache = new Map<string, Promise<Caps | null>>();
export function getCaps(node: string): Promise<Caps | null> {
  let p = capsCache.get(node);
  if (!p) {
    p = apiOn<Caps>(node, "/api/harness/caps").catch(() => null);
    capsCache.set(node, p);
    p.then((v) => { if (!v) capsCache.delete(node); });
  }
  return p;
}

/** Go to a session's terminal; the URL names the session and its node. */
export function openSession(s: { node: string; nodeName: string; id: string }) {
  navigate("term", { session: s.id, node: s.node });
}

export const toolForCmd = (cmd: string | undefined): Tool => (!cmd ? "shell" : /^claude(\s|$)/.test(cmd) ? "cc" : /^codex(\s|$)/.test(cmd) ? "cx" : "shell");

/** Create a session on a node ("" = this machine), picking tmux when that node has it, and open it (or not). */
export async function startSession(opts: { node?: string; nodeName?: string; cwd?: string; cmd?: string; title?: string; tool?: Tool; prompt?: string; runner?: Runner; open?: boolean }): Promise<LiveSession> {
  const node = opts.node ?? "";
  const nodeName = opts.nodeName ?? (node ? "node" : "local");
  const runner = opts.runner ?? ((await getCaps(node))?.tmux ? "tmux" : "pty");
  const s = await createSession(node, nodeName, { cwd: opts.cwd, cmd: opts.cmd, title: opts.title, tool: opts.tool ?? toolForCmd(opts.cmd), prompt: opts.prompt, runner });
  if (opts.open !== false) openSession(s);
  return s;
}

/** What each machine said the last time it was asked for its sessions. */
export type NodeSessionsState = { node: string; nodeName: string; online: boolean; answered: boolean; error: string | null; errorStatus?: number; seedError: string | null };

/** All live sessions across this node and every online peer, refreshed every few seconds and on session events.
 *  A machine that stops answering keeps its last known sessions on screen and reports its error in `states`. */
export function useLiveSessions(intervalMs = 4000): { sessions: LiveSession[]; nodes: FleetNodes | null; states: NodeSessionsState[]; fleetError: { message: string; status?: number } | null; refresh: () => void; replace: (node: string, sessions: LiveSession[]) => void } {
  const [byNode, setByNode] = useState<Record<string, LiveSession[]>>({});
  const [states, setStates] = useState<Record<string, NodeSessionsState>>({});
  const [nodes, setNodes] = useState<FleetNodes | null>(null);
  const nodesRef = useRef<FleetNodes | null>(null);
  const revisions = useRef(new Map<string, number>());
  const [fleetError, setFleetError] = useState<{ message: string; status?: number } | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    let alive = true;
    let lastNodes = 0;
    const pending = new Map<string, number>();
    const tick = async (supersede = false) => {
      if (!alive || document.visibilityState !== "visible") return;
      if (!nodesRef.current || Date.now() - lastNodes > 30_000) {
        try {
          const next = await fetchNodes();
          if (!alive) return;
          nodesRef.current = next; lastNodes = Date.now(); setNodes(next); setFleetError(null);
        } catch (e) {
          if (!alive) return;
          setFleetError({ message: e instanceof Error ? e.message : String(e), status: e instanceof ApiError ? e.status : undefined });
        }
      }
      const f = nodesRef.current;
      const targets = [{ id: "", name: f?.self.name ?? "local", online: true }, ...(f?.nodes ?? [])];
      await Promise.all(targets.map(async (t) => {
        if (t.online && pending.has(t.id) && !supersede) return;
        const revision = (revisions.current.get(t.id) ?? 0) + 1;
        revisions.current.set(t.id, revision);
        // Polls and event-triggered reads may overlap. Only the latest request
        // for a still-paired machine can publish data, errors or auth failures.
        const current = () => alive && revisions.current.get(t.id) === revision
          && (!t.id || !!nodesRef.current?.nodes.some(n => n.id === t.id && n.online));
        if (!t.online) { if (alive) setStates((m) => ({ ...m, [t.id]: { node: t.id, nodeName: t.name, online: false, answered: m[t.id]?.answered ?? false, error: `${t.name} is offline`, seedError: null } })); return; }
        pending.set(t.id, revision);
        try {
          const r = await apiOn<SessionsAnswer>(t.id, "/api/sessions", { signal: AbortSignal.timeout(10_000) });
          if (!current()) return;
          setByNode((m) => ({ ...m, [t.id]: r.sessions.map((s) => ({ ...s, node: t.id, nodeName: t.name })) }));
          setStates((m) => ({ ...m, [t.id]: { node: t.id, nodeName: t.name, online: true, answered: true, error: null, seedError: r.seedError ?? null } }));
        } catch (e) {
          if (!current()) return;
          setStates((m) => ({ ...m, [t.id]: { node: t.id, nodeName: t.name, online: true, answered: true, error: e instanceof Error ? e.message : String(e), errorStatus: e instanceof ApiError ? e.status : undefined, seedError: null } }));
        } finally {
          if (pending.get(t.id) === revision) pending.delete(t.id);
        }
      }));
    };
    tick();
    const iv = setInterval(() => tick(), intervalMs);
    const ws = new WebSocket(wsUrl("/api/events"));
    ws.onmessage = (m) => { try { if (JSON.parse(m.data).kind === "sessions") tick(true); } catch {} };
    const onVis = () => { if (document.visibilityState === "visible") tick(true); };
    document.addEventListener("visibilitychange", onVis);
    // a machine paired (or lost) elsewhere on the page shows up here at once, not after the next node refresh
    const unsubscribe = subscribeNodes((f) => { nodesRef.current = f; lastNodes = Date.now(); if (alive) { setNodes(f); setFleetError(null); tick(true); } });
    return () => { alive = false; clearInterval(iv); ws.close(); document.removeEventListener("visibilitychange", onVis); unsubscribe(); };
  }, [gen, intervalMs]);
  const paired = (node: string) => !node || !!nodes?.nodes.some(n => n.id === node);
  const sessions = Object.entries(byNode).filter(([node]) => paired(node)).flatMap(([, rows]) => rows);
  return {
    sessions,
    nodes,
    states: Object.values(states).filter(s => paired(s.node)),
    fleetError,
    refresh: () => setGen((g) => g + 1),
    replace: (node, next) => {
      revisions.current.set(node, (revisions.current.get(node) ?? 0) + 1);
      setByNode((m) => ({ ...m, [node]: next }));
    },
  };
}
