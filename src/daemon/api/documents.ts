// The owner's published Seed Hypermedia documents, read from a Seed web gateway's public `/api/Query`
// (the same route the Seed CLI's `query <space> --mode AllDescendants --sort updated --reverse` uses).
// Pure network + shaping; the `documents` MCP tool (mcp.ts) speaks it.

export type HmDocument = {
  /** `metadata.name`, else the last path segment. */
  title: string;
  /** The page on the gateway: `<gateway>/hm/<uid>/<path>`. */
  url: string;
  /** The hm:// address (opens in the Seed app). */
  hm: string;
  path: string;
  summary?: string;
  /** ISO times: `updated` is the newest publish of the document, `created` its first. */
  updated: string;
  created: string;
  visibility?: string;
};

type QueryResult = {
  id?: { id?: string; uid?: string; path?: string[] };
  path?: string[];
  metadata?: { name?: string; summary?: string } | null;
  sortTime?: string;
  updateTime?: { seconds?: string | number } | string;
  createTime?: { seconds?: string | number } | string;
  visibility?: string;
};

const iso = (t: QueryResult["updateTime"], fallback = ""): string => {
  if (!t) return fallback;
  if (typeof t === "string") return t;
  const s = Number(t.seconds);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : fallback;
};

/** Shape one gateway result; null when it is not a document with an address. */
export function shapeDocument(gateway: string, r: QueryResult): HmDocument | null {
  const hm = r.id?.id;
  const uid = r.id?.uid ?? hm?.replace(/^hm:\/\//, "").split("/")[0];
  if (!hm || !uid) return null;
  const segments = r.path ?? r.id?.path ?? [];
  const path = segments.join("/");
  const title = (r.metadata?.name ?? "").trim() || segments.at(-1) || uid;
  const created = iso(r.createTime);
  const updated = r.sortTime ?? iso(r.updateTime, created);
  return {
    title,
    url: `${gateway}/hm/${uid}${path ? `/${path}` : ""}`,
    hm,
    path,
    ...(r.metadata?.summary ? { summary: r.metadata.summary } : {}),
    updated,
    created,
    ...(r.visibility ? { visibility: r.visibility } : {}),
  };
}

/** The words of `query` all present in a document's title, summary or path (case-insensitive). */
export function documentMatches(d: HmDocument, query: string): boolean {
  const hay = `${d.title} ${d.summary ?? ""} ${d.path}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "5 days ago", or the date. */
export function ago(isoTime: string, now = Date.now()): string {
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return "at an unknown time";
  const min = Math.round((now - t) / 60_000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return `on ${new Date(t).toISOString().slice(0, 10)}`;
}

export type ListDocumentsOptions = { limit?: number; query?: string; signal?: AbortSignal; fetch?: typeof fetch };

/**
 * The account's documents, newest publish first; with `query`, the gateway's newest 60 filtered by its words.
 * Throws with a readable message when the gateway does not answer with the query result.
 */
export async function listDocuments(gateway: string, account: string, opts: ListDocumentsOptions = {}): Promise<HmDocument[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
  const fetchFn = opts.fetch ?? fetch;
  const params = new URLSearchParams({
    includes: JSON.stringify([{ space: account, mode: "AllDescendants" }]),
    sort: JSON.stringify([{ term: "updated", reverse: true }]),
    limit: String(opts.query ? Math.max(limit, 60) : limit),
  });
  const res = await fetchFn(`${gateway}/api/Query?${params}`, { headers: { accept: "application/json" }, signal: opts.signal ?? AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${gateway} answered ${res.status} for the account's documents`);
  const body = (await res.json().catch(() => null)) as { json?: { results?: QueryResult[] }; results?: QueryResult[] } | null;
  const results = body?.json?.results ?? body?.results;
  if (!Array.isArray(results)) throw new Error(`${gateway} did not return a document list (is it a Seed web gateway?)`);
  const docs = results.map((r) => shapeDocument(gateway, r)).filter((d): d is HmDocument => d !== null);
  docs.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  const kept = opts.query ? docs.filter((d) => documentMatches(d, opts.query!)) : docs;
  return kept.slice(0, limit);
}

// ---- Reading one document -------------------------------------------------------------------

/** One block of a document on the gateway (`/api/Resource`): the fields the text rendering needs. */
type HmBlock = {
  type?: string;
  text?: string;
  link?: string;
  attributes?: { childrenType?: string; language?: string; name?: string; alt?: string; level?: number } | null;
};
type HmBlockNode = { block?: HmBlock | null; children?: HmBlockNode[] | null };

export type HmDocumentBody = HmDocument & {
  /** The document as plain markdown-ish text: headings as `#`, lists as `-`/`1.`, code fenced, media named in brackets. */
  text: string;
  words: number;
  /** The heading texts in order, for "what is in it". */
  headings: string[];
  authors: string[];
  version?: string;
  /** True when `text` was cut at `maxChars`. */
  truncated: boolean;
};

/** A document reference as the agent may say it: `hm://uid/path`, `https://<gateway>/hm/uid/path`, or `uid/path`. */
export function parseDocumentRef(ref: string): { uid: string; path: string } | null {
  let s = ref.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    const m = u.pathname.match(/^\/hm\/([^/]+)(\/.*)?$/);
    if (!m) return null;
    s = `${m[1]}${m[2] ?? ""}`;
  } else {
    s = s.replace(/^hm:\/\//i, "");
  }
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  const [uid, ...rest] = s.split("/").filter(Boolean);
  if (!uid || !/^z6Mk[A-Za-z0-9]+$/.test(uid)) return null;
  return { uid, path: rest.join("/") };
}

