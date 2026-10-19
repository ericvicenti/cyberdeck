import { updateParams } from "../lib/navigation";
import { useEffect, useMemo, useState } from "react";
import { apiOn, wsUrl, fmtAgo, navigate } from "../lib/api";
import { useFleetQuery } from "../lib/fleet";
import { unionByNode, nodeHealth } from "../../src/shared/fleetview";
import { NodePicker, NodeStrip, NodeTag } from "../components/NodePicker";

type Remote = { name: string; url: string };
type Repo = {
  id: number;
  path: string;
  name: string;
  head_branch: string | null;
  dirty_files: number;
  untracked_files: number;
  stashes: number;
  ahead: number;
  behind: number;
  remotes: Remote[];
  last_commit_at: number | null;
  junk_bytes: number;
  risk: "safe" | "attention" | "at-risk";
  risk_reasons: string[];
};
type Status = {
  nodeName: string;
  version: string;
  roots: string[];
  scanning: boolean;
  repos: number | null;
  atRisk: number | null;
  attention: number | null;
  safe: number | null;
  junkBytes: number | null;
  dataBytes: number | null;
  dataCacheBytes: number | null;
  dataScanning: boolean;
  watching: boolean;
  lastScanAt: number | null;
};
type DataDir = {
  id: number;
  root: string;
  path: string;
  name: string;
  kind: "data" | "cache";
  size_bytes: number;
  cache_bytes: number;
  mtime: number | null;
};

