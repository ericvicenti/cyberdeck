// Home: the dashboard. Usage limits for Claude Code and Codex, backup and
// redundancy status, storage across the fleet, agent activity, the Deck control
// summary, services, handoff, and the machine cards with pairing at the bottom.
import { useEffect, useState } from "react";
import { api, post, navigate, setActiveNode, fmtBytes, fmtAgo, ApiError } from "../lib/api";
import { ServerIcon, FolderIcon, TerminalIcon, GitIcon } from "../lib/icons";
import type { Overview } from "../lib/control";
import type { Dashboard, UsageSummary } from "../../src/daemon/api/dashboard";
import { Widget, Meter, StackBar, DayBars, HUD, severity, fmtIn, fmtDuration, fmtInt } from "../components/Widgets";

type NodeStatus = {
  nodeName: string;
  version: string;
  commit?: string;
  updating?: boolean;
  repos: number | null;
  atRisk: number | null;
  attention: number | null;
  junkBytes: number | null;
  lastScanAt: number | null;
};
type FleetNode = { id: string; name: string; url: string; added_at: number; last_seen: number | null; online: boolean; status: NodeStatus | null };
type FleetInfo = { self: { nodeId: string; name: string; urls: string[] }; nodes: FleetNode[] };
type PairingCode = { code: string; expiresAt: number; urls: string[] };

// ------------------------------------------------------------ usage widget ----

function UsageWidget({ title, usage, testId }: { title: string; usage: UsageSummary | undefined; testId: string }) {
  const u = usage;
  const meta = u?.fetchedAt ? `${u.source === "sessions" ? "from transcript · " : ""}${fmtAgo(u.fetchedAt)}` : u?.error ? "unavailable" : "loading";
  return (
    <Widget title={title} testId={testId} meta={<span className="flex items-center gap-2">{u?.plan && <span className="hud-badge text-zinc-400">{u.plan.replace(/^default_claude_/, "").replace(/_/g, " ")}</span>}{meta}</span>}>
      {u && u.available ? (
        <div>
          {u.limits.map((l) => (
            <Meter key={l.id} label={l.label} percent={l.percent} active={l.active} right={<span>{l.percent}%{l.resetsAt ? <span className="text-zinc-600"> · resets {fmtIn(l.resetsAt)}</span> : null}</span>} />
          ))}
          {u.credits && (u.credits.unlimited || u.credits.balance != null) && (
            <div className="mt-2 flex justify-between text-[10px] text-zinc-500">
              <span>credits</span>
              <span className="font-mono tabular-nums text-zinc-300">{u.credits.unlimited ? "unlimited" : fmtInt(u.credits.balance ?? 0)}</span>
            </div>
          )}
          {u.error && <div className="mt-2 text-[10px] text-amber-400">{u.error}</div>}
        </div>
      ) : (
        <div>
          <Meter label="session" percent={null} />
          <Meter label="weekly" percent={null} />
          <div className="mt-2 text-[10px] text-zinc-500">{u?.error ?? "…"}</div>
        </div>
      )}
    </Widget>
  );
}

// ---------------------------------------------------------------- node card ----