const listMarker = (childrenType: string | undefined, index: number): string =>
  childrenType === "Unordered" ? "- " : childrenType === "Ordered" ? `${index + 1}. ` : childrenType === "Blockquote" ? "> " : "";

/** Flatten a block tree into readable text; `headings` collects the heading texts in order. */
export function blocksToText(nodes: HmBlockNode[] | null | undefined, headings: string[] = [], depth = 0, parentChildrenType?: string): string {
  const out: string[] = [];
  (nodes ?? []).forEach((n, i) => {
    const b = n.block ?? {};
    const text = (b.text ?? "").trim();
    const indent = "  ".repeat(Math.max(0, depth - 1));
    const marker = depth > 0 ? listMarker(parentChildrenType, i) : "";
    const line = (body: string) => `${indent}${marker}${body}`;
    switch (b.type) {
      case "Heading":
        if (text) { headings.push(text); out.push(line(`${"#".repeat(Math.min(6, depth + 1))} ${text}`)); }
        break;
      case "Code":
        out.push(`${line("```" + (b.attributes?.language ?? ""))}\n${text}\n${line("```")}`);
        break;
      case "Image": out.push(line(`[image${text ? `: ${text}` : ""}]`)); break;
      case "Video": out.push(line(`[video${text ? `: ${text}` : ""}]`)); break;
      case "File": out.push(line(`[file${b.attributes?.name ? `: ${b.attributes.name}` : text ? `: ${text}` : ""}]`)); break;
      case "Embed": out.push(line(`[embedded document${b.link ? ` ${b.link}` : ""}]`)); break;
      case "WebEmbed": out.push(line(`[web embed${b.link ? ` ${b.link}` : ""}]`)); break;
      case "Button": out.push(line(`[button${text ? `: ${text}` : ""}${b.link ? ` -> ${b.link}` : ""}]`)); break;
      case "Math": out.push(line(`$${text}$`)); break;
      default:
        if (text) out.push(line(text));
    }
    const kids = n.children ?? [];
    if (kids.length) out.push(blocksToText(kids, headings, depth + 1, b.attributes?.childrenType ?? undefined));
  });
  return out.filter((s) => s !== "").join("\n\n").replace(/\n{3,}/g, "\n\n");
}

export type ReadDocumentOptions = { maxChars?: number; signal?: AbortSignal; fetch?: typeof fetch };

type ResourceBody = {
  json?: { type?: string; id?: string; document?: ResourceDocument };
  type?: string;
  document?: ResourceDocument;
};
type ResourceDocument = {
  content?: HmBlockNode[];
  metadata?: { name?: string; summary?: string } | null;
  account?: string;
  path?: string;
  authors?: string[];
  version?: string;
  createTime?: string;
  updateTime?: string;
  visibility?: string;
};

/**
 * One published document from the gateway's `/api/Resource`, flattened to text (cut at `maxChars`, default 12000).
 * Throws with a readable message when the reference is not a document or the gateway does not answer.
 */
export async function readDocument(gateway: string, ref: string, opts: ReadDocumentOptions = {}): Promise<HmDocumentBody> {
  const parsed = parseDocumentRef(ref);
  if (!parsed) throw new Error(`"${ref}" is not a Seed document address (expected hm://<uid>/<path> or a ${gateway}/hm/… URL)`);
  const hm = `hm://${parsed.uid}${parsed.path ? `/${parsed.path}` : ""}`;
  const fetchFn = opts.fetch ?? fetch;
  const res = await fetchFn(`${gateway}/api/Resource?${new URLSearchParams({ id: hm })}`, { headers: { accept: "application/json" }, signal: opts.signal ?? AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new Error(`${gateway} has no document at ${hm}`);
  if (!res.ok) throw new Error(`${gateway} answered ${res.status} for ${hm}`);
  const body = (await res.json().catch(() => null)) as ResourceBody | null;
  const kind = body?.json?.type ?? body?.type;
  const doc = body?.json?.document ?? body?.document;
  if (!doc || (kind && kind !== "document")) throw new Error(kind && kind !== "document" ? `${hm} is a ${kind}, not a document` : `${gateway} did not return a document for ${hm} (is it a Seed web gateway?)`);
  const headings: string[] = [];
  const full = blocksToText(doc.content, headings);
  const maxChars = Math.max(200, opts.maxChars ?? 12_000);
  const truncated = full.length > maxChars;
  const text = truncated ? `${full.slice(0, maxChars).replace(/\s+\S*$/, "")}\n\n[... ${full.length - maxChars} more characters]` : full;
  const path = (doc.path ?? parsed.path).replace(/^\/+/, "");
  const uid = doc.account ?? parsed.uid;
  const title = (doc.metadata?.name ?? "").trim() || path.split("/").at(-1) || uid;
  const created = doc.createTime ?? "";
  return {
    title,
    url: `${gateway}/hm/${uid}${path ? `/${path}` : ""}`,
    hm: `hm://${uid}${path ? `/${path}` : ""}`,
    path,
    ...(doc.metadata?.summary ? { summary: doc.metadata.summary } : {}),
    updated: doc.updateTime ?? created,
    created,
    ...(doc.visibility ? { visibility: doc.visibility } : {}),
    text,
    words: full.replace(/^```[^\n]*$/gm, "").replace(/^\s*(#+|[-*]|\d+\.|>)\s+/gm, "").split(/\s+/).filter(Boolean).length,
    headings,
    authors: doc.authors ?? [],
    ...(doc.version ? { version: doc.version } : {}),
    truncated,
  };
}
