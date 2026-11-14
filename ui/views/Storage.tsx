import { useEffect, useState } from "react";
import type { DiskInfo } from "../../src/daemon/api/dashboard";
import { apiOn, ApiError, fmtBytes, navigate } from "../lib/api";
import { useFleet } from "../lib/fleet";
import { findStorageDisk, storageWarning } from "../lib/storage";
import { Meter, severity } from "../components/Widgets";
import { readRoute, routeHash, useRouteTitle, writeRoute } from "../lib/navigation";

export function Storage({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const { fleet, error: fleetError, refresh: refreshFleet } = useFleet();
  const requested = params.get("node") ?? "";
  const node = requested === "self" ? "" : requested;
  const filesystem = params.get("filesystem");
  const mount = params.get("mount");
  const peer = fleet?.nodes.find((n) => n.id === node);
  const name = node ? peer?.name ?? node : fleet?.self.name ?? "this machine";
  const offline = !!node && !!peer && !peer.online;
  const unknown = !!node && !!fleet && !peer;
  const invalid = [filesystem, mount].some(value => value !== null && (value.length > 4096 || /[\u0000-\u001f]/.test(value))) || node.length > 512 || /[\u0000-\u001f]/.test(node);
  const selected = !!filesystem && !!mount && !invalid;
  const ready = !node || !!fleet;
  const eligible = selected && ready && !offline && !unknown;
  const [attempt, retry] = useState(0);
  const [reading, setReading] = useState<{ node: string; disks?: DiskInfo[]; at?: number; error?: unknown; pending: boolean }>();
  const current = reading?.node === node ? reading : undefined;
  const error = current?.error;
  const errorText = error instanceof Error ? error.message : String(error || "");
  const status = (error as { status?: number })?.status;
  const loading = eligible && (!current || current.pending);

  useEffect(() => {
    if (location.hash !== routeHash("storage", params)) return;
    const canonical = new URLSearchParams(params);
    canonical.set("node", requested || "self");
    for (const key of ["filesystem", "mount"]) {
      const value = params.get(key);
      if (value) canonical.set(key, value); else canonical.delete(key);
    }
    writeRoute("storage", canonical, "replace");
  }, [params.toString()]);

  useEffect(() => {
    let active = true, generation = 0;
    if (!eligible) return;
    const ownsNode = () => {
      const route = readRoute(), requested = route.params.get("node") || "self";
      return route.view === "storage" && (requested === "self" ? "" : requested) === node;
    };
    const load = async () => {
      const request = ++generation;
      setReading(previous => ({ ...(previous?.node === node ? previous : {}), node, pending: true, error: undefined }));
      try {
        let result: { at: number; disks: DiskInfo[] };
        try { result = await apiOn(node, "/api/disks"); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          // Older running daemons already include these readings in dashboard.
          // Keep their sessions alive instead of requiring a service restart.
          if (!active || request !== generation || !ownsNode()) return;
          result = await apiOn(node, "/api/dashboard");
        }
        const valid = Number.isFinite(result?.at) && Array.isArray(result.disks) && result.disks.every(disk => disk && typeof disk.filesystem === "string" && typeof disk.mount === "string" && Array.isArray(disk.paths) && disk.paths.every(path => typeof path === "string") && [disk.totalBytes, disk.usedBytes, disk.freeBytes, disk.percent].every(Number.isFinite) && (!disk.trend || [disk.trend.lossPerDay, disk.trend.samples, disk.trend.spanDays].every(Number.isFinite)));
        if (!valid) throw new ApiError(502, "Invalid storage response");
        if (active && request === generation && ownsNode()) setReading({ node, ...result, pending: false });
      } catch (error) {
        if (active && request === generation && ownsNode()) {
          setReading(previous => ({ ...(previous?.node === node ? previous : {}), node, error, pending: false }));
          if (!node && error instanceof ApiError && error.status === 401) onLocked();
        }
      }
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [node, eligible, attempt]);

  const disk = current?.disks && selected ? findStorageDisk(current.disks, filesystem!, mount!) : null;
  const warning = disk && storageWarning(disk);
  const unavailable = invalid ? "Invalid storage link" : !selected ? "No storage item selected" : unknown ? "Machine is not paired" : offline ? "Machine is offline" : !ready ? fleetError ? `Machine list unavailable: ${fleetError}` : "Loading machine…" : error ? `Storage unavailable: ${errorText}` : loading ? "Loading storage…" : "This storage item is no longer reported by this machine";
  const title = invalid ? "Invalid storage link" : !selected ? `No storage item selected · Storage · ${name}` : unknown ? `Machine not paired · Storage · ${name}` : offline ? `Machine offline · Storage · ${name}` : !ready ? fleetError ? "Machine list unavailable · Storage" : "Loading machine · Storage" : error ? `${status === 401 || status === 403 ? "Storage access denied" : "Storage unavailable"} · ${name}` : loading && !disk ? `Loading storage · ${name}` : !disk ? `Storage item not found · ${name}` : `${mount} · Storage · ${name}`;
  useRouteTitle(title);

  return <main className="mx-auto max-w-5xl space-y-5 p-4 md:p-7" data-testid="storage-detail">
    <div className="flex items-center gap-2 text-xs text-zinc-500"><button className="hover:text-sky-300" onClick={() => navigate("fleet")}>Fleet</button><span>/</span><span>{name}</span><span>/</span><span>Storage</span></div>
    <header><h1 className="text-2xl font-semibold text-zinc-100">{disk?.mount ?? mount ?? "Storage"}</h1><p className="mt-1 text-sm text-zinc-400">{name} · storage detail</p></header>
    {disk && !offline && !unknown ? <>
      {error && <p role="status" className="rounded border border-amber-600/40 p-3 text-sm text-amber-300">Latest reading unavailable: {errorText}. Showing last reading. <button type="button" className="ml-2 min-h-11 rounded border border-amber-600/40 px-3" disabled={loading} onClick={() => retry(value => value + 1)}>Retry</button></p>}
      <section className="hud-card space-y-5 p-5" aria-label="Storage capacity">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">{([
          ["Capacity", fmtBytes(disk.totalBytes)], ["Used", fmtBytes(disk.usedBytes)], ["Free", fmtBytes(disk.freeBytes)], ["Utilization", `${disk.percent}%`],
        ] as const).map(([label, value]) => <div key={label}><div className="hud-label">{label}</div><div className="mt-2 text-lg font-mono text-zinc-100">{value}</div></div>)}</div>
        <Meter label="Utilization" percent={disk.percent} sev={severity(disk.percent, 80, 90)} right={`${disk.percent}%`} />
      </section>
      <section className={`hud-card p-5 ${warning?.level === "bad" ? "border-red-500/50" : warning?.level === "warn" ? "border-amber-500/50" : ""}`} role="status" data-testid="storage-warning">
        <div className="hud-label">Health</div><p className={`mt-2 text-sm ${warning?.level === "bad" ? "text-red-400" : warning?.level === "warn" ? "text-amber-400" : "text-emerald-400"}`}>{warning?.text}</p>
        {disk.trend && <p className="mt-2 text-xs text-zinc-400">{disk.trend.lossPerDay > 0 ? `Losing ${fmtBytes(disk.trend.lossPerDay)} per day` : disk.trend.lossPerDay < 0 ? `Gaining ${fmtBytes(-disk.trend.lossPerDay)} per day` : "Space steady"} · {disk.trend.samples} samples over {disk.trend.spanDays.toFixed(1)} days</p>}
      </section>
      <section className="hud-card grid gap-3 p-5 text-sm sm:grid-cols-2" aria-label="Storage identity">
        <div><div className="hud-label">Filesystem / device</div><div className="mt-1 break-all font-mono text-zinc-200">{disk.filesystem}</div></div>
        <div><div className="hud-label">Mount</div><div className="mt-1 break-all font-mono text-zinc-200">{disk.mount}</div></div>
        {disk.paths.length > 1 && <div className="sm:col-span-2"><div className="hud-label">Paths on this volume</div><div className="mt-1 break-all font-mono text-zinc-300">{disk.paths.join(" · ")}</div></div>}
      </section>
      <p className="text-xs text-zinc-500">Reported {new Date(current!.at!).toLocaleString()} by {name}. Capacity is the reported filesystem/pool view, not a sum of partitions.</p>
    </> : <section className="hud-card p-5 text-sm text-zinc-400" role={error || !ready && fleetError || invalid || unknown || offline || selected && ready && !loading ? "alert" : "status"} data-testid="storage-unavailable"><p>{unavailable}</p>{(error && eligible || !ready && fleetError) ? <button type="button" className="mt-3 min-h-11 rounded border border-zinc-600 px-3 py-2 hover:text-sky-300" disabled={loading} onClick={() => !ready ? refreshFleet() : retry(value => value + 1)}>Retry</button> : null}</section>}
  </main>;
}
