// Desk: talk to the node's Seed agent from a phone. One big TALK button that
// breathes with the call, the running transcript, and a status strip for the
// agents bridge (health, agent, session, node). When the daemon says voice is
// not configured, the card explains why and offers the one-time setup.
import { useEffect, useRef, useState } from "react";
import { api, post, ApiError } from "../lib/api";
import { useVoice, micAllowedHere, type TranscriptLine, type AgentState, type VoicePhase } from "../lib/voice";
import { MicIcon } from "../lib/icons";

type VoiceStatus = {
  configured: boolean;
  reason?: string;
  agentsUrl?: string;
  identity?: { available: boolean; principal?: string };
  agent?: { id: string; name?: string };
  sessionId?: string;
  health?: unknown;
};
type TranscriptHistory = { supported: boolean; messages?: { role: "user" | "assistant"; text: string; at?: number }[] };

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

function stateLabel(phase: VoicePhase, agent: AgentState, muted: boolean): { text: string; tone: string } {
  if (phase === "error") return { text: "failed · tap to retry", tone: "neon-red" };
  if (phase === "connecting") return { text: "connecting", tone: "neon-amber" };
  if (phase === "ending") return { text: "hanging up", tone: "text-zinc-500" };
  if (phase === "idle") return { text: "tap to talk", tone: "text-zinc-500" };
  if (muted) return { text: "muted", tone: "neon-amber" };
  if (agent === "speaking") return { text: "speaking", tone: "neon" };
  if (agent === "thinking") return { text: "thinking", tone: "neon-magenta" };
  if (agent === "listening") return { text: "listening", tone: "neon-green" };
  return { text: "waiting for the agent", tone: "text-zinc-400" };
}

const ringClass = (phase: VoicePhase, agent: AgentState): string => {
  if (phase === "connecting") return "talk-connecting";
  if (phase === "ending") return "talk-ending";
  if (phase === "error") return "talk-error";
  if (phase !== "live") return "";
  return agent === "speaking" ? "talk-speaking" : agent === "thinking" ? "talk-thinking" : "talk-listening";
};

