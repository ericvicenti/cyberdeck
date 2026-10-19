// Section-local machine choice. Views whose content lives on one machine (Files, a new
// terminal, cmux, the remote browser, the desktop) put this next to the thing it scopes; it
// is the only place a node is chosen, so nothing fetches against a machine you cannot see named.
import type { Target } from "../lib/fleet";
import type { NodeHealth } from "../../src/shared/fleetview";

export function NodePicker({ value, onChange, targets, testId, title, all, className = "" }: { value: string; onChange: (node: string) => void; targets: Target[]; testId?: string; title?: string; /** Offer an "every machine" option (value "*"). */ all?: string; className?: string }) {
  const known = targets.some((t) => t.id === value) || (all && value === "*");
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
      title={title ?? "machine"}
      className={`rounded-sm border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] uppercase tracking-wider text-zinc-300 outline-none focus:border-sky-500/60 ${className}`}
    >
      {all && <option value="*">{all}</option>}
      {!known && <option value={value}>{value} (unknown machine)</option>}
      {targets.map((t) => (
        <option key={t.id} value={t.id} disabled={!t.online}>
          {t.name}{t.self ? " (this machine)" : t.online ? "" : " (offline)"}
        </option>
      ))}
    </select>
  );
}

/** A small badge naming the machine a row came from. */
export const NodeTag = ({ name, self }: { name: string; self?: boolean }) => (
  <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] uppercase tracking-wider ${self ? "bg-zinc-800 text-zinc-500" : "bg-violet-500/10 text-violet-300"}`} data-testid="node-tag">{name}</span>
);

const LED: Record<NodeHealth["state"], string> = { ok: "led-on", stale: "led-warn", error: "led-err", offline: "led-off", loading: "led-warn" };
/** One chip per machine: answered, showing an earlier answer, failed, or offline. Only error states carry text. */
export function NodeStrip({ health, testId = "node-strip" }: { health: NodeHealth[]; testId?: string }) {
  if (health.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      {health.map((h) => (
        <span key={h.node.id} className="hud-chip text-zinc-400" title={h.error ?? h.node.name} data-testid={`node-health-${h.node.name}`} data-state={h.state}>
          <span className={`led ${LED[h.state]}`} />
          {h.node.name}
          {h.state === "stale" && <span className="text-amber-300/80"> · stale</span>}
          {h.state === "error" && <span className="text-red-300/80"> · {h.error?.slice(0, 40)}</span>}
          {h.state === "offline" && <span className="text-zinc-600"> · offline</span>}
        </span>
      ))}
    </div>
  );
}
