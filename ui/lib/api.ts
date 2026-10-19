export { parseHash, navigate, updateParams, routeHash, type Route } from "./navigation";
export const token = () => localStorage.getItem("cyberdeck-token") ?? "";

// ---- node addressing ----
// Every request names the machine it is for. "" is the daemon serving this page; any
// other value is a paired node id, reached through that daemon's authenticated proxy
// (/api/nodes/:id/proxy/...). There is no page-wide "active node": a view that is bound
// to one machine carries it in its own URL (`?node=<id>`) or picks it in place, and a
// view that spans the fleet asks every machine (ui/lib/fleet.ts).
export type NodeId = string;

/** Map "/api/<rest>" onto a node ("" = local). Fleet management routes are always local. */
export function nodePath(node: NodeId, path: string): string {
  if (!node || !path.startsWith("/api/")) return path;
  if (path.startsWith("/api/fleet") || path.startsWith("/api/nodes/")) return path;
  return `/api/nodes/${encodeURIComponent(node)}/proxy/${path.slice("/api/".length)}`;
}

/** The node a view's URL names ("" when absent = this machine). */
export const routeNode = (params: URLSearchParams): NodeId => params.get("node") ?? "";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** `node`: which machine answers (default "" = the daemon serving this page). */
export type ApiInit = RequestInit & { node?: NodeId };

export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const { node = "", ...rest } = init ?? {};
  const res = await fetch(nodePath(node, path), {
    ...rest,
    headers: { authorization: `Bearer ${token()}`, ...rest.headers },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {}
    throw new ApiError(res.status, message);
  }
  return res.json();
}

/** Fetch against a specific node. */
export const apiOn = <T,>(node: NodeId, path: string, init?: RequestInit): Promise<T> => api<T>(path, { ...init, node });

export const post = <T,>(path: string, body: unknown, node: NodeId = ""): Promise<T> =>
  api<T>(path, {
    node,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
export const postOn = <T,>(node: NodeId, path: string, body: unknown): Promise<T> => post<T>(path, body, node);

/** WebSocket URL on this daemon (the event bus and other local-only sockets). */
export const wsUrl = (path: string, params: Record<string, string> = {}): string => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ token: token(), ...params });
  return `${proto}://${location.host}${path}?${q}`;
};

/** Ephemeral terminal WS (/api/term locally, /api/nodes/:id/term on a peer). */
export const termWsUrl = (params: Record<string, string> = {}, node: NodeId = ""): string =>
  wsUrl(node ? `/api/nodes/${encodeURIComponent(node)}/term` : "/api/term", params);

/** Remote-browser screencast WS (/api/browser/:p/stream locally, /api/nodes/:id/browser/:p/stream on a peer). */
export const browserWsUrl = (profile: string, node: NodeId = ""): string =>
  wsUrl(node ? `/api/nodes/${encodeURIComponent(node)}/browser/${encodeURIComponent(profile)}/stream` : `/api/browser/${encodeURIComponent(profile)}/stream`);

/** Desktop stream WS (/api/desktop/stream locally, /api/nodes/:id/desktop/stream on a peer). */
export const desktopWsUrl = (params: Record<string, string> = {}, node: NodeId = ""): string =>
  wsUrl(node ? `/api/nodes/${encodeURIComponent(node)}/desktop/stream` : "/api/desktop/stream", params);

/** A plain URL (for <img>, <a download>, <video>) on a node, token in the query. */
export const rawUrl = (path: string, params: Record<string, string> = {}, node: NodeId = ""): string =>
  `${nodePath(node, path)}?${new URLSearchParams({ ...params, token: token() })}`;

// ---- formatting ----
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtAgo(ms: number | null): string {
  if (!ms) return "—";
  const d = Date.now() - ms;
  const days = Math.floor(d / 86400000);
  if (days > 365) return `${Math.floor(days / 365)}y ago`;
  if (days > 30) return `${Math.floor(days / 30)}mo ago`;
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(d / 3600000);
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(d / 60000);
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

/** 0o755 -> "rwxr-xr-x" */
export function fmtMode(mode: number): string {
  const rwx = (bits: number) =>
    `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  return rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
}

export const fmtOctal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, "0");