export function Desk({ onLocked }: { onLocked: () => void }) {
  const v = useVoice({ onLocked });
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [nodeName, setNodeName] = useState<string>("");
  const [history, setHistory] = useState<TranscriptLine[]>([]);
  const [busy, setBusy] = useState<"" | "setup" | "reset">("");
  const [note, setNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasLive = useRef(false);

  const loadStatus = async () => {
    try {
      setStatus(await api<VoiceStatus>("/api/voice/status"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      else setStatus(null);
    }
  };
  const loadHistory = async () => {
    try {
      const t = await api<TranscriptHistory>("/api/voice/transcript?limit=20");
      if (!t.supported || !t.messages) { setHistory([]); return; }
      setHistory(t.messages.map((m, i) => ({ id: `h:${i}:${m.at ?? ""}`, who: m.role === "user" ? "me" : "agent", text: m.text, final: true, at: m.at ?? 0 })));
    } catch {
      setHistory([]);
    }
  };
  useEffect(() => {
    api<{ nodeName?: string }>("/api/status").then((s) => setNodeName(s.nodeName ?? "")).catch(() => {});
    void loadStatus();
  }, []);
  useEffect(() => {
    if (v.config?.configured) void loadHistory();
  }, [v.config?.configured]);
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
      const r = await post<{ ok?: boolean; message?: string; error?: string }>("/api/voice/setup", {});
      setNote(r.message ?? (r.ok === false ? r.error ?? "setup failed" : "setup complete"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLocked();
      setNote(e instanceof ApiError && e.status === 403 ? "setup needs the full token (not a scoped key)" : String(e instanceof Error ? e.message : e));
    } finally {
      setBusy("");
      await Promise.all([v.refreshConfig(), loadStatus()]);
    }
  };
  const resetSession = async () => {
    if (v.phase !== "idle" && v.phase !== "error") v.stop();
    setBusy("reset");
    setNote(null);
    try {
      const r = await post<{ sessionId?: string }>("/api/voice/session/reset", {});
      v.clearTranscript();
      setHistory([]);
      setNote(r.sessionId ? `new session ${r.sessionId.slice(0, 8)}` : "new session");
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
  const label = stateLabel(v.phase, v.agentState, v.muted);
  const canTalk = configured && v.phase !== "ending" && micAllowedHere();
  const health = healthOf(status?.health);
  const agentName = status?.agent?.name ?? status?.agent?.id ?? v.config?.agentId;
  const sessionId = status?.sessionId ?? v.config?.sessionId;
  const glow = live ? 14 + v.level * 70 : 0;
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

          {v.config && !configured && (
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
              onClick={v.toggle}
              disabled={!canTalk}
              data-testid="talk-button"
              data-phase={v.phase}
              data-agent-state={v.agentState}
              aria-pressed={live || v.phase === "connecting"}
              aria-label={live || v.phase === "connecting" ? "End call" : "Start call"}
              className={`talk-btn ${ringClass(v.phase, v.agentState)}`}
              style={glow ? { boxShadow: `0 0 ${glow}px ${glowColor}, inset 0 0 ${glow / 2}px ${glowColor}` } : undefined}
            >
              {live || v.phase === "connecting" ? "end" : "talk"}
            </button>
            <div className={`flex items-center gap-2 text-[12px] uppercase tracking-[0.2em] ${label.tone}`} data-testid="voice-state">
              <span className={`led ${v.phase === "live" ? (v.agentState === "thinking" ? "led-run" : "led-on") : v.phase === "connecting" ? "led-warn" : v.phase === "error" ? "led-err" : "led-off"}`} />
              {label.text}
            </div>
            {live && (
              <div className="h-1 w-40 overflow-hidden rounded-sm bg-zinc-800" aria-hidden>
                <div className="h-full rounded-sm transition-[width] duration-75" style={{ width: `${Math.round(v.level * 100)}%`, background: v.muted ? "#3a4259" : "var(--hud-green)", boxShadow: v.muted ? "none" : "0 0 6px var(--hud-green)" }} />
              </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {live && (
                <button onClick={v.toggleMute} data-testid="voice-mute" className={`hud-chip ${v.muted ? "neon-amber" : "text-zinc-300"} hover:text-zinc-100`}>
                  <MicIcon size={12} className={v.muted ? "opacity-50" : ""} />
                  {v.muted ? "unmute" : "mute"}
                </button>
              )}
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
              <span className="hud-chip text-zinc-300"><span className="led led-on" />node {nodeName || "—"}</span>
              {status?.identity && <span className="hud-chip text-zinc-300" title={status.identity.principal ?? ""}><span className={`led ${status.identity.available ? "led-on" : "led-warn"}`} />identity {status.identity.available ? (status.identity.principal ?? "ok").slice(0, 12) : "missing"}</span>}
            </div>
            {configured && note && <p className="mt-2 text-[11px] text-zinc-400" data-testid="voice-note">{note}</p>}
          </section>
        </div>

        <section className="hud-card flex min-h-[200px] flex-col p-3 md:h-[calc(100dvh-7rem)] md:min-h-0" data-testid="voice-transcript">
          <div className="flex items-baseline justify-between">
            <div className="hud-label neon">transcript</div>
            {lines.length > 0 && <button onClick={() => { v.clearTranscript(); setHistory([]); }} className="text-[10px] uppercase tracking-wider text-zinc-600 hover:text-zinc-300">clear</button>}
          </div>
          <div ref={listRef} className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1 text-[13px]">
            {lines.length === 0 && <p className="text-[11px] text-zinc-600">{configured ? "Nothing said yet. Tap TALK and speak." : "The conversation shows up here once voice is set up."}</p>}
            {lines.map((l) => (
              <div key={l.id} className={`flex ${l.who === "me" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[88%] rounded-lg px-2.5 py-1.5 ${l.who === "me" ? "border border-sky-400/30 bg-sky-400/10 text-zinc-100" : "border border-violet-400/30 bg-violet-400/10 text-zinc-200"} ${l.final ? "" : "italic opacity-70"}`}>
                  <div className={`hud-label mb-0.5 ${l.who === "me" ? "text-sky-300" : "text-violet-300"}`}>{l.who === "me" ? "me" : agentName ?? "agent"}</div>
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
