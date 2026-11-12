import { useEffect, useState } from "react";
import type { DiskInfo } from "../../src/daemon/api/dashboard";
import { apiOn, ApiError, fmtBytes, navigate } from "../lib/api";
import { useFleet } from "../lib/fleet";
import { findStorageDisk, storageWarning } from "../lib/storage";
import { Meter, severity } from "../components/Widgets";

export function Storage({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const { fleet } = useFleet();
  const requested = params.get("node") ?? "";
  const node = requested === "self" ? "" : requested;
  const filesystem = params.get("filesystem");
  const mount = params.get("mount");
  const peer = fleet?.nodes.find((n) => n.id === node);
  const name = node ? peer?.name ?? node : fleet?.self.name ?? "this machine";
  const offline = !!node && !!peer && !peer.online;
  const unknown = !!node && !!fleet && !peer;
  const [reading, setReading] = useState<{ node: string; disks: DiskInfo[]; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (offline || unknown) { setLoading(false); return () => { active = false; }; }
    const load = async () => {
      try {
        const result = await apiOn<{ at: number; disks: DiskInfo[] }>(node, "/api/disks");
        if (active) { setReading({ node, ...result }); setError(null); setLoading(false); }
      } catch (e) {
        if (active) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); if (!node && e instanceof ApiError && e.status === 401) onLocked(); }
      }
    };
    setLoading(true);
    load();
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [node, offline, unknown]);

  const current = reading?.node === node ? reading : null;
  const disk = current && filesystem !== null && mount !== null ? findStorageDisk(current.disks, filesystem, mount) : null;
  const warning = disk && storageWarning(disk);
  const unavailable = unknown ? "Machine is not paired" : offline ? "Machine is offline" : error ? `Storage unavailable: ${error}` : loading ? "Loading storage…" : !filesystem || mount === null ? "No storage item selected" : "This storage item is no longer reported by this machine";

  return <main className="mx-auto max-w-5xl space-y-5 p-4 md:p-7" data-testid="storage-detail">
    <div className="flex items-center gap-2 text-xs text-zinc-500"><button className="hover:text-sky-300" onClick={() => navigate("fleet")}>Fleet</button><span>/</span><span>{name}</span><span>/</span><span>Storage</span></div>
    <header><h1 className="text-2xl font-semibold text-zinc-100">{disk?.mount ?? mount ?? "Storage"}</h1><p className="mt-1 text-sm text-zinc-400">{name} · storage detail</p></header>
    {disk && !offline && !unknown ? <>
      {error && <p role="status" className="rounded border border-amber-600/40 p-3 text-sm text-amber-300">Latest reading unavailable: {error}. Showing last reading.</p>}
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
      <p className="text-xs text-zinc-500">Reported {new Date(current!.at).toLocaleString()} by {name}. Capacity is the reported filesystem/pool view, not a sum of partitions.</p>
    </> : <section className="hud-card p-5 text-sm text-zinc-400" role="status" data-testid="storage-unavailable">{unavailable}</section>}
  </main>;
}
