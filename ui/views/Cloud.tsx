// Cloud AI: ChatGPT and Claude accounts driven through the node's remote browser,
// with every conversation archived into the Deck repo.
import { useEffect, useState } from "react";
import { api, post, ApiError, activeNodeName } from "../lib/api";
import { isoAgo } from "../lib/control";
import { Panel, Empty } from "./Projects";
import { Markdown } from "./Markdown";
import { RemoteBrowser } from "./RemoteBrowser";

type ProviderState = { status: "ok" | "needs_login" | "unavailable" | "never"; lastSync: string | null; lastError: string | null; conversations: number; syncing: boolean; profileExists: boolean; browserOpen: boolean };
type Summary = { archiveDir: string; providers: Record<string, ProviderState> };
type Conv = { host: string; tool: string; id: string; title: string; started: string; updated: string; file: string; messages: number; url: string };
type Profiles = { available: boolean; reason?: string; profiles: { name: string; open: boolean; exists: boolean; url?: string }[] };

const PROVIDERS = [
  { key: "chatgpt", label: "ChatGPT", home: "https://chatgpt.com/", tone: "neon-green" },
  { key: "claude", label: "Claude", home: "https://claude.ai/", tone: "neon-amber" },
] as const;

const STATUS: Record<ProviderState["status"], { led: string; text: string }> = {
  ok: { led: "led led-on", text: "ARCHIVING" },
  needs_login: { led: "led led-warn", text: "LOGIN NEEDED" },
  unavailable: { led: "led led-err", text: "UNAVAILABLE" },
  never: { led: "led led-off", text: "NOT SYNCED" },
};

