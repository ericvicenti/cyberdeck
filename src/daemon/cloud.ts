// Cloud AI archive: pulls every conversation from Eric's chatgpt.com and claude.ai
// accounts through the logged-in remote-browser profiles (requests run inside
// the page, so the site's own cookies and headers apply) and writes them as
// markdown into the Deck repo, where the 15-minute sync commits them to every
// host. Files are never deleted here, even when the cloud copy disappears.
//
// The site endpoints are unofficial and may change; every fetch is defensive,
// paced, and a sync stops after a few consecutive failures.
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { hostname } from "os";
import { CYBERDECK_HOME } from "./config";
import type { BrowserManager } from "./browser";
import { bus } from "./events";

export type Provider = "chatgpt" | "claude";
export const PROVIDERS: Provider[] = ["chatgpt", "claude"];
export const PROVIDER_INFO: Record<Provider, { profile: string; home: string; tool: "chatgpt" | "claude-web"; convUrl: (id: string) => string }> = {
  chatgpt: { profile: "chatgpt", home: "https://chatgpt.com/", tool: "chatgpt", convUrl: (id) => `https://chatgpt.com/c/${id}` },
  claude: { profile: "claude", home: "https://claude.ai/", tool: "claude-web", convUrl: (id) => `https://claude.ai/chat/${id}` },
};

export type Message = { role: "user" | "assistant"; text: string };
export type Conversation = { provider: Provider; id: string; title: string; created: string; updated: string; url: string; model?: string; messages: Message[] };
export type IndexLine = { host: string; tool: "chatgpt" | "claude-web"; id: string; title: string; cwd: ""; project: null; started: string; updated: string; file: string; messages: number; url: string };
export type ProviderStatus = "ok" | "needs_login" | "unavailable" | "never";
export type ProviderState = { status: ProviderStatus; lastSync: string | null; lastError: string | null; conversations: number; syncing: boolean; known: Record<string, string> };

// ---------- pure helpers (unit tested) ----------

const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
export const safeId = (id: unknown): string | null => (typeof id === "string" && ID_RE.test(id) ? id : null);
const iso = (v: unknown): string => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v) { const d = new Date(v); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return new Date(0).toISOString();
};

