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