function fmtGB(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const RISK_STYLES: Record<Repo["risk"], string> = {
  "at-risk": "bg-red-500/15 text-red-400 ring-red-500/30",
  attention: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  safe: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
};

function StatCard(props: { label: string; value: string; tone?: "red" | "amber" | "green" | "neutral" }) {
  const tones = { red: "text-red-400", amber: "text-amber-400", green: "text-emerald-400", neutral: "text-zinc-100" };
  return (
    <div className="hud-card px-5 py-4">
      <div className={`hud-stat ${tones[props.tone ?? "neutral"]}`}>{props.value}</div>
      <div className="hud-label mt-2">{props.label}</div>
    </div>
  );
}

/** `?node=` filter: absent = every machine, `self` = this machine, else a paired node id. */
const SELF = "self";
const filterOf = (params: URLSearchParams): string | null => { const n = params.get("node"); return n == null || n === "" ? null : n === SELF ? "" : n; };

/** Repos and data directories on every machine, each row tagged with its machine, with a
 *  machine filter in the view (no page-wide selection). */
export function Data({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const only = filterOf(params);
  const statusQ = useFleetQuery<Status>("/api/status", { intervalMs: 10_000, only, onLocked });
  const reposQ = useFleetQuery<Repo[]>("/api/repos", { intervalMs: 30_000, only, onLocked });
  const dataQ = useFleetQuery<{ dirs: DataDir[] }>("/api/data", { intervalMs: 30_000, only, onLocked });
  const dataRoot = params.get("root") ?? "", filter = params.get("q") ?? "";
  const setDataRoot = (root: string) => updateParams({ root });
  const setFilter = (q: string) => updateParams({ q }, "edit");
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  // this machine pushes scan progress over the event bus; peers are covered by the poll
  useEffect(() => {
    const ws = new WebSocket(wsUrl("/api/events"));
    ws.onmessage = (msg) => {
      const ev = JSON.parse(msg.data);
      if (ev.kind === "scan:progress") setScanProgress({ done: ev.done, total: ev.total });
      if (ev.kind === "scan:done" || ev.kind === "scan:failed" || ev.kind === "datascan:done") {
        setScanProgress(null);
        statusQ.refresh(); reposQ.refresh(); dataQ.refresh();
      }
    };
    return () => ws.close();
  }, []);

  const statuses = statusQ.results.filter((r) => r.data).map((r) => ({ node: r.node, s: r.data! }));
  const repos = useMemo(() => unionByNode(reposQ.results, (r) => r.path), [reposQ.results]);
  const dataDirs = useMemo(() => unionByNode(dataQ.results.map((r) => ({ ...r, data: r.data?.dirs ?? null })), (d) => d.path), [dataQ.results]);
  const health = useMemo(() => nodeHealth(reposQ.results), [reposQ.results]);
  const sum = (f: (s: Status) => number | null) => (statuses.length ? statuses.reduce((a, x) => a + (f(x.s) ?? 0), 0) : null);
  const anyScanning = statuses.some((x) => x.s.scanning || x.s.dataScanning);
  const lastScan = statuses.reduce<number | null>((a, x) => (x.s.lastScanAt && (a == null || x.s.lastScanAt > a) ? x.s.lastScanAt : a), null);
  const selfName = statusQ.targets[0]?.name ?? "";

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    const order = { "at-risk": 0, attention: 1, safe: 2 };
    return repos
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) || r.nodeName.toLowerCase().includes(q))
      .sort((a, b) => order[a.risk] - order[b.risk] || (b.last_commit_at ?? 0) - (a.last_commit_at ?? 0));
  }, [repos, filter]);
  const machines = only == null ? health.length : 1;
  // a root chip is `${node}:${root}` when several machines answer, else the plain path (and `root=<path>` links match any machine)
  const rootKey = (d: { node: string; root: string }) => (machines > 1 ? `${d.node}:${d.root}` : d.root);
  const roots = useMemo(() => [...new Set(dataDirs.map((d) => `${d.node}:${d.root}`))].map((k) => { const i = k.indexOf(":"); const node = k.slice(0, i); const root = k.slice(i + 1); return { key: rootKey({ node, root }), node, root, nodeName: dataDirs.find((d) => d.node === node)?.nodeName ?? "" }; }), [dataDirs, machines]);
  const shownDirs = dataDirs.filter((d) => !dataRoot || `${d.node}:${d.root}` === dataRoot || d.root === dataRoot).sort((a, b) => b.size_bytes - a.size_bytes);
  const scanTargets = statusQ.targets.filter((t) => t.online && (only == null || t.id === only));

  return (
    <div className="h-full overflow-auto">
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">Data</h1>
          <p className="text-xs text-zinc-500">
            {statuses.length ? `${machines} machine${machines === 1 ? "" : "s"}${statuses.some((x) => x.s.watching) ? " · auto-rescan on changes" : ""} · scanned ${fmtAgo(lastScan)}` : statusQ.loading ? "asking every machine…" : "no machine answered"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {scanMsg && <span className="text-[11px] text-amber-400/90" data-testid="data-scan-msg">{scanMsg}</span>}
          <NodeStrip health={health} testId="data-nodes" />
          {statusQ.targets.length > 1 && (
            <NodePicker value={only == null ? "*" : only === "" ? SELF : only} onChange={(v) => navigate("data", { node: v === "*" ? "" : v === "" ? SELF : v })} targets={statusQ.targets.map((t) => (t.id === "" ? { ...t, id: SELF } : t))} all="every machine" testId="data-node" title="which machine's data" />
          )}
          {scanProgress && (
            <span className="text-xs tabular-nums text-zinc-400">
              scanning {scanProgress.done}/{scanProgress.total}
            </span>
          )}
          <button
            onClick={async () => {
              setScanMsg(null);
              const failed = (await Promise.all(scanTargets.map((t) => apiOn(t.id, "/api/scan", { method: "POST" }).then(() => null, (e) => `${t.name}: ${e instanceof Error ? e.message : e}`)))).filter((x): x is string => !!x);
              if (failed.length) setScanMsg(`scan not started on ${failed.join(", ")}`);
            }}
            disabled={!!scanProgress || anyScanning}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            title={scanTargets.length > 1 ? `rescan ${scanTargets.map((t) => t.name).join(", ")}` : `rescan ${scanTargets[0]?.name ?? selfName}`}
          >
            {scanProgress || anyScanning ? "Scanning…" : scanTargets.length > 1 ? "Scan all" : "Scan now"}
          </button>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 sm:gap-3">
        <StatCard label="repos" value={String(sum((s) => s.repos) ?? "—")} />
        <StatCard label="at risk" value={String(sum((s) => s.atRisk) ?? "—")} tone={sum((s) => s.atRisk) ? "red" : "green"} />
        <StatCard label="attention" value={String(sum((s) => s.attention) ?? "—")} tone={sum((s) => s.attention) ? "amber" : "green"} />
        <StatCard label="user data" value={sum((s) => s.dataBytes) ? fmtGB(sum((s) => s.dataBytes)!) : "—"} />
        <StatCard label="app caches" value={sum((s) => s.dataCacheBytes) ? fmtGB(sum((s) => s.dataCacheBytes)!) : "—"} tone="amber" />
        <StatCard label="repo junk" value={sum((s) => s.junkBytes) ? fmtGB(sum((s) => s.junkBytes)!) : "—"} />
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">User data</h2>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setDataRoot("")}
              className={`rounded-full px-2.5 py-1 text-[11px] ${dataRoot === "" ? "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              all
            </button>
            {roots.map((r) => (
              <button
                key={r.key}
                onClick={() => setDataRoot(r.key === dataRoot ? "" : r.key)}
                className={`rounded-full px-2.5 py-1 text-[11px] ${dataRoot === r.key ? "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30" : "text-zinc-500 hover:text-zinc-300"}`}
                title={`${r.root} on ${r.nodeName}`}
              >
                {r.root.split("/").pop()}{machines > 1 ? <span className="ml-1 text-zinc-600">@{r.nodeName}</span> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800" data-testid="data-table">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/70 text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Item</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Location</th>
                <th className="px-4 py-2.5 font-medium text-right">Size</th>
                <th className="hidden px-4 py-2.5 font-medium text-right sm:table-cell">Caches</th>
                <th className="hidden px-4 py-2.5 font-medium text-right md:table-cell">Modified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {shownDirs
                .slice(0, 100)
                .map((d) => (
                  <tr
                    key={`${d.node}:${d.path}`}
                    className="cursor-pointer hover:bg-zinc-900/40"
                    onClick={() => navigate("files", { path: d.path, node: d.node })}
                    title={`browse on ${d.nodeName}`}
                  >
                    <td className="px-4 py-2">
                      <span className={d.kind === "cache" ? "text-zinc-500" : "text-zinc-200"}>{d.name}</span>
                      {d.kind === "cache" && (
                        <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400 ring-1 ring-amber-500/30">cache</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-2 text-xs text-zinc-500 md:table-cell"><span className="mr-2"><NodeTag name={d.nodeName} self={d.node === ""} /></span>{d.root.split("/").slice(-2).join("/")}</td>
                    <td className="px-4 py-2 text-right text-xs tabular-nums text-zinc-300">{fmtGB(d.size_bytes)}</td>
                    <td className="hidden px-4 py-2 text-right text-xs tabular-nums text-amber-400/80 sm:table-cell">
                      {d.cache_bytes ? fmtGB(d.cache_bytes) : "—"}
                    </td>
                    <td className="hidden px-4 py-2 text-right text-xs tabular-nums text-zinc-500 md:table-cell">{fmtAgo(d.mtime)}</td>
                  </tr>
                ))}
              {dataDirs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-500">
                    {dataQ.loading ? "Asking every machine…" : "Data scan hasn't finished yet — sizes appear as each location is measured."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {shownDirs.length > 100 && (
          <p className="mt-2 text-[11px] text-zinc-600">Showing the 100 largest items. Filter by location to narrow down.</p>
        )}
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-500">Repositories</h2>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter (name, path, machine)…"
            data-testid="repo-filter"
            className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-zinc-600"
          />
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800" data-testid="repos-table">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/70 text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Repo</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Needs</th>
                <th className="px-4 py-2.5 font-medium text-right">Last commit</th>
                <th className="hidden px-4 py-2.5 font-medium text-right md:table-cell">Junk</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {filtered.map((r) => (
                <tr key={`${r.node}:${r.path}`} className="cursor-pointer hover:bg-zinc-900/40" onClick={() => navigate("files", { path: r.path, node: r.node })} data-testid="repo-row" data-node={r.nodeName}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2 font-medium text-zinc-200">{r.name}<NodeTag name={r.nodeName} self={r.node === ""} /></div>
                    <div className="text-xs text-zinc-500">
                      {r.head_branch ?? "no branch"}
                      {r.remotes.length === 0 ? " · no remote" : ""}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${RISK_STYLES[r.risk]}`}>
                      {r.risk === "at-risk" ? "at risk" : r.risk}
                    </span>
                  </td>
                  <td className="hidden max-w-xs px-4 py-2.5 text-xs text-zinc-400 md:table-cell">
                    {r.risk_reasons.length ? r.risk_reasons.join(", ") : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs tabular-nums text-zinc-400">{fmtAgo(r.last_commit_at)}</td>
                  <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-zinc-400 md:table-cell">
                    {r.junk_bytes ? fmtGB(r.junk_bytes) : "—"}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-zinc-500">
                    {repos.length === 0 ? (reposQ.loading ? "Asking every machine…" : "No repos indexed yet — first scan is running.") : "No matches."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
    </div>
  );
}
