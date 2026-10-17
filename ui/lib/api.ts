import { readRoute, updateParams } from "./navigation";
export { parseHash, navigate, updateParams, routeHash, type Route } from "./navigation";
export const token = () => localStorage.getItem("cyberdeck-token") ?? "";

// ---- active node: "" = local, otherwise a paired node id. All API helpers
// route through the local daemon's proxy when a remote node is active. ----
export const activeNode = (): string => readRoute().params.get("node") ?? "";
const nodeNames = new Map<string, string>();
export const activeNodeName = (): string => nodeNames.get(activeNode()) ?? activeNode();
export function rememberNodeNames(nodes: { id: string; name: string }[]) {
  for (const node of nodes) nodeNames.set(node.id, node.name);
}

export function setActiveNode(id: string, name: string): void {
  nodeNames.set(id, name);
  updateParams({ node: id });
}

/** Map "/api/<rest>" onto the active node (via proxy) or leave local. */
export function scoped(path: string): string {
  const node = activeNode();
  if (!node || !path.startsWith("/api/")) return path;
  if (path.startsWith("/api/fleet") || path.startsWith("/api/nodes/")) return path; // fleet mgmt is always local
  return `/api/nodes/${encodeURIComponent(node)}/proxy/${path.slice("/api/".length)}`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** `local: true` always talks to the daemon serving this page, even when a remote node is active. */
export type ApiInit = RequestInit & { local?: boolean };

export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const { local, ...rest } = init ?? {};
  const res = await fetch(local ? path : scoped(path), {
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

export const post = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const wsUrl = (path: string, params: Record<string, string> = {}): string => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ token: token(), ...params });
  return `${proto}://${location.host}${scoped(path)}?${q}`;
};

/** Terminal WS path, node-aware (/api/term locally, /api/nodes/:id/term remotely). */
export const termWsUrl = (params: Record<string, string> = {}): string => {
  const node = activeNode();
  const path = node ? `/api/nodes/${encodeURIComponent(node)}/term` : "/api/term";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ token: token(), ...params });
  return `${proto}://${location.host}${path}?${q}`;
};

/** Remote-browser screencast WS, node-aware (/api/browser/:p/stream locally, /api/nodes/:id/browser/:p/stream remotely). */
export const browserWsUrl = (profile: string): string => {
  const node = activeNode();
  const path = node ? `/api/nodes/${encodeURIComponent(node)}/browser/${encodeURIComponent(profile)}/stream` : `/api/browser/${encodeURIComponent(profile)}/stream`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}?${new URLSearchParams({ token: token() })}`;
};

export const rawUrl = (path: string, params: Record<string, string> = {}): string =>
  `${scoped(path)}?${new URLSearchParams({ ...params, token: token() })}`;

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
