// Fleet-wide data for the views: the node list (shared, cached), a fan-out query that asks
// every reachable machine and keeps each machine's answer (or failure) separately, and the
// Deck overview from whichever node has the Deck checkout.
//
// Partial availability is the rule: one slow or dead peer never blanks what the others
// answered, and a node's last good answer stays on screen (marked stale) while it fails.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiOn, ApiError } from "./api";
import { rememberNodeNames } from "./navigation";
import type { Overview } from "./control";
import type { NodeAnswer, NodeRef } from "../../src/shared/fleetview";

export type FleetNode = { id: string; name: string; online: boolean; probe_device?: string | null };
export type FleetNodes = { self: { nodeId: string; name: string; commit?: string; urls?: string[] }; nodes: FleetNode[] };
/** A machine requests can go to: this one (id "") first, then every paired node. */
export type Target = NodeRef & { online: boolean; self: boolean };

// ---- /api/fleet/nodes, shared by every view on the page ----
let cache: { at: number; value: FleetNodes } | null = null;
let inflight: Promise<FleetNodes> | null = null;
const listeners = new Set<(f: FleetNodes) => void>();

export function fetchNodes(maxAgeMs = 20_000): Promise<FleetNodes> {
  if (cache && Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache.value);
  if (!inflight) {
    inflight = api<FleetNodes>("/api/fleet/nodes")
      .then((f) => {
        cache = { at: Date.now(), value: f };
        rememberNodeNames([{ id: "", name: f.self.name }, ...f.nodes]);
        listeners.forEach((l) => l(f));
        return f;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
/** Pairing flows and tests: forget the cached node list so the next read is fresh. */
export const invalidateNodes = () => { cache = null; };
/** After pairing or unpairing: re-read the node list now and tell every subscriber (views, session pollers). */
export const refreshNodes = () => { invalidateNodes(); return fetchNodes().catch(() => null); };
/** Be told whenever the node list is re-read (any view's refresh, pairing). Returns the unsubscribe. */
export function subscribeNodes(listener: (f: FleetNodes) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function targetsOf(f: FleetNodes | null, selfName = "local"): Target[] {
  return [{ id: "", name: f?.self.name ?? selfName, online: true, self: true }, ...(f?.nodes ?? []).map((n) => ({ id: n.id, name: n.name, online: n.online, self: false }))];
}

export function useFleet(intervalMs = 30_000): { fleet: FleetNodes | null; targets: Target[]; error: string | null; refresh: () => Promise<void> } {
  const [fleet, setFleet] = useState<FleetNodes | null>(cache?.value ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => fetchNodes().then((f) => { if (alive) { setFleet(f); setError(null); } }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    tick();
    const iv = setInterval(tick, intervalMs);
    const on = (f: FleetNodes) => { if (alive) setFleet(f); };
    listeners.add(on);
    return () => { alive = false; clearInterval(iv); listeners.delete(on); };
  }, [intervalMs]);
  const targets = useMemo(() => targetsOf(fleet), [fleet]);
  const refresh = async () => { invalidateNodes(); try { setFleet(await fetchNodes()); } catch {} };
  return { fleet, targets, error, refresh };
}

// ---- fan-out ----
export type NodeResult<T> = NodeAnswer<T> & { online: boolean; loading: boolean; at: number | null };

export type FleetQueryOpts = {
  intervalMs?: number;
  timeoutMs?: number;
  /** Ask only this node ("" = local); default: every online node. */
  only?: string | null;
  enabled?: boolean;
  /** Re-run when any of these change. */
  deps?: unknown[];
  /** Local 401: the page is locked out. */
  onLocked?: () => void;
};

/** Ask every reachable node for `path`. Each node's row keeps its last good answer when a refresh fails. */
export function useFleetQuery<T>(path: string, opts: FleetQueryOpts = {}): { results: NodeResult<T>[]; targets: Target[]; refresh: () => void; loading: boolean } {
  const { intervalMs = 15_000, timeoutMs = 12_000, only = null, enabled = true, deps = [], onLocked } = opts;
  const { targets } = useFleet();
  const [rows, setRows] = useState<Record<string, NodeResult<T>>>({});
  const [gen, setGen] = useState(0);
  const lockedRef = useRef(onLocked);
  lockedRef.current = onLocked;
  const wanted = useMemo(() => targets.filter((t) => only == null ? true : t.id === only), [targets, only]);
  const wantedKey = wanted.map((t) => `${t.id}:${t.online ? 1 : 0}:${t.name}`).join(",");

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const askOne = async (t: Target) => {
      if (!t.online) {
        setRows((m) => ({ ...m, [t.id]: { node: { id: t.id, name: t.name }, data: m[t.id]?.data ?? null, error: `${t.name} is offline`, online: false, loading: false, at: m[t.id]?.at ?? null } }));
        return;
      }
      setRows((m) => ({ ...m, [t.id]: { node: { id: t.id, name: t.name }, data: m[t.id]?.data ?? null, error: m[t.id]?.error ?? null, online: true, loading: true, at: m[t.id]?.at ?? null } }));
      try {
        const data = await apiOn<T>(t.id, path, { signal: AbortSignal.timeout(timeoutMs) });
        if (!alive) return;
        setRows((m) => ({ ...m, [t.id]: { node: { id: t.id, name: t.name }, data, error: null, online: true, loading: false, at: Date.now() } }));
      } catch (e) {
        if (!alive) return;
        if (t.id === "" && e instanceof ApiError && e.status === 401) lockedRef.current?.();
        const error = e instanceof Error ? e.message : String(e);
        setRows((m) => ({ ...m, [t.id]: { node: { id: t.id, name: t.name }, data: m[t.id]?.data ?? null, error, online: true, loading: false, at: m[t.id]?.at ?? null } }));
      }
    };
    const tick = () => { if (document.visibilityState === "visible") wanted.forEach(askOne); };
    tick();
    const iv = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(iv); };
  }, [path, wantedKey, enabled, gen, intervalMs, ...deps]);

  const results = useMemo(() => wanted.map((t) => rows[t.id] ?? { node: { id: t.id, name: t.name }, data: null, error: t.online ? null : `${t.name} is offline`, online: t.online, loading: t.online, at: null }), [wanted, rows]);
  const loading = results.some((r) => r.loading && r.data == null);
  return { results, targets, refresh: () => setGen((g) => g + 1), loading };
}

// ---- the Deck overview: fleet-wide content, read from the first node that has the checkout ----
export type OverviewSource = { node: string; nodeName: string };
export function useOverview(onLocked?: () => void, intervalMs = 30_000): { overview: Overview | null; source: OverviewSource | null; error: string | null; refresh: () => void } {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [source, setSource] = useState<OverviewSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  const lockedRef = useRef(onLocked);
  lockedRef.current = onLocked;
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const o = await api<Overview>("/api/control/overview");
        if (!alive) return;
        setOverview(o); setSource({ node: "", nodeName: "" }); setError(null);
        return;
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) { lockedRef.current?.(); return; }
        if (!(e instanceof ApiError && e.status === 404)) { setError(e instanceof Error ? e.message : String(e)); return; }
      }
      // No Deck checkout here: the projects are the same everywhere, so take them from a peer.
      let f: FleetNodes | null = null;
      try { f = await fetchNodes(); } catch {}
      for (const n of f?.nodes.filter((n) => n.online) ?? []) {
        try {
          const o = await apiOn<Overview>(n.id, "/api/control/overview", { signal: AbortSignal.timeout(12_000) });
          if (!alive) return;
          setOverview(o); setSource({ node: n.id, nodeName: n.name }); setError(null);
          return;
        } catch {}
      }
      if (alive) setError("No fleet dir configured on this node (set fleetDir in ~/.cyberdeck/config.json), and no paired node has one.");
    };
    load();
    const iv = setInterval(load, intervalMs);
    return () => { alive = false; clearInterval(iv); };
  }, [gen, intervalMs]);
  return { overview, source, error, refresh: () => setGen((g) => g + 1) };
}

/** Directories worth offering as a cwd, from the Deck projects (plain repo names under ~/Code). */
export function projectDirs(ov: Overview | null): string[] {
  if (!ov) return [];
  const home = ov.fleetDir.replace(/\/Code\/[^/]+$/, "");
  const dirs = new Set<string>([`${home}/Code`]);
  for (const p of ov.projects) for (const g of p.repos) if (!g.includes("*")) dirs.add(`${home}/Code/${g}`);
  return [...dirs];
}