function NodeCard(props: { name: string; subtitle: string; online: boolean; status: NodeStatus | null; isSelf?: boolean; onBrowse?: () => void; onTerminal?: () => void; onRepos?: () => void; onUnpair?: () => void }) {
  const s = props.status;
  return (
    <div className="hud-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className={`rounded-lg p-2 ${props.online ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-800 text-zinc-500"}`}>
            <ServerIcon size={18} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">
              {props.name}
              {props.isSelf && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">this machine</span>}
            </div>
            <div className="truncate text-[11px] text-zinc-500">
              {s?.commit && (
                <span className={`mr-1.5 rounded px-1 font-mono text-[10px] ${s.updating ? "bg-amber-500/15 text-amber-400" : "bg-zinc-800 text-zinc-400"}`} title="software version (git commit)">
                  {s.updating ? "updating…" : s.commit}
                </span>
              )}
              {props.subtitle}
            </div>
          </div>
        </div>
        <span className={`hud-badge mt-1 flex items-center gap-1.5 ${props.online ? "neon-green" : "text-zinc-500"}`}>
          <span className={`led ${props.online ? "led-on" : "led-off"}`} />
          {props.online ? "online" : "offline"}
        </span>
      </div>

      {s && (
        <div className="mt-3 grid grid-cols-4 gap-2 text-center">
          {[
            ["repos", s.repos ?? 0, "text-zinc-200"],
            ["at risk", s.atRisk ?? 0, s.atRisk ? "text-red-400" : "text-emerald-400"],
            ["attention", s.attention ?? 0, s.attention ? "text-amber-400" : "text-emerald-400"],
            ["junk", s.junkBytes ? fmtBytes(s.junkBytes) : "0", "text-zinc-400"],
          ].map(([label, value, cls]) => (
            <div key={String(label)} className="rounded-sm bg-zinc-950/70 px-1 py-2">
              <div className={`hud-stat ${cls}`}>{String(value)}</div>
              <div className="hud-label mt-1">{String(label)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {props.onRepos && (
          <button onClick={props.onRepos} disabled={!props.online} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <GitIcon size={13} /> Repos
          </button>
        )}
        {props.onBrowse && (
          <button onClick={props.onBrowse} disabled={!props.online} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <FolderIcon size={13} /> Files
          </button>
        )}
        {props.onTerminal && (
          <button onClick={props.onTerminal} disabled={!props.online} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <TerminalIcon size={13} /> Shell
          </button>
        )}
        {props.onUnpair && (
          <button onClick={props.onUnpair} className="ml-auto rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-600 hover:bg-red-950/40 hover:text-red-400">
            Unpair
          </button>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- home ----

type CaseworkPairing = { url: string; key: string; link: string; qr: string; devices: { id: string; info?: { name?: string; model?: string } }[] };
/** Pairing card for the Casework Desk iPad/iPhone app: scan the QR (or type URL + key) in its Server settings. */
function CaseworkCard() {
  const [pairing, setPairing] = useState<CaseworkPairing | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const load = async () => {
    try { setPairing(await api<CaseworkPairing>(`/api/casework/pairing?url=${encodeURIComponent(location.origin)}`)); setErr(""); }
    catch (e) { setErr(e instanceof ApiError && e.status === 403 ? "sign in with the token or over the tailnet to see the pairing key" : String(e)); }
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15_000); return () => clearInterval(t); }, []);
  const copy = async (what: string, value: string) => { try { await navigator.clipboard.writeText(value); setCopied(what); setTimeout(() => setCopied(""), 1500); } catch {} };
  return (
    <div className="mt-3 hud-card p-4" data-testid="casework-card">
      <div className="flex flex-wrap items-start gap-5">
        {pairing ? <div className="shrink-0 rounded-lg border border-cyan-900/60 bg-[#e8fbff] p-1" dangerouslySetInnerHTML={{ __html: pairing.qr.replace(/width="\d+" height="\d+"/, 'width="168" height="168"') }} /> : null}
        <div className="min-w-0 flex-1">
          <div className="hud-label neon">iPad / iPhone client</div>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            In Casework Desk open <span className="text-zinc-300">Server settings</span> and scan this code, or enter the address and key by hand. The key only reaches the screens the app needs; it is not the node token.
          </p>
          {err ? <div className="mt-2 text-[11px] text-red-400">{err}</div> : null}
          {pairing ? (
            <div className="mt-3 flex flex-col gap-1.5 font-mono text-[11px]">
              <div className="flex items-center gap-2"><span className="w-12 text-zinc-500">url</span><span className="truncate text-zinc-200">{pairing.url}</span><button onClick={() => copy("url", pairing.url)} className="hud-chip">{copied === "url" ? "copied" : "copy"}</button></div>
              <div className="flex items-center gap-2"><span className="w-12 text-zinc-500">key</span><span className="truncate text-zinc-200">{pairing.key}</span><button onClick={() => copy("key", pairing.key)} className="hud-chip">{copied === "key" ? "copied" : "copy"}</button></div>
              <div className="flex items-center gap-2"><span className="w-12 text-zinc-500">link</span><button onClick={() => copy("link", pairing.link)} className="hud-chip">{copied === "link" ? "copied" : "copy pairing link"}</button>
                <button onClick={async () => { if (!confirm("Rotate the Casework key? Paired devices must re-pair.")) return; await post("/api/casework/rotate", {}); await load(); }} className="hud-chip text-red-300">rotate key</button></div>
              <div className="mt-1 text-zinc-500">devices: {pairing.devices.length ? pairing.devices.map((d) => d.info?.name ?? d.info?.model ?? d.id.slice(0, 8)).join(", ") : "none connected"}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function Home({ onLocked }: { onLocked: () => void }) {
  const [info, setInfo] = useState<FleetInfo | null>(null);
  const [selfStatus, setSelfStatus] = useState<NodeStatus | null>(null);
  // undefined = not answered yet, null = this node has no Deck repo (404)
  const [control, setControl] = useState<Overview | null | undefined>(undefined);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [peerDash, setPeerDash] = useState<Record<string, Dashboard>>({});
  const [code, setCode] = useState<PairingCode | null>(null);
  const [peerUrl, setPeerUrl] = useState("");
  const [peerCode, setPeerCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    try {
      const [f, s] = await Promise.all([api<FleetInfo>("/api/fleet/nodes"), api<NodeStatus>("/api/status")]);
      setInfo(f);
      setSelfStatus(s);
      api<Overview>("/api/control/overview").then(setControl).catch((e) => { if (e instanceof ApiError && e.status === 404) setControl(null); });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLocked();
    }
  };
  // The dashboard is heavier (usage APIs, df); poll it on its own, slower clock.
  const loadDash = async () => {
    try {
      setDash(await api<Dashboard>("/api/dashboard"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLocked();
    }
    try {
      const f = await api<FleetInfo>("/api/fleet/nodes");
      const entries = await Promise.all(f.nodes.filter((n) => n.online).map(async (n) => [n.name, await api<Dashboard>(`/api/nodes/${n.id}/proxy/dashboard`).catch(() => null)] as const));
      setPeerDash(Object.fromEntries(entries.filter((e): e is readonly [string, Dashboard] => e[1] != null)));
    } catch {}
  };

  useEffect(() => {
    load();
    loadDash();
    const iv = setInterval(load, 15_000);
    const iv2 = setInterval(loadDash, 60_000);
    return () => {
      clearInterval(iv);
      clearInterval(iv2);
    };
  }, []);

  const goto = (id: string, name: string, view: string) => {
    setActiveNode(id, name);
    navigate(view);
  };

  const pair = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await post<{ paired: { name: string } }>("/api/fleet/pair", { url: peerUrl.trim(), code: peerCode.trim() });
      setMsg({ kind: "ok", text: `Paired with ${res.paired.name}. It can now be managed from here (and vice versa).` });
      setPeerUrl("");
      setPeerCode("");
      load();
    } catch (err) {
      setMsg({ kind: "err", text: String(err instanceof Error ? err.message : err) });
    } finally {
      setBusy(false);
    }
  };

  const selfName = info?.self.name ?? "local";
  const r = dash?.redundancy;
  const b = dash?.backup;
  const sys = dash?.system;
  const disks: { node: string; d: Dashboard["disks"][number] }[] = [
    ...(dash?.disks ?? []).map((d) => ({ node: selfName, d })),
    ...Object.entries(peerDash).flatMap(([node, pd]) => pd.disks.map((d) => ({ node, d }))),
  ];
  const svcRows = control?.services?.rows ?? [];
  const svcByHost = new Map<string, typeof svcRows>();
  for (const row of svcRows) svcByHost.set(row.host, [...(svcByHost.get(row.host) ?? []), row]);
  const svcDown = svcRows.filter((x) => x.ok === false).length;
  const todoEntries = (control?.todo.sections ?? []).flatMap((s) => s.entries).slice(0, 4);
  const openTasks = control?.collab.tasks.filter((t) => t.status === "open").length ?? 0;
  const running = control?.collab.runs.filter((x) => x.status === "running").length ?? 0;
  const exposure = r ? r.remoteless + r.unpushed : 0;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="neon text-lg font-semibold uppercase tracking-[0.15em]">Home</h1>
            <p className="mt-0.5 text-xs text-zinc-500">Limits, safety and activity across the deck. Every widget leads to its view.</p>
          </div>
          {dash && <span className="text-[10px] text-zinc-600">updated {fmtAgo(dash.at)}</span>}
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="dashboard">
          {/* row 1: usage, backup */}
          <UsageWidget title="Claude Code" usage={dash?.usage.claude} testId="widget-claude" />
          <UsageWidget title="Codex" usage={dash?.usage.codex} testId="widget-codex" />

          <Widget title="Backup" tone={b?.configured ? "cyan" : "magenta"} testId="widget-backup" onClick={() => navigate("data")} meta={b ? (b.lastSnapshotAt ? `last snapshot ${fmtAgo(b.lastSnapshotAt)}` : "no snapshots") : "…"}>
            <div className="flex items-center gap-2 text-[11px]">
              <span className={`led ${b?.configured ? (b.lastSnapshotAt ? "led-on" : "led-warn") : "led-off"}`} />
              <span className="text-zinc-200">{b ? (b.configured ? `${b.targets.length} target${b.targets.length === 1 ? "" : "s"} configured` : "not configured") : "…"}</span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                ["protected", b ? fmtBytes(b.protectedBytes) : "—", "text-zinc-400"],
                ["exposed", r ? fmtBytes(r.exposedBytes) : "—", r?.exposedBytes ? "text-amber-400" : "text-emerald-400"],
                ["single-copy repos", r ? String(exposure) : "—", exposure ? "text-red-400" : "text-emerald-400"],
              ].map(([label, value, cls]) => (
                <div key={label} className="rounded-sm bg-zinc-950/70 px-1 py-2">
                  <div className={`hud-stat ${cls}`}>{value}</div>
                  <div className="hud-label mt-1">{label}</div>
                </div>
              ))}
            </div>
            {b?.targets.length ? (
              <ul className="mt-3 space-y-1 text-[11px]">
                {b.targets.map((t) => (
                  <li key={t.node} className="flex justify-between text-zinc-300">
                    <span>{t.node}</span>
                    <span className="text-zinc-500">{t.lastSnapshotAt ? fmtAgo(t.lastSnapshotAt) : "never"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">{b?.note ?? ""}</p>
          </Widget>

          {/* row 2: storage, repo safety, activity */}
          <Widget title="Storage" testId="widget-storage" meta={disks.length ? `${disks.length} volume${disks.length === 1 ? "" : "s"}` : "…"} onClick={() => navigate("data")}>
            {disks.length === 0 && <Meter label="/" percent={null} />}
            {disks.map(({ node, d }) => (
              <Meter
                key={`${node}:${d.filesystem}:${d.mount}`}
                label={<span>{node} <span className="text-zinc-500">{d.mount}</span></span>}
                percent={d.percent}
                sev={severity(d.percent, 80, 92)}
                right={<span>{fmtBytes(d.freeBytes)} free <span className="text-zinc-600">of {fmtBytes(d.totalBytes)}</span></span>}
              />
            ))}
          </Widget>

          <Widget title="Repo safety" testId="widget-redundancy" meta={r?.lastScanAt ? `scanned ${fmtAgo(r.lastScanAt)}` : "no scan yet"} onClick={() => navigate("data")}>
            <StackBar
              parts={[
                { label: "safe", value: r?.safe ?? 0, color: HUD.green },
                { label: "attention", value: r?.attention ?? 0, color: HUD.amber },
                { label: "at risk", value: r?.atRisk ?? 0, color: HUD.red },
              ]}
            />
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                ["remote-less", r?.remoteless ?? 0, r?.remoteless ? "text-red-400" : "text-emerald-400"],
                ["dirty", r?.dirty ?? 0, r?.dirty ? "text-amber-400" : "text-emerald-400"],
                ["unpushed", r?.unpushed ?? 0, r?.unpushed ? "text-amber-400" : "text-emerald-400"],
              ].map(([label, value, cls]) => (
                <div key={String(label)} className="rounded-sm bg-zinc-950/70 px-1 py-2">
                  <div className={`hud-stat ${cls}`}>{String(value)}</div>
                  <div className="hud-label mt-1">{String(label)}</div>
                </div>
              ))}
            </div>
            {r && <div className="mt-2 text-[10px] text-zinc-500">user data {fmtBytes(r.dataBytes)} · caches {fmtBytes(r.dataCacheBytes)}</div>}
          </Widget>

          <Widget title="Agent activity" testId="widget-activity" meta={`prompts · ${dash?.activity.length ?? 14} days · ${selfName}`} onClick={() => navigate("agents")}>
            <DayBars
              days={dash?.activity ?? []}
              series={[
                { key: "cc", label: "cc", color: HUD.cyan },
                { key: "cx", label: "cx", color: HUD.magenta },
              ]}
            />
          </Widget>

          {/* row 3: control, services, handoff */}
          <Widget title="Control" testId="control-card" onClick={() => navigate("projects")} meta={control ? `deck ${control.status?.repo.branch ?? ""}${control.status?.repo.dirty ? ` · ${control.status.repo.dirty} dirty` : ""}` : control === null ? "deck repo not configured" : "loading…"}>
            <div className="grid grid-cols-2 gap-2 text-center">
              {[
                ["projects", control?.projects.length ?? "—", "projects", "text-zinc-200"],
                ["handoff", control?.status?.handoffOpen ?? "—", "projects", "text-amber-400"],
                ["tasks open · running", control ? `${openTasks} · ${running}` : "—", "agents", "text-sky-400"],
                ["services down", control?.services ? svcDown : "—", "services", svcDown ? "text-red-400" : "text-emerald-400"],
              ].map(([label, value, view, cls]) => (
                <button key={String(label)} onClick={() => navigate(String(view))} className="hud-row rounded-sm bg-zinc-950/70 px-1 py-2">
                  <div className={`hud-stat ${cls}`}>{String(value)}</div>
                  <div className="hud-label mt-1">{String(label)}</div>
                </button>
              ))}
            </div>
          </Widget>

          <Widget title="Services" testId="widget-services" onClick={() => navigate("services")} meta={control?.services?.probedAt ? `probed ${fmtAgo(Date.parse(control.services.probedAt))} · ${svcDown ? `${svcDown} down` : "all up"}` : "no probe yet"}>
            {svcByHost.size === 0 && <div className="text-[11px] text-zinc-500">{control === undefined ? "loading…" : "No services probed yet."}</div>}
            <ul className="space-y-1.5">
              {[...svcByHost.entries()].map(([host, rows]) => (
                <li key={host} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 truncate text-zinc-300">{host}</span>
                  <span className="flex flex-wrap gap-1">
                    {rows.map((row) => (
                      <button key={row.service} title={`${row.service} · ${row.state}${row.error ? ` · ${row.error}` : ""}`} onClick={() => navigate("services", { host, service: row.service })} className="flex h-4 w-4 items-center justify-center rounded-sm hover:bg-zinc-800">
                        <span className={`led ${row.ok === false ? "led-err" : row.ok ? "led-on" : "led-off"}`} />
                      </button>
                    ))}
                  </span>
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-zinc-500">{rows.filter((x) => x.ok).length}/{rows.length}</span>
                </li>
              ))}
            </ul>
          </Widget>

          <Widget title="Handoff" testId="widget-handoff" onClick={() => navigate("projects")} meta={control ? `${control.status?.handoffOpen ?? 0} open` : ""}>
            {todoEntries.length === 0 && <div className="text-[11px] text-zinc-500">{control ? "Nothing in the handoff." : control === null ? "Deck repo not configured on this node." : "loading…"}</div>}
            <ul className="space-y-2">
              {todoEntries.map((e, i) => (
                <li key={i} className="text-[11px] leading-snug">
                  <span className="mr-1.5 font-mono text-[10px] text-zinc-500">{e.date}</span>
                  <span className="text-zinc-300">{e.text.replace(/\*\*/g, "").slice(0, 110)}{e.text.length > 110 ? "…" : ""}</span>
                </li>
              ))}
            </ul>
          </Widget>

          {/* row 4: this machine */}
          <Widget title={`System · ${selfName}`} testId="widget-system" meta={sys ? `up ${fmtDuration(sys.uptimeSec)} · ${sys.cpus} cpus` : "…"}>
            <Meter label="load (1m)" percent={sys ? Math.min(100, Math.round((sys.load[0] / sys.cpus) * 100)) : null} right={sys ? `${sys.load[0].toFixed(2)} · ${sys.load[1].toFixed(2)} · ${sys.load[2].toFixed(2)}` : "—"} />
            <Meter label="memory" percent={sys ? Math.round(((sys.totalMem - sys.freeMem) / sys.totalMem) * 100) : null} right={sys ? `${fmtBytes(sys.totalMem - sys.freeMem)} of ${fmtBytes(sys.totalMem)}` : "—"} />
          </Widget>
        </div>

        {/* machines */}
        <h2 className="hud-label neon mt-8">Machines</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <NodeCard
            name={info?.self.name ?? "…"}
            subtitle={info?.self.urls.join("  ·  ") || "no LAN address"}
            online
            isSelf
            status={selfStatus}
            onRepos={() => goto("", "", "data")}
            onBrowse={() => goto("", "", "files")}
            onTerminal={() => goto("", "", "term")}
          />
          {info?.nodes.map((n) => (
            <NodeCard
              key={n.id}
              name={n.name}
              subtitle={`${n.url} · paired ${fmtAgo(n.added_at)}${n.last_seen ? ` · seen ${fmtAgo(n.last_seen)}` : ""}`}
              online={n.online}
              status={n.status}
              onRepos={() => goto(n.id, n.name, "data")}
              onBrowse={() => goto(n.id, n.name, "files")}
              onTerminal={() => goto(n.id, n.name, "term")}
              onUnpair={async () => {
                await api(`/api/fleet/nodes/${n.id}`, { method: "DELETE" });
                load();
              }}
            />
          ))}
        </div>

        {/* pairing */}
        <h2 className="hud-label neon-magenta mt-8">Add a machine</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="hud-card p-4">
            <div className="hud-label neon">On this machine</div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Generate a pairing code, then enter it (with one of the addresses below) on the other machine's Home page.
            </p>
            {code ? (
              <div className="mt-3">
                <div className="neon-green text-center font-mono text-3xl font-bold tracking-[0.3em]" data-testid="pairing-code">
                  {code.code}
                </div>
                <div className="mt-2 text-center text-[11px] text-zinc-500">
                  valid 5 min · reach me at <span className="font-mono text-zinc-300">{code.urls.join("  or  ") || "…"}</span>
                </div>
              </div>
            ) : (
              <button onClick={async () => setCode(await post<PairingCode>("/api/fleet/pairing/start", {}))} data-testid="show-code-btn" className="mt-3 w-full rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-500">
                Show pairing code
              </button>
            )}
          </div>

          <div className="hud-card p-4">
            <div className="hud-label neon">Pair with another machine</div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">Enter the other machine's address and the code shown on its Home page.</p>
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                pair();
              }}
            >
              <input value={peerUrl} onChange={(e) => setPeerUrl(e.target.value)} placeholder="http://192.168.1.20:4777" data-testid="pair-url" className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-500" />
              <div className="flex gap-2">
                <input value={peerCode} onChange={(e) => setPeerCode(e.target.value)} placeholder="6-digit code" data-testid="pair-code" className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs tracking-widest text-zinc-100 outline-none focus:border-zinc-500" />
                <button disabled={busy || !peerUrl || !peerCode} data-testid="pair-submit" className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40">
                  {busy ? "Pairing…" : "Pair"}
                </button>
              </div>
            </form>
            {msg && (
              <div className={`mt-2 text-[11px] ${msg.kind === "ok" ? "text-emerald-400" : "text-red-400"}`} data-testid="pair-msg">
                {msg.text}
              </div>
            )}
          </div>
        </div>

        <h2 className="hud-label neon-magenta mt-8">Casework Desk</h2>
        <CaseworkCard />

        <p className="mt-6 text-[10px] leading-relaxed text-zinc-600">
          Pairing exchanges access tokens directly between the two machines over your local network, gated by the one-time code. Only pair on networks you trust. Remote machines are reached through this node — no ports are opened to the internet.
        </p>
      </div>
    </div>
  );
}
