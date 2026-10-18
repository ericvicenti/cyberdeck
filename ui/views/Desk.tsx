// Desk: talk to the node's Seed agent from a phone. One big TALK button that
// breathes with the call, the running transcript, and a status strip for the
// agents bridge (health, agent, session, node), and the Fleet / Services / Agents glance
// (what the agent sees through its MCP tools, at a look). When the daemon says voice is
// not configured, the card explains why and offers the one-time setup.
import { useEffect, useRef, useState } from "react";
import { routeHash, updateParams, useRouteTitle } from "../lib/navigation";
import { api, navigate, ApiError } from "../lib/api";
import { useVoice, micAllowedHere, type TranscriptLine } from "../lib/voice";
import { talkFace, isTalkKey, TALK_MODES } from "../lib/talk";
import { MicIcon } from "../lib/icons";
import { type Overview, isoAgo } from "../lib/control";
import { glance, glanceAsk, glanceBadge, GLANCE_TABS, type GlanceTab, type NodeSeen } from "../lib/glance";

type VoiceStatus = {
  configured: boolean;
  reason?: string;
  agentsUrl?: string;
  identity?: { available: boolean; principal?: string };
  agent?: { id: string; name?: string };
  sessionId?: string;
  health?: unknown;
  /** The Casework voice profile calls carry (Cartesia voice id + rate) and whether the runtime token to apply it is on hand. */
  profile?: { voice: string; speed: number; runtimeToken: boolean };
};
type TranscriptHistory = { supported: boolean; messages?: { role: "user" | "assistant"; text: string; at?: number }[]; notices?: { id: string; at: number; text: string }[] };

const insecureHere = (): boolean => location.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/** The agents server health as the daemon relays it, whatever shape it took. */
function healthOf(h: unknown): { ok: boolean | null; label: string } {
  if (h == null) return { ok: null, label: "unknown" };
  if (typeof h === "boolean") return { ok: h, label: h ? "up" : "down" };
  if (typeof h === "string") return { ok: /^(ok|up|healthy|ready)$/i.test(h), label: h };
  if (typeof h === "object") {
    const o = h as { ok?: unknown; status?: unknown; healthy?: unknown; error?: unknown };
    const ok = typeof o.ok === "boolean" ? o.ok : typeof o.healthy === "boolean" ? o.healthy : typeof o.status === "string" ? /^(ok|up|healthy|ready)$/i.test(o.status) : o.error ? false : null;
    const label = typeof o.status === "string" ? o.status : ok == null ? "unknown" : ok ? "up" : typeof o.error === "string" ? o.error : "down";
    return { ok, label };
  }
  return { ok: null, label: String(h) };
}

