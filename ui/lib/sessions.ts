// Live sessions client: daemon-owned PTYs on any node. Unlike the rest of the UI,
// these helpers address nodes explicitly (the prompt bar shows every node's sessions
// at once), so they bypass the active-node scoping in api.ts.
import { useEffect, useRef, useState } from "react";
import { token, activeNode, setActiveNode, navigate, wsUrl } from "./api";
import type { Caps, Runner, Tool } from "../../src/shared/harness";

export type LiveSession = {
  id: string; title: string; cwd: string; cmd: string | null; tool: Tool; prompt: string | null; runner: Runner;
  state: "running" | "exited" | "lost"; createdAt: number; exitedAt: number | null; exitCode: number | null;
  clients: number; lastOutputAt: number | null; bells: number; busy: boolean;
  /** Added client-side: which node it lives on ("" = local). */
  node: string; nodeName: string;
};
export type FleetNode = { id: string; name: string; online: boolean };
export type FleetNodes = { self: { nodeId: string; name: string; commit?: string }; nodes: FleetNode[] };

const nodePath = (node: string, path: string) => (node ? `/api/nodes/${node}/proxy/${path.slice("/api/".length)}` : path);

/** Fetch against a specific node regardless of the UI's active node. */
export async function apiOn<T>(node: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(nodePath(node, path), { ...init, headers: { authorization: `Bearer ${token()}`, ...(init?.headers as Record<string, string>) } });
  if (!res.ok) {
    let message = `${res.status}`;
    try { message = (await res.json()).error ?? message; } catch {}
    const err = new Error(message) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const postOn = <T,>(node: string, path: string, body: unknown) => apiOn<T>(node, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchNodes = () => apiOn<FleetNodes>("", "/api/fleet/nodes");
export const listSessions = async (node: string, nodeName: string): Promise<LiveSession[]> =>
  (await apiOn<{ sessions: Omit<LiveSession, "node" | "nodeName">[] }>(node, "/api/sessions")).sessions.map((s) => ({ ...s, node, nodeName }));

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
  const path = node ? `/api/nodes/${node}/sessions/${id}/attach` : `/api/sessions/${id}/attach`;
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

/** Go to a session's terminal, switching the UI onto its node first. */
export function openSession(s: { node: string; nodeName: string; id: string }) {
  if (s.node !== activeNode()) setActiveNode(s.node, s.nodeName);
  navigate("term", { session: s.id });
}

export const toolForCmd = (cmd: string | undefined): Tool => (!cmd ? "shell" : /^claude(\s|$)/.test(cmd) ? "cc" : /^codex(\s|$)/.test(cmd) ? "cx" : "shell");

/** Create a session on a node, picking tmux when that node has it, and open it (or not). */
export async function startSession(opts: { node?: string; nodeName?: string; cwd?: string; cmd?: string; title?: string; tool?: Tool; prompt?: string; runner?: Runner; open?: boolean }): Promise<LiveSession> {
  const node = opts.node ?? activeNode();
  const nodeName = opts.nodeName ?? (node ? "node" : "local");
  const runner = opts.runner ?? ((await getCaps(node))?.tmux ? "tmux" : "pty");
  const s = await createSession(node, nodeName, { cwd: opts.cwd, cmd: opts.cmd, title: opts.title, tool: opts.tool ?? toolForCmd(opts.cmd), prompt: opts.prompt, runner });
  if (opts.open !== false) openSession(s);
  return s;
}

/** All live sessions across this node and every online peer, refreshed every few seconds and on session events. */
export function useLiveSessions(intervalMs = 4000): { sessions: LiveSession[]; nodes: FleetNodes | null; refresh: () => void } {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [nodes, setNodes] = useState<FleetNodes | null>(null);
  const nodesRef = useRef<FleetNodes | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    let alive = true;
    let lastNodes = 0;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      if (!nodesRef.current || Date.now() - lastNodes > 30_000) {
        try { nodesRef.current = await fetchNodes(); lastNodes = Date.now(); if (alive) setNodes(nodesRef.current); } catch {}
      }
      const f = nodesRef.current;
      const targets = [{ id: "", name: f?.self.name ?? "local" }, ...(f?.nodes.filter((n) => n.online) ?? [])];
      const results = await Promise.all(targets.map((t) => listSessions(t.id, t.name).catch(() => [] as LiveSession[])));
      if (alive) setSessions(results.flat());
    };
    tick();
    const iv = setInterval(tick, intervalMs);
    const ws = new WebSocket(wsUrl("/api/events"));
    ws.onmessage = (m) => { try { if (JSON.parse(m.data).kind === "sessions") tick(); } catch {} };
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(iv); ws.close(); document.removeEventListener("visibilitychange", onVis); };
  }, [gen, intervalMs]);
  return { sessions, nodes, refresh: () => setGen((g) => g + 1) };
}
