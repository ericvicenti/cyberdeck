// Primitives for the home dashboard: a card shell, severity meters, a stacked
// status bar and a small grouped-bar activity chart. Colors come from the HUD
// theme tokens; the fill of a meter carries severity and its track is a lighter
// step of the same color, text always wears the text tokens.
import { useState, type ReactNode } from "react";

export const HUD = {
  cyan: "#22d3ee",
  magenta: "#e879f9",
  green: "#a3e635",
  amber: "#fbbf24",
  red: "#fb7185",
  dim: "#3a4259",
} as const;

export type Severity = "ok" | "warn" | "bad" | "off";
export const SEV_COLOR: Record<Severity, string> = { ok: HUD.green, warn: HUD.amber, bad: HUD.red, off: HUD.dim };
/** Fullness → severity with the thresholds most quota bars use. */
export const severity = (percent: number | null, warnAt = 60, badAt = 85): Severity => (percent == null ? "off" : percent >= badAt ? "bad" : percent >= warnAt ? "warn" : "ok");

export function Widget(props: { title: string; meta?: ReactNode; tone?: "cyan" | "magenta" | "green" | "red"; onClick?: () => void; className?: string; testId?: string; children: ReactNode }) {
  const tone = props.tone && props.tone !== "cyan" ? `hud-${props.tone}` : "";
  return (
    <section className={`hud-card flex flex-col p-4 ${tone} ${props.className ?? ""}`} data-testid={props.testId}>
      <div className="flex items-baseline justify-between gap-2">
        {props.onClick ? (
          <button onClick={props.onClick} className="hud-label neon hover:underline">{props.title}</button>
        ) : (
          <div className="hud-label neon">{props.title}</div>
        )}
        {props.meta && <div className="truncate text-[10px] text-zinc-500">{props.meta}</div>}
      </div>
      <div className="mt-3 flex-1">{props.children}</div>
    </section>
  );
}

/** One quota / fullness bar. `percent` null renders an empty track. */
export function Meter(props: { label: ReactNode; percent: number | null; right?: ReactNode; sev?: Severity; active?: boolean; testId?: string }) {
  const sev = props.sev ?? severity(props.percent);
  const color = SEV_COLOR[sev];
  const width = props.percent == null ? 0 : Math.max(props.percent > 0 ? 1 : 0, Math.min(100, props.percent));
  return (
    <div className="py-1" data-testid={props.testId}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-zinc-300">
          {props.active && <span className="led led-run" title="the limit currently in effect" />}
          {props.label}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-zinc-400">{props.right ?? (props.percent == null ? "—" : `${props.percent}%`)}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm" style={{ background: sev === "off" ? "rgba(58,66,89,0.35)" : `color-mix(in srgb, ${color} 16%, transparent)` }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.percent ?? undefined}>
        <div className="h-full rounded-sm transition-[width] duration-500" style={{ width: `${width}%`, background: color, boxShadow: sev === "off" ? "none" : `0 0 6px ${color}` }} />
      </div>
    </div>
  );
}

/** Part-to-whole bar for status counts (2px surface gaps between segments). */
export function StackBar(props: { parts: { label: string; value: number; color: string }[]; total?: number }) {
  const total = props.total ?? props.parts.reduce((n, p) => n + p.value, 0);
  const shown = props.parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-sm bg-zinc-950/70" role="img" aria-label={props.parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
        {total === 0 ? <div className="h-full w-full bg-zinc-800" /> : shown.map((p) => <div key={p.label} title={`${p.label}: ${p.value}`} className="h-full rounded-[1px]" style={{ width: `${(p.value / total) * 100}%`, background: p.color, boxShadow: `0 0 6px ${p.color}66` }} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-400">
        {props.parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: p.color }} />
            {p.label} <span className="font-mono tabular-nums text-zinc-300">{p.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export type Series = { key: string; label: string; color: string };

/** Grouped bars per day for a handful of series (agent prompts per day). Hover a day for its values. */
export function DayBars(props: { days: { date: string; [k: string]: number | string }[]; series: Series[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const H = props.height ?? 56;
  const n = props.days.length;
  const W = 300;
  const slot = W / Math.max(1, n);
  const gap = 2;
  const barW = Math.max(2, (slot - gap * (props.series.length + 1)) / props.series.length);
  const max = Math.max(1, ...props.days.flatMap((d) => props.series.map((s) => Number(d[s.key]) || 0)));
  const focus = hover == null ? null : props.days[hover];
  const fmtDay = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div>
      <div className="flex items-baseline justify-between text-[10px] text-zinc-500">
        <span>{focus ? fmtDay(focus.date) : `${fmtDay(props.days[0]?.date ?? new Date().toISOString().slice(0, 10))} – today`}</span>
        <span className="font-mono tabular-nums text-zinc-300">
          {focus
            ? props.series.map((s) => `${s.label} ${Number(focus[s.key]) || 0}`).join(" · ")
            : props.series.map((s) => `${s.label} ${props.days.reduce((t, d) => t + (Number(d[s.key]) || 0), 0)}`).join(" · ")}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 2}`} className="mt-1 h-16 w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)} role="img" aria-label="prompts per day">
        <line x1={0} x2={W} y1={H + 1} y2={H + 1} stroke="rgba(34,211,238,0.22)" strokeWidth={1} />
        {props.days.map((d, i) => (
          <g key={d.date}>
            {props.series.map((s, j) => {
              const v = Number(d[s.key]) || 0;
              const h = v === 0 ? 0 : Math.max(2, (v / max) * H);
              const x = i * slot + gap + j * (barW + gap);
              return <rect key={s.key} x={x} y={H - h + 1} width={barW} height={h} rx={1.5} fill={s.color} opacity={hover == null || hover === i ? 0.95 : 0.4} />;
            })}
            <rect x={i * slot} y={0} width={slot} height={H + 2} fill={hover === i ? "rgba(34,211,238,0.07)" : "transparent"} onMouseEnter={() => setHover(i)}>
              <title>{`${fmtDay(d.date)}: ${props.series.map((s) => `${s.label} ${Number(d[s.key]) || 0}`).join(", ")}`}</title>
            </rect>
          </g>
        ))}
      </svg>
      <div className="mt-1 flex gap-3 text-[10px] text-zinc-400">
        {props.series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** "in 2h 14m" / "in 3d 4h" until an ISO timestamp; "" when past or missing. */
export function fmtIn(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export const fmtInt = (n: number) => n.toLocaleString();