export function Cloud({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  const [profile, setProfile] = useState(params.get("profile") ?? "chatgpt");
  const [navUrl, setNavUrl] = useState<string | undefined>(params.get("url") ?? undefined);
  const [q, setQ] = useState("");
  const [convs, setConvs] = useState<Conv[]>([]);
  const [sel, setSel] = useState<Conv | null>(null);
  const [doc, setDoc] = useState<{ frontmatter: Record<string, string>; markdown: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    try { setSum(await api<Summary>("/api/cloud")); } catch (e) { if (e instanceof ApiError && e.status === 401) onLocked(); }
    try { setProfiles(await api<Profiles>("/api/browser/profiles")); } catch {}
  };
  useEffect(() => { load(); const iv = setInterval(load, 8000); return () => clearInterval(iv); }, []);

  const loadConvs = async () => {
    const all: Conv[] = [];
    for (const p of PROVIDERS) { try { all.push(...(await api<Conv[]>(`/api/cloud/${p.key}/conversations?q=${encodeURIComponent(q)}`))); } catch {} }
    all.sort((a, b) => b.updated.localeCompare(a.updated));
    setConvs(all);
  };
  useEffect(() => { const t = setTimeout(loadConvs, 200); return () => clearTimeout(t); }, [q, sum?.providers.chatgpt.conversations, sum?.providers.claude.conversations]);

  useEffect(() => {
    if (!sel) { setDoc(null); return; }
    const prov = sel.tool === "chatgpt" ? "chatgpt" : "claude";
    api<{ frontmatter: Record<string, string>; markdown: string }>(`/api/cloud/${prov}/conversations/${encodeURIComponent(sel.id)}`).then(setDoc).catch(() => setDoc(null));
  }, [sel?.id]);

  const sync = async (p: string) => { try { await post(`/api/cloud/${p}/sync`, {}); setMsg(`${p}: sync started`); setTimeout(load, 1500); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } };
  const openSite = (p: typeof PROVIDERS[number]) => { setProfile(p.key); setNavUrl(p.home + "?t=" + Date.now()); };
  const where = activeNodeName() || "this node";

  return (
    <div className="h-full overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <div>
          <h1 className="hud-label text-base text-cyan-300">Cloud</h1>
          <p className="text-xs text-zinc-500">ChatGPT and Claude accounts through {where}'s browser · archive in <span className="font-mono text-zinc-400">{sum?.archiveDir ?? "…"}</span>{msg ? <span className="ml-2 text-amber-300">{msg}</span> : null}</p>
        </div>

        {/* provider cards */}
        <div className="grid gap-3 sm:grid-cols-2">
          {PROVIDERS.map((p) => {
            const s = sum?.providers[p.key];
            const st = STATUS[s?.status ?? "never"];
            return (
              <div key={p.key} className="hud-card p-3">
                <div className="flex items-center gap-2">
                  <span className={s?.syncing ? "led led-run" : st.led} />
                  <span className={`hud-label text-[12px] ${p.tone}`}>{p.label}</span>
                  <span className="hud-badge">{s?.syncing ? "SYNCING" : st.text}</span>
                  <div className="flex-1" />
                  <span className="hud-stat text-lg">{s?.conversations ?? 0}</span>
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">saved</span>
                </div>
                <div className="pt-1 text-[11px] text-zinc-500">
                  {s?.lastSync ? `last sync ${isoAgo(s.lastSync)}` : "never synced"}
                  {s?.lastError ? <span className="ml-2 text-amber-300/80" title={s.lastError}>· {s.lastError.slice(0, 80)}</span> : null}
                </div>
                {s?.status === "needs_login" && <div className="pt-1 text-[11px] text-amber-300">Log in below (profile <span className="font-mono">{p.key}</span>), then press Sync now.</div>}
                {s && !s.profileExists && s.status === "never" && <div className="pt-1 text-[11px] text-zinc-400">Not connected yet: press Open, log in once in the browser below, then Sync now.</div>}
                <div className="flex gap-2 pt-2">
                  <button onClick={() => openSite(p)} className="rounded border border-cyan-500/40 px-2 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/10">Open</button>
                  <button onClick={() => sync(p.key)} disabled={s?.syncing} className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">{s?.syncing ? "Syncing…" : "Sync now"}</button>
                </div>
              </div>
            );
          })}
        </div>

        {/* remote browser */}
        <Panel
          title="Remote browser"
          right={
            <div className="flex items-center gap-2 text-[11px]">
              <select value={profile} onChange={(e) => { setProfile(e.target.value); setNavUrl(undefined); }} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300">
                {(profiles?.profiles ?? [{ name: "chatgpt" }, { name: "claude" }, { name: "default" }]).map((pr) => <option key={pr.name} value={pr.name}>{pr.name}{"open" in pr && pr.open ? " ●" : ""}</option>)}
              </select>
              <span className="text-zinc-500">profile · logins persist on {where}</span>
            </div>
          }
        >
          {profiles && !profiles.available ? (
            <Empty>Browser unavailable on {where}: {profiles.reason}</Empty>
          ) : (
            <RemoteBrowser key={profile} profile={profile} url={navUrl} />
          )}
        </Panel>

        {/* archive */}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Panel title={`Archived conversations (${convs.length})`} right={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search titles" className="w-40 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-zinc-500" />}>
            {convs.length === 0 && <Empty>Nothing archived yet. Log in above and press Sync now.</Empty>}
            <div className="max-h-[60vh] overflow-y-auto">
              {convs.slice(0, 300).map((c) => (
                <button key={`${c.tool}-${c.id}`} onClick={() => setSel(c)} className={`hud-row flex w-full items-center gap-2 px-1 py-1 text-left ${sel?.id === c.id ? "bg-cyan-500/10" : ""}`}>
                  <span className={`shrink-0 rounded px-1 text-[10px] ${c.tool === "chatgpt" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>{c.tool === "chatgpt" ? "gpt" : "claude"}</span>
                  <span className="w-12 shrink-0 text-[10px] text-zinc-500">{isoAgo(c.updated)}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200" title={c.title}>{c.title}</span>
                  <span className="shrink-0 text-[10px] text-zinc-600">{c.messages} msg</span>
                </button>
              ))}
            </div>
          </Panel>
          <Panel
            title={sel ? sel.title : "Conversation"}
            right={sel ? (
              <div className="flex gap-2">
                <button onClick={() => { setProfile(sel.tool === "chatgpt" ? "chatgpt" : "claude"); setNavUrl(sel.url); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="rounded border border-cyan-500/40 px-2 py-0.5 text-[10px] text-cyan-300 hover:bg-cyan-500/10">Open live in browser</button>
                <a href={sel.url} target="_blank" rel="noreferrer" className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800">Site ↗</a>
              </div>
            ) : null}
          >
            {!sel && <Empty>Select an archived conversation.</Empty>}
            {sel && !doc && <Empty>Loading…</Empty>}
            {sel && doc && (
              <div className="max-h-[70vh] overflow-y-auto">
                <div className="pb-2 font-mono text-[10px] text-zinc-500">{doc.frontmatter.provider} · {doc.frontmatter.model ?? "model unknown"} · {doc.frontmatter.messages} messages · updated {doc.frontmatter.updated} · <span className="text-zinc-600">{sel.file}</span></div>
                <Markdown text={doc.markdown} className="text-[12px]" />
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