/** ChatGPT conversation JSON ({mapping, current_node, title, ...}) → ordered user/assistant messages along the current branch. */
export function linearizeChatgpt(conv: any): Message[] {
  const mapping = conv?.mapping ?? {};
  const chain: any[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = conv?.current_node;
  if (!cur) { // fall back: the deepest leaf
    for (const [id, n] of Object.entries<any>(mapping)) if (!n?.children?.length) { cur = id; break; }
  }
  while (cur && mapping[cur] && !seen.has(cur)) { seen.add(cur); chain.push(mapping[cur]); cur = mapping[cur].parent; }
  chain.reverse();
  const out: Message[] = [];
  for (const node of chain) {
    const m = node?.message; if (!m) continue;
    const role = m.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    const ct = m.content?.content_type;
    let text = "";
    if (ct === "text" || ct === "multimodal_text") text = (m.content.parts ?? []).map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
    else if (ct === "code") text = "```\n" + String(m.content.text ?? "") + "\n```";
    else if (typeof m.content?.text === "string") text = m.content.text;
    text = text.trim();
    if (!text) continue;
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    out.push({ role, text });
  }
  return out;
}

/** Claude conversation JSON ({chat_messages:[{sender, text, content[]}]}) → messages. */
export function normalizeClaude(conv: any): Message[] {
  const out: Message[] = [];
  for (const m of conv?.chat_messages ?? []) {
    const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    let text = "";
    if (Array.isArray(m.content) && m.content.length) text = m.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
    if (!text && typeof m.text === "string") text = m.text;
    text = text.trim();
    if (text) out.push({ role, text });
  }
  return out;
}

export function toConversation(provider: Provider, meta: any, body: any): Conversation | null {
  const id = safeId(provider === "chatgpt" ? meta?.id ?? body?.conversation_id : meta?.uuid ?? body?.uuid);
  if (!id) return null;
  const messages = provider === "chatgpt" ? linearizeChatgpt(body) : normalizeClaude(body);
  const title = String((provider === "chatgpt" ? body?.title ?? meta?.title : body?.name ?? meta?.name) ?? "").trim() || "(untitled)";
  const created = iso(provider === "chatgpt" ? body?.create_time ?? meta?.create_time : body?.created_at ?? meta?.created_at);
  const updated = iso(provider === "chatgpt" ? body?.update_time ?? meta?.update_time : body?.updated_at ?? meta?.updated_at);
  const model = provider === "chatgpt" ? body?.default_model_slug ?? meta?.default_model_slug : body?.model ?? meta?.model;
  return { provider, id, title, created, updated, url: PROVIDER_INFO[provider].convUrl(id), model: typeof model === "string" && model ? model : undefined, messages };
}

/** The archive file format (contract with the Deck repo). */
export function renderMarkdown(c: Conversation): string {
  const fm = [
    "---",
    `provider: ${c.provider}`,
    `id: ${c.id}`,
    `title: ${JSON.stringify(c.title)}`,
    `created: ${c.created}`,
    `updated: ${c.updated}`,
    `url: ${c.url}`,
    ...(c.model ? [`model: ${JSON.stringify(c.model)}`] : []),
    `messages: ${c.messages.length}`,
    "---",
    "",
    `# ${c.title}`,
    "",
  ];
  const body = c.messages.map((m) => `## ${m.role}\n\n${m.text}\n`).join("\n");
  return fm.join("\n") + body;
}

export function indexLine(c: Conversation, host: string, file: string): IndexLine {
  return { host, tool: PROVIDER_INFO[c.provider].tool, id: c.id, title: c.title, cwd: "", project: null, started: c.created, updated: c.updated, file, messages: c.messages.length, url: c.url };
}

/** Replace-or-append one line keyed by id; returns the full index. */
export function upsertIndex(indexPath: string, line: IndexLine): IndexLine[] {
  const rows: IndexLine[] = [];
  if (existsSync(indexPath)) for (const l of readFileSync(indexPath, "utf8").split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch {} }
  const i = rows.findIndex((r) => r.id === line.id);
  if (i >= 0) rows[i] = line; else rows.push(line);
  rows.sort((a, b) => b.updated.localeCompare(a.updated));
  mkdirSync(join(indexPath, ".."), { recursive: true });
  const tmp = indexPath + ".tmp";
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  renameSync(tmp, indexPath);
  return rows;
}

export function readIndex(indexPath: string): IndexLine[] {
  if (!existsSync(indexPath)) return [];
  const rows: IndexLine[] = [];
  for (const l of readFileSync(indexPath, "utf8").split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch {} }
  return rows;
}

/** Write one conversation (markdown + index line). Idempotent. */
export function writeArchive(archiveDir: string, host: string, c: Conversation): { file: string; index: string } {
  const dir = join(archiveDir, "cloud", c.provider);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${c.id}.md`);
  const md = renderMarkdown(c);
  if (!existsSync(file) || readFileSync(file, "utf8") !== md) writeFileSync(file, md);
  const index = join(archiveDir, "cloud", `index-${c.provider}.jsonl`);
  upsertIndex(index, indexLine(c, host, file));
  return { file, index };
}

/** Did an in-page fetch tell us the session is gone? */
export function detectNeedsLogin(r: { status: number; url?: string; body?: string; contentType?: string }): boolean {
  if (r.status === 401 || r.status === 403) return true;
  if (r.url && /\/(login|auth\/login|signin|sign-in)(\/|\?|$)/i.test(r.url)) return true;
  const ct = r.contentType ?? "";
  const body = r.body ?? "";
  if (ct.includes("text/html") && /cf-chl|challenge-platform|Just a moment|Verify you are human/i.test(body)) return true;
  if (ct.includes("text/html") && r.status === 200 && /log in|sign in|Welcome back/i.test(body.slice(0, 20000)) && !/"accessToken"/.test(body)) return true;
  return false;
}

// ---------- the archive service ----------

type FetchResult = { status: number; url: string; contentType: string; body: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CloudArchive {
  private states = new Map<Provider, ProviderState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly host = hostname().toLowerCase().replace(/\.local$/, "");

  constructor(private browsers: BrowserManager, private archiveDir: string, private stateDir = join(CYBERDECK_HOME, "cloud")) {
    for (const p of PROVIDERS) this.states.set(p, this.loadState(p));
  }

  private statePath(p: Provider) { return join(this.stateDir, p, "state.json"); }
  private loadState(p: Provider): ProviderState {
    const base: ProviderState = { status: "never", lastSync: null, lastError: null, conversations: 0, syncing: false, known: {} };
    try { return { ...base, ...JSON.parse(readFileSync(this.statePath(p), "utf8")), syncing: false }; } catch { return base; }
  }
  private saveState(p: Provider) {
    const s = this.states.get(p)!;
    mkdirSync(join(this.stateDir, p), { recursive: true });
    writeFileSync(this.statePath(p), JSON.stringify({ ...s, syncing: undefined }, null, 2));
  }
  indexPath(p: Provider) { return join(this.archiveDir, "cloud", `index-${p}.jsonl`); }
  get dir() { return this.archiveDir; }

  summary() {
    const providers: Record<string, Omit<ProviderState, "known"> & { profileExists: boolean; browserOpen: boolean }> = {};
    for (const p of PROVIDERS) {
      const { known, ...rest } = this.states.get(p)!;
      providers[p] = { ...rest, conversations: readIndex(this.indexPath(p)).length, profileExists: this.browsers.hasProfileOnDisk(PROVIDER_INFO[p].profile), browserOpen: this.browsers.isOpen(PROVIDER_INFO[p].profile) };
    }
    return { archiveDir: this.archiveDir, providers };
  }

  list(p: Provider, q = ""): IndexLine[] {
    const needle = q.trim().toLowerCase();
    const rows = readIndex(this.indexPath(p)).sort((a, b) => b.updated.localeCompare(a.updated));
    return needle ? rows.filter((r) => `${r.title} ${r.id}`.toLowerCase().includes(needle)) : rows;
  }

  read(p: Provider, id: string): { frontmatter: Record<string, string>; markdown: string } | null {
    if (!safeId(id)) return null;
    const file = join(this.archiveDir, "cloud", p, `${id}.md`);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    const frontmatter: Record<string, string> = {};
    if (m) for (const line of m[1].split("\n")) { const kv = line.match(/^(\w+):\s*(.*)$/); if (kv) { let v = kv[2]; if (v.startsWith('"')) { try { v = JSON.parse(v); } catch {} } frontmatter[kv[1]] = v; } }
    return { frontmatter, markdown: m ? text.slice(m[0].length) : text };
  }

  /** Periodic sync for providers that have a browser profile on disk (i.e. Eric logged in once). */
  start(intervalMs = 6 * 60 * 60 * 1000, firstDelayMs = 10 * 60 * 1000) {
    const tick = () => { for (const p of PROVIDERS) if (this.browsers.hasProfileOnDisk(PROVIDER_INFO[p].profile)) this.sync(p).catch(() => {}); };
    setTimeout(tick, firstDelayMs);
    this.timer = setInterval(tick, intervalMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** In-page fetch so the site's cookies/headers apply. Returns a plain result; never throws on HTTP errors. */
  private async pageFetch(page: import("playwright").Page, url: string, headers: Record<string, string> = {}): Promise<FetchResult> {
    return page.evaluate(async ({ url, headers }) => {
      try {
        const r = await fetch(url, { credentials: "include", headers });
        return { status: r.status, url: r.url, contentType: r.headers.get("content-type") ?? "", body: await r.text() };
      } catch (e) { return { status: 0, url, contentType: "", body: String(e) }; }
    }, { url, headers });
  }

  async sync(p: Provider): Promise<ProviderState> {
    const s = this.states.get(p)!;
    if (s.syncing) return s;
    s.syncing = true;
    const info = PROVIDER_INFO[p];
    let failures = 0, written = 0, checked = 0;
    const fail = (msg: string) => { failures++; s.lastError = msg; console.warn(`cloud ${p}: ${msg}`); return failures >= 3; };
    try {
      const profile = await this.browsers.get(info.profile);
      const page = profile.page;
      if (!page.url().startsWith(info.home)) await page.goto(info.home, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await sleep(1500);
      const landed = page.url();
      if (detectNeedsLogin({ status: 200, url: landed })) { s.status = "needs_login"; s.lastError = `redirected to ${landed}`; return s; }

      // Enumerate
      type Meta = { id: string; updated: string; raw: any };
      const metas: Meta[] = [];
      let authHeaders: Record<string, string> = {};
      if (p === "chatgpt") {
        const sess = await this.pageFetch(page, "https://chatgpt.com/api/auth/session");
        let tokenVal = "";
        try { tokenVal = JSON.parse(sess.body)?.accessToken ?? ""; } catch {}
        if (detectNeedsLogin(sess) || !tokenVal) { s.status = "needs_login"; s.lastError = `no session (${sess.status})`; return s; }
        authHeaders = { authorization: `Bearer ${tokenVal}` };
        for (let offset = 0, total = Infinity; offset < total && offset < 5000; offset += 50) {
          const r = await this.pageFetch(page, `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=50&order=updated`, authHeaders);
          if (detectNeedsLogin(r)) { s.status = "needs_login"; s.lastError = `list ${r.status}`; return s; }
          let j: any; try { j = JSON.parse(r.body); } catch { if (fail(`list parse error at ${offset}`)) break; continue; }
          if (r.status !== 200 || !Array.isArray(j?.items)) { if (fail(`list ${r.status} at ${offset}`)) break; continue; }
          total = typeof j.total === "number" ? j.total : offset + j.items.length;
          for (const it of j.items) { const id = safeId(it.id); if (id) metas.push({ id, updated: iso(it.update_time), raw: it }); }
          if (!j.items.length) break;
          await sleep(300);
        }
      } else {
        const orgs = await this.pageFetch(page, "https://claude.ai/api/organizations");
        if (detectNeedsLogin(orgs)) { s.status = "needs_login"; s.lastError = `organizations ${orgs.status}`; return s; }
        let orgList: any[] = []; try { orgList = JSON.parse(orgs.body); } catch {}
        const org = (Array.isArray(orgList) ? orgList : []).find((o) => Array.isArray(o?.capabilities) ? o.capabilities.includes("chat") : true) ?? orgList[0];
        if (!org?.uuid) { s.status = "needs_login"; s.lastError = "no organization in session"; return s; }
        const r = await this.pageFetch(page, `https://claude.ai/api/organizations/${org.uuid}/chat_conversations`);
        if (detectNeedsLogin(r)) { s.status = "needs_login"; s.lastError = `conversations ${r.status}`; return s; }
        let list: any[] = []; try { list = JSON.parse(r.body); } catch { fail("conversation list parse error"); }
        if (!Array.isArray(list)) { fail(`conversation list ${r.status}`); list = []; }
        for (const it of list) { const id = safeId(it.uuid); if (id) metas.push({ id, updated: iso(it.updated_at), raw: { ...it, org: org.uuid } }); }
      }

      // Fetch changed conversations (paced, sequential; the sites rate-limit hard)
      for (const m of metas) {
        if (failures >= 3) break;
        checked++;
        if (s.known[m.id] === m.updated && existsSync(join(this.archiveDir, "cloud", p, `${m.id}.md`))) continue;
        await sleep(300);
        const url = p === "chatgpt" ? `https://chatgpt.com/backend-api/conversation/${m.id}` : `https://claude.ai/api/organizations/${m.raw.org}/chat_conversations/${m.id}?tree=True&rendering_mode=messages&render_all_tools=true`;
        const r = await this.pageFetch(page, url, authHeaders);
        if (detectNeedsLogin(r)) { s.status = "needs_login"; s.lastError = `conversation ${r.status}`; break; }
        if (r.status !== 200) { fail(`conversation ${m.id} ${r.status}`); continue; }
        let body: any; try { body = JSON.parse(r.body); } catch { fail(`conversation ${m.id} parse error`); continue; }
        const conv = toConversation(p, m.raw, body);
        if (!conv) { fail(`conversation ${m.id} unrecognised shape`); continue; }
        writeArchive(this.archiveDir, this.host, conv);
        s.known[m.id] = m.updated;
        written++;
        failures = 0;
      }
      if (s.status !== "needs_login") { s.status = failures >= 3 ? "unavailable" : "ok"; if (failures < 3) s.lastError = null; }
      s.lastSync = new Date().toISOString();
      console.log(`cloud ${p}: ${checked} listed, ${written} written, status ${s.status}`);
    } catch (e) {
      s.status = "unavailable";
      s.lastError = e instanceof Error ? e.message.split("\n")[0] : String(e);
      console.warn(`cloud ${p}: sync failed: ${s.lastError}`);
    } finally {
      s.syncing = false;
      s.conversations = readIndex(this.indexPath(p)).length;
      this.saveState(p);
      bus.emit({ kind: "cloud", provider: p, status: s.status, conversations: s.conversations });
    }
    return s;
  }
}