export function Desk({ params, onLocked, visible = true }: { params: URLSearchParams; onLocked: () => void; visible?: boolean }) {
  const requested = params.get("tab");
  const tab: GlanceTab = requested === "services" || requested === "agents" ? requested : "fleet";
  useEffect(() => {
    if (location.hash === routeHash("desk", params) && requested !== null && requested !== "services" && requested !== "agents") updateParams({ tab: null }, "replace");
  }, [requested]);
  useRouteTitle(!visible || tab === "fleet" ? undefined : `${tab === "services" ? "Services" : "Agents"} · Desk${params.get("node") ? ` · ${params.get("node")}` : ""}`);
  const v = useVoice({ onLocked });
  const wasVisible = useRef(visible);
  useEffect(() => {
    // Recheck an idle Desk on return (setup/hub configuration may have changed)
    // without replacing an in-progress call or its chosen hub.
    if (visible && !wasVisible.current && (v.phase === "idle" || v.phase === "error")) void v.refreshConfig();
    wasVisible.current = visible;
  }, [visible, v.refreshConfig]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [nodeName, setNodeName] = useState<string>("");
  const [history, setHistory] = useState<TranscriptLine[]>([]);
  const [busy, setBusy] = useState<"" | "setup" | "reset">("");
  const [note, setNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasLive = useRef(false);

  const statusLoad = useRef(0);
  const loadStatus = async () => {
    // A slower answer from the node that was asked before the route changed must not win.
    const load = ++statusLoad.current;
    try {
      const s = await api<VoiceStatus>("/api/voice/status", { local: true });
      if (load === statusLoad.current) setStatus(s);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      else if (load === statusLoad.current) setStatus(null);
    }
  };
  const loadHistory = async () => {
    try {
      const t = await api<TranscriptHistory>("/api/voice/transcript?limit=20", { local: true });
      if (!t.supported || !t.messages) { setHistory([]); return; }
      // Notices (the agent's `announce` tool: a finished run, a trigger's finding) sit in the flow by time.
      const notices: TranscriptLine[] = (t.notices ?? []).map((x) => ({ id: `n:${x.id}`, who: "notice", text: x.text, final: true, at: x.at }));
      const messages: TranscriptLine[] = t.messages.map((m, i) => ({ id: `h:${i}:${m.at ?? ""}`, who: m.role === "user" ? "me" : "agent", text: m.text, final: true, at: m.at ?? 0 }));
      setHistory([...messages, ...notices].sort((a, b) => a.at - b.at));
    } catch {
      setHistory([]);
    }
  };
  useEffect(() => {
    api<{ nodeName?: string }>("/api/status", { local: true }).then((s) => setNodeName(s.nodeName ?? "")).catch(() => {});
  }, []);
  // Status and history come from wherever the calls go, which is only known once the config is in.
  const resolved = v.config !== null;
  useEffect(() => {
    if (resolved) void loadStatus();
  }, [resolved, v.config?.via?.node]);
  useEffect(() => {
    if (v.config?.configured) void loadHistory();
  }, [v.config?.configured, v.config?.via?.node]);
  // While the hub is down (or voice is off for any reason) the page keeps asking, so it comes back on its own.
  const hubDown = v.config?.hub?.reachable === false;
  useEffect(() => {
    if (!v.config || v.config.configured) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") { void v.refreshConfig(); void loadStatus(); } }, hubDown ? 15_000 : 60_000);
    return () => clearInterval(t);
  }, [v.config?.configured, hubDown]);
  // Between calls the transcript keeps up with what arrives without one (announcements).
  useEffect(() => {
    if (!v.config?.configured) return;
    const t = setInterval(() => { if (v.phase === "idle" && document.visibilityState === "visible") void loadHistory(); }, 20_000);
    return () => clearInterval(t);
  }, [v.config?.configured, v.config?.via?.node, v.phase]);
  // After a call ends, the session on the agents server holds the full exchange: reload it
  // and drop the live lines so nothing shows twice.
  useEffect(() => {
    if (v.phase === "live") wasLive.current = true;
    if (v.phase === "idle" && wasLive.current) {
      wasLive.current = false;
      if (v.config?.configured) void loadHistory().then(() => v.clearTranscript());
    }
  }, [v.phase]);

  const lines = [...history, ...v.transcript];
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, lines[lines.length - 1]?.text]);

  const runSetup = async () => {
    setBusy("setup");
    setNote(null);
    try {
      const r = await api<{ ok?: boolean; message?: string; error?: string }>("/api/voice/setup", { local: true, method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setNote(r.message ?? (r.ok === false ? r.error ?? "setup failed" : "setup complete"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      setNote(e instanceof ApiError && e.status === 403 ? "setup needs the full token (not a scoped key)" : String(e instanceof Error ? e.message : e));
    } finally {
      setBusy("");
      await Promise.all([v.refreshConfig(), loadStatus()]);
    }
  };
  // A live call is not hung up: the daemon tells the voice runtime to move the room to the new session.
  const resetSession = async () => {
    const liveRoom = v.phase === "live" ? v.room : null;
    if (!liveRoom && v.phase !== "idle" && v.phase !== "error") v.stop();
    setBusy("reset");
    setNote(null);
    try {
      const r = await api<{ sessionId?: string; room?: { name: string; switched: boolean; error?: string } }>("/api/voice/session/reset", { local: true, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(liveRoom ? { room: liveRoom } : {}) });
      v.clearTranscript();
      setHistory([]);
      const id = r.sessionId ? `new session ${r.sessionId.slice(0, 8)}` : "new session";
      setNote(r.room ? (r.room.switched ? `${id} · the call moved to it` : `${id} · this call stays on the old one (${r.room.error ?? "not switched"})`) : id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      setNote(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy("");
      await Promise.all([v.refreshConfig(), loadStatus()]);
    }
  };

  const configured = v.config?.configured === true;
  const live = v.phase === "live";
  const face = talkFace(v.mode, v.phase, v.agentState, v.muted, v.held);
  const canTalk = configured && v.phase !== "ending" && micAllowedHere();
  const health = healthOf(status?.health);
  const agentName = status?.agent?.name ?? status?.agent?.id ?? v.config?.agentId;
  const sessionId = status?.sessionId ?? v.config?.sessionId;
  const glow = live ? 14 + v.level * 70 : 0;
  // Push-to-talk from a keyboard: hold the space bar (outside text fields) to open the mic.
  useEffect(() => {
    if (!visible || !face.holdTalks) return;
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!isTalkKey(e.key, e.repeat, t?.tagName, !!t?.isContentEditable)) return;
      e.preventDefault();
      v.hold(true);
    };
    const up = (e: KeyboardEvent) => {
      if (!isTalkKey(e.key, false, undefined, false)) return;
      e.preventDefault();
      v.hold(false);
    };
    const blur = () => v.hold(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); v.hold(false); };
  }, [visible, face.holdTalks, v.hold]);
  const glowColor = v.agentState === "speaking" ? "rgba(34,211,238,0.55)" : v.agentState === "thinking" ? "rgba(232,121,249,0.5)" : "rgba(163,230,53,0.55)";

  return (
    <div className="h-full overflow-y-auto" data-testid="desk-view">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-8 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:items-start">
        <div className="flex flex-col gap-4">
          {insecureHere() && (
            <div className="hud-card hud-magenta p-3 text-[11px] text-zinc-300" data-testid="voice-https-note">
              <span className="hud-label neon-magenta">microphone</span>
              <p className="mt-1">Browsers only hand out the microphone on <span className="font-mono">https://</span> or <span className="font-mono">localhost</span>. Open this node through its Tailscale HTTPS address, or on the machine itself.</p>
            </div>
          )}

          {v.config && !configured && hubDown && v.config.hub && (
            <div className="hud-card p-3" data-testid="voice-hub-offline">
              <div className="flex items-center gap-2">
                <span className="led led-warn" />
                <span className="hud-label neon-amber">voice hub {v.config.hub.name} is offline</span>
              </div>
              <p className="mt-2 text-[12px] text-zinc-300">{v.config.reason}</p>
              <p className="mt-1 text-[11px] text-zinc-500">Nothing to set up here: the calls go through {v.config.hub.name}. This page rechecks every 15 s and TALK comes back when it answers{v.config.hub.lastSeen ? ` (last seen ${isoAgo(new Date(v.config.hub.lastSeen).toISOString())})` : ""}.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button onClick={() => { void v.refreshConfig(); void loadStatus(); }} className="hud-chip text-zinc-300 hover:text-zinc-100">recheck now</button>
              </div>
            </div>
          )}

          {v.config && !configured && !hubDown && (
            <div className="hud-card hud-magenta p-3" data-testid="voice-unconfigured">
              <div className="flex items-center gap-2">
                <span className="led led-off" />
                <span className="hud-label neon-magenta">voice not configured</span>
              </div>
              <p className="mt-2 text-[12px] text-zinc-300">{v.config.reason ?? "This node has no Seed agents bridge yet."}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button onClick={runSetup} disabled={busy !== ""} data-testid="voice-setup" className="rounded-lg bg-zinc-100 px-3 py-1.5 text-[12px] font-medium text-zinc-900 hover:bg-white disabled:opacity-40">{busy === "setup" ? "running setup…" : "Run setup"}</button>
                <button onClick={() => { void v.refreshConfig(); void loadStatus(); }} className="hud-chip text-zinc-300 hover:text-zinc-100">recheck</button>
              </div>
              {note && <p className="mt-2 text-[11px] text-zinc-400" data-testid="voice-note">{note}</p>}
            </div>
          )}

          {v.phase === "error" && v.error && (
            <div className="hud-card hud-red p-3 text-[12px]" data-testid="voice-error" role="alert">
              <span className="hud-label neon-red">call failed</span>
              <p className="mt-1 text-zinc-200">{v.error}</p>
            </div>
          )}

          <section className="hud-card flex flex-col items-center gap-4 px-4 py-8">
            <button
              onClick={face.tapToggles ? v.toggle : undefined}
              onPointerDown={face.holdTalks ? (e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); v.hold(true); } : undefined}
              onPointerUp={face.holdTalks ? () => v.hold(false) : undefined}
              onPointerCancel={face.holdTalks ? () => v.hold(false) : undefined}
              onLostPointerCapture={face.holdTalks ? () => v.hold(false) : undefined}
              onContextMenu={face.holdTalks ? (e) => e.preventDefault() : undefined}
              disabled={!canTalk}
              data-testid="talk-button"
              data-phase={v.phase}
              data-agent-state={v.agentState}
              data-mode={v.mode}
              data-held={v.held || undefined}
              aria-pressed={face.holdTalks ? v.held : live || v.phase === "connecting"}
              aria-label={face.holdTalks ? "Hold to talk" : live || v.phase === "connecting" ? "End call" : "Start call"}
              className={`talk-btn ${face.ring}`}
              style={glow ? { boxShadow: `0 0 ${glow}px ${glowColor}, inset 0 0 ${glow / 2}px ${glowColor}` } : undefined}
            >
              {face.button}
            </button>
            <div className={`flex items-center gap-2 text-[12px] uppercase tracking-[0.2em] ${face.tone}`} data-testid="voice-state">
              <span className={`led ${v.phase === "live" ? (v.agentState === "thinking" ? "led-run" : v.muted ? "led-warn" : "led-on") : v.phase === "connecting" ? "led-warn" : v.phase === "error" ? "led-err" : "led-off"}`} />
              {face.state}
            </div>
            {live && (
              <div className="h-1 w-40 overflow-hidden rounded-sm bg-zinc-800" aria-hidden>
                <div className="h-full rounded-sm transition-[width] duration-75" style={{ width: `${Math.round(v.level * 100)}%`, background: v.muted ? "#3a4259" : "var(--hud-green)", boxShadow: v.muted ? "none" : "0 0 6px var(--hud-green)" }} />
              </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {face.muteChip && (
                <button onClick={v.toggleMute} data-testid="voice-mute" className={`hud-chip ${v.muted ? "neon-amber" : "text-zinc-300"} hover:text-zinc-100`}>
                  <MicIcon size={12} className={v.muted ? "opacity-50" : ""} />
                  {v.muted ? "unmute" : "mute"}
                </button>
              )}
              {face.endChip && (
                <button onClick={v.stop} data-testid="voice-end" className="hud-chip neon-red hover:text-zinc-100">end call</button>
              )}
              <div className="flex items-center gap-0.5 rounded-md border border-zinc-800 p-0.5" role="group" aria-label="Talk mode" data-testid="voice-mode" title="hands-free keeps the mic open for the whole call; push to talk opens it only while TALK (or the space bar) is held">
                {TALK_MODES.map(([key, name]) => (
                  <button key={key} onClick={() => v.setMode(key)} aria-pressed={v.mode === key} data-testid={`voice-mode-${key}`} className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wider ${v.mode === key ? "bg-zinc-800 neon" : "text-zinc-500 hover:text-zinc-300"}`}>{name}</button>
                ))}
              </div>
              {!live && v.phase !== "connecting" && (
                <label className="hud-chip cursor-pointer text-zinc-400 hover:text-zinc-200" title="Send a 'Hi' on join so the agent speaks first">
                  <input type="checkbox" checked={v.greet} onChange={(e) => v.setGreet(e.target.checked)} className="h-3 w-3 accent-cyan-400" data-testid="voice-greet" />
                  agent greets first
                </label>
              )}
            </div>
          </section>

          <section className="hud-card p-3" data-testid="voice-status">
            <div className="hud-label neon">bridge</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="hud-chip text-zinc-300" title={status?.agentsUrl ?? "agents server"}><span className={`led ${health.ok === true ? "led-on" : health.ok === false ? "led-err" : "led-off"}`} />agents {status ? health.label : v.configError ? "n/a" : "…"}</span>
              <span className="hud-chip text-zinc-300" title={status?.agent?.id ?? ""}><span className={`led ${agentName ? "led-on" : "led-off"}`} />agent {agentName ? agentName.slice(0, 18) : "—"}</span>
              <span className="hud-chip text-zinc-300" title={sessionId ?? ""}><span className={`led ${sessionId ? "led-run" : "led-off"}`} />session {sessionId ? sessionId.slice(0, 8) : "—"}</span>
              {configured && <button onClick={resetSession} disabled={busy !== ""} data-testid="voice-new-session" className="hud-chip text-zinc-300 hover:text-zinc-100 disabled:opacity-40">{busy === "reset" ? "resetting…" : "new session"}</button>}
              {status?.profile && <span className="hud-chip text-zinc-300" data-testid="voice-profile" title={status.profile.runtimeToken ? `Cartesia voice ${status.profile.voice} at ${status.profile.speed}x, applied to every call` : `Cartesia voice ${status.profile.voice}: no runtime token on this node, calls keep the worker's default voice`}><span className={`led ${status.profile.runtimeToken ? "led-on" : "led-warn"}`} />voice {status.profile.voice.slice(0, 8)} ×{status.profile.speed}</span>}
              <span className="hud-chip text-zinc-300" data-testid="voice-node" title={v.config?.via ? `Voice is centralized: ${nodeName || "this node"} relays every call to the voice hub, ${v.config.via.name}${hubDown ? " (offline)" : ""}` : "This node runs the voice system itself"}><span className={`led ${hubDown ? "led-warn" : "led-on"}`} />voice {v.config?.via ? v.config.via.name : nodeName || "—"}{hubDown ? " offline" : ""}</span>
              {status?.identity && <span className="hud-chip text-zinc-300" title={status.identity.principal ?? ""}><span className={`led ${status.identity.available ? "led-on" : "led-warn"}`} />identity {status.identity.available ? (status.identity.principal ?? "ok").slice(0, 12) : "missing"}</span>}
            </div>
            {configured && note && <p className="mt-2 text-[11px] text-zinc-400" data-testid="voice-note">{note}</p>}
          </section>

          {visible && <GlancePanel key={params.get("node") ?? ""} tab={tab} onLocked={onLocked} />}
        </div>

        <section className="hud-card flex min-h-[200px] flex-col p-3 md:h-[calc(100dvh-7rem)] md:min-h-0" data-testid="voice-transcript">
          <div className="flex items-baseline justify-between">
            <div className="hud-label neon">transcript</div>
            {lines.length > 0 && <button onClick={() => { v.clearTranscript(); setHistory([]); }} className="text-[10px] uppercase tracking-wider text-zinc-600 hover:text-zinc-300">clear</button>}
          </div>
          <div ref={listRef} className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1 text-[13px]">
            {lines.length === 0 && <p className="text-[11px] text-zinc-600">{configured ? "Nothing said yet. Tap TALK and speak." : "The conversation shows up here once voice is set up."}</p>}
            {lines.map((l) => (
              <div key={l.id} className={`flex ${l.who === "me" ? "justify-end" : l.who === "notice" ? "justify-center" : "justify-start"}`} data-kind={l.who}>
                <div className={`max-w-[88%] rounded-lg px-2.5 py-1.5 ${l.who === "me" ? "border border-sky-400/30 bg-sky-400/10 text-zinc-100" : l.who === "notice" ? "border border-amber-400/30 bg-amber-400/10 text-zinc-200" : "border border-violet-400/30 bg-violet-400/10 text-zinc-200"} ${l.final ? "" : "italic opacity-70"}`}>
                  <div className={`hud-label mb-0.5 ${l.who === "me" ? "text-sky-300" : l.who === "notice" ? "text-amber-300" : "text-violet-300"}`}>{l.who === "me" ? "me" : l.who === "notice" ? "fleet" : agentName ?? "agent"}</div>
                  <div className={l.final ? "" : "hud-cursor"}>{l.text}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

const BADGE_TONE = { bad: "neon-red", warn: "neon-amber", ok: "text-zinc-500" } as const;

/** Fleet / Services / Agents under the TALK button: the overview the agent reads, at a glance. */
function GlancePanel({ tab, onLocked }: { tab: GlanceTab; onLocked: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [nodes, setNodes] = useState<NodeSeen[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [o, n] = await Promise.all([
          api<Overview>("/api/control/overview"),
          api<{ self: { name: string }; nodes: NodeSeen[] }>("/api/fleet/nodes").catch(() => null),
        ]);
        if (alive) { setOv(o); setNodes(n ? [{ name: n.self.name, online: true }, ...n.nodes] : []); setErr(null); }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onLocked();
        else if (alive) setErr(e instanceof ApiError && e.status === 404 ? "No fleet dir on this node." : String(e instanceof Error ? e.message : e));
      }
    };
    void load();
    const iv = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  const pick = (tab: GlanceTab) => updateParams({ tab: tab === "fleet" ? null : tab });
  const g = ov ? glance(ov, nodes) : null;
  const go = (view: string, params: Record<string, string> = {}) => () => navigate(view, params);
  const row = "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] hover:bg-zinc-800/60";

  return (
    <section className="hud-card p-3" data-testid="desk-glance">
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {GLANCE_TABS.map(([key, label]) => {
          const b = g ? glanceBadge(g, key) : null;
          return (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => pick(key)} data-testid={`glance-tab-${key}`} className={`hud-chip ${tab === key ? "neon" : "text-zinc-400 hover:text-zinc-200"}`}>
              {label}
              {b && <span className={`font-mono ${BADGE_TONE[b.tone]}`}>{b.n}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-col" data-testid={`glance-${tab}`}>
        {!g && <p className="text-[11px] text-zinc-500" data-testid="glance-empty">{err ?? "loading…"}</p>}
        {g && tab === "fleet" && (
          <>
            <p className="mb-1 text-[11px] text-zinc-500">{g.hosts.up} up · {g.hosts.down} down · {g.hosts.unknown} unknown{g.handoffOpen != null ? ` · ${g.handoffOpen} handoff open` : ""}</p>
            {g.hosts.rows.map((h) => (
              <button key={h.name} onClick={go("services", { host: h.name })} className={row}>
                <span className={`led ${h.online === true ? "led-on" : h.online === false ? "led-err" : "led-off"}`} />
                <span className="w-24 shrink-0 truncate text-zinc-200">{h.name}</span>
                <span className="truncate text-zinc-500">{h.cyberdeck ? `${h.cyberdeck.repos} repos · ${h.cyberdeck.atRisk} at risk` : `${h.kind} · ${h.os}`}</span>
              </button>
            ))}
          </>
        )}
        {g && tab === "services" && (!g.services ? <p className="text-[11px] text-zinc-500">Not probed yet.</p> : (
          <>
            <p className="mb-1 text-[11px] text-zinc-500">{g.services.up}/{g.services.total} up{g.services.unknown.length ? ` · ${g.services.unknown.length} unknown` : ""} · probed {isoAgo(g.services.probedAt)}</p>
            {[...g.services.down, ...g.services.unknown].map((r) => (
              <button key={`${r.host}/${r.service}`} onClick={go("services", { host: r.host, svc: r.service })} className={row}>
                <span className={`led ${r.ok === false ? "led-err" : "led-off"}`} />
                <span className="truncate text-zinc-200">{r.host} · {r.service}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-zinc-500">{r.state}</span>
              </button>
            ))}
            {!g.services.down.length && !g.services.unknown.length && <p className="text-[12px] neon-green">all services up</p>}
          </>
        ))}
        {g && tab === "agents" && (
          <>
            <p className="mb-1 text-[11px] text-zinc-500">{g.agents.active.length} live task{g.agents.active.length === 1 ? "" : "s"} · {g.agents.open} open · auto {g.agents.auto ? "on" : "off"}</p>
            {g.agents.active.slice(0, 8).map((t) => (
              <button key={t.id} onClick={go("agents")} className={row}>
                <span className={`w-14 shrink-0 font-mono text-[10px] uppercase ${t.status === "running" ? "neon" : t.status === "review" ? "neon-amber" : t.status === "blocked" ? "neon-red" : "text-zinc-400"}`}>{t.status}</span>
                <span className="truncate text-zinc-200">{t.id} · {t.title}</span>
                <span className="ml-auto shrink-0 text-[11px] text-zinc-500">{t.host}</span>
              </button>
            ))}
            {g.agents.runs.length > 0 && <div className="hud-label mt-2 text-zinc-500">recent runs</div>}
            {g.agents.runs.map((r) => (
              <button key={r.id} onClick={go("agents")} className={row}>
                <span className={`led ${r.status === "running" ? "led-run" : r.status === "done" ? "led-on" : r.status === "failed" ? "led-err" : "led-off"}`} />
                <span className="truncate text-zinc-200">{r.title}</span>
                <span className="ml-auto shrink-0 text-[11px] text-zinc-500">{r.verdict ?? r.status} · {isoAgo(r.startedAt)}</span>
              </button>
            ))}
            {!g.agents.active.length && !g.agents.runs.length && <p className="text-[12px] text-zinc-500">no tasks or runs</p>}
          </>
        )}
        {g && <p className="mt-2 text-[11px] text-zinc-500" data-testid="glance-ask">try asking: <span className="text-zinc-300">“{glanceAsk(g, tab)}”</span></p>}
      </div>
    </section>
  );
}
