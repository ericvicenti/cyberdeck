import type { Hono } from "hono";
import { ArchiveGames } from "./vault-archive";
import { MAX_ROM_BYTES, PLAYER_SYSTEMS, romError } from "../../shared/vault-player";

class DownloadError extends Error {
  constructor(message: string, readonly code = "download_failed") { super(message); }
}
const verification = () => new DownloadError(
  "Vimm requires human verification and cannot provide an automatic download.",
  "verification_required",
);
const decode = (value: string) => value.replace(/&(?:amp|quot|apos|#39|lt|gt);/g, c => ({
  "&amp;": "&", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&lt;": "<", "&gt;": ">",
})[c]!);
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(m => [m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4])]));
}
/** Follow only the normal, enabled download form; never invent media IDs or execute page scripts. */
export function downloadForm(html: string) {
  if (/cf-turnstile|turnstile-message|Checking if you are human|cf-chl-/i.test(html)) throw verification();
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  const form = forms.find(m => attributes(m[1]).id === "dl_form");
  if (!form || /\bdisabled\b/i.test(form[0]) || /download(?:ing|s)? (?:has been |is |are )?(?:removed|unavailable|disabled)|at the request of/i.test(html)) {
    throw new DownloadError("Vimm does not offer an available download for this game. You can still choose an existing game file.", "unavailable");
  }
  const attrs = attributes(form[1]);
  const url = new URL(attrs.action ?? "", "https://vimm.net");
  if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !/^(?:dl|download)\d*\.vimm\.net$/.test(url.hostname) ||
      !/^\/(?:download\/?)?$/.test(url.pathname) || url.search || url.hash) {
    throw new DownloadError("Vimm returned an unfamiliar download address.");
  }
  const method = (attrs.method ?? "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new DownloadError("Unrecognized download form.");
  const fields = new URLSearchParams();
  for (const match of form[2].matchAll(/<input\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    if (a.type?.toLowerCase() !== "hidden" || !a.name || /\bdisabled\b/i.test(match[0])) continue;
    if (!/^[\w-]{1,80}$/.test(a.name) || (a.value ?? "").length > 4096) throw new DownloadError("Unrecognized download field.");
    fields.set(a.name, a.value ?? "");
  }
  if (!/^\d{1,10}$/.test(fields.get("mediaId") ?? "")) throw new DownloadError("Vimm hasn't provided the game download yet.", "unavailable");
  return { url, method, fields };
}
async function boundedText(response: Response) {
  if (!response.body) throw new DownloadError("Vimm returned an empty page.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new DownloadError("Vimm returned an oversized page.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}
function fileName(header: string, id: string, first: Uint8Array, system: string): string {
  let name = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (name) { try { name = decodeURIComponent(name); } catch { name = undefined; } }
  name ??= /filename\s*=\s*"([^"]+)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(header)?.[1];
  name = name?.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 180);
  const zip = first[0] === 0x50 && first[1] === 0x4b && first[2] === 3 && first[3] === 4;
  const seven = Buffer.from(first.subarray(0, 6)).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
  if (zip || seven) return `vimm-${id}.${zip ? "zip" : "7z"}`;
  if (!name || romError(system, name, first.length)) throw new DownloadError("Vimm did not return a supported game file.");
  if (/^\s*(?:<!doctype|<html|<script|\{)/i.test(new TextDecoder().decode(first))) throw new DownloadError("Vimm returned a page instead of a game file.");
  return name;
}

/** A single user-initiated transfer per node, streamed to the browser's existing ROM store. */
export function registerVaultDownloadRoutes(app: Hono, request: typeof fetch = fetch) {
  let active = false;
  const archive = new ArchiveGames(request);
  app.post("/api/vimm/download/:id", async c => {
    const id = c.req.param("id"), system = c.req.query("system") ?? "";
    const title = (c.req.query("title") ?? "").trim(), region = c.req.query("region") ?? "";
    if (title.length > 240 || region.length > 120) return c.json({ error: "Invalid game details." }, 400);
    if (!/^\d{1,8}$/.test(id) || !Object.hasOwn(PLAYER_SYSTEMS, system)) return c.json({ error: "Invalid game or unsupported console." }, 400);
    if (active) return c.json({ error: "Another game is downloading. Try again when it finishes.", code: "busy" }, 409);
    active = true;
    let transferred = false;
    let upstream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(180000)]);
    try {
      let file: Response;
      let source = "Vimm's Lair", resolvedName = "";
      try {
      const page = `https://vimm.net/vault/${id}`;
      const response = await request(page, { redirect: "error", signal, headers: { "User-Agent": "Cyberdeck-Vault/1.0" } });
      const html = await boundedText(response);
      // Some verification pages use HTTP 404. Report the actual challenge first.
      if (/cf-turnstile|turnstile-message|Checking if you are human|cf-chl-/i.test(html)) throw verification();
      if (!response.ok) throw new DownloadError(`Vimm couldn't prepare this game (HTTP ${response.status}).`);
      const form = downloadForm(html);
      if (form.method === "GET") form.url.search = form.fields.toString();
      file = await request(form.url, {
        method: form.method, redirect: "error", signal,
        headers: { "User-Agent": "Cyberdeck-Vault/1.0", Referer: page, ...(form.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://vimm.net" } : {}) },
        ...(form.method === "POST" ? { body: form.fields.toString() } : {}),
      });
      const type = file.headers.get("content-type") ?? "";
      if (!file.ok || /html|json|text\//i.test(type) || !file.body) {
        await file.body?.cancel();
        throw new DownloadError(`Vimm didn't provide a game file (HTTP ${file.status}). Open Vimm for details.`);
      }
      } catch (e) {
        if (!title || signal.aborted) throw e;
        try {
          const result = await archive.file(system, title, region.split(",").map(r => r.trim()).filter(Boolean), signal);
          file = result.response; source = result.source; resolvedName = result.name;
        } catch (error) {
          throw new DownloadError(error instanceof Error ? error.message : "No game download is available right now.", "unavailable");
        }
      }
      if (!file.ok || /html|json|text\//i.test(file.headers.get("content-type") ?? "") || !file.body) {
        await file.body?.cancel();
        throw new DownloadError("The game is unavailable from the current download sources.", "unavailable");
      }
      const length = Number(file.headers.get("content-length")) || 0;
      if (length > MAX_ROM_BYTES) { await file.body.cancel(); throw new DownloadError("This game exceeds the 128 MiB inline-player limit."); }
      upstream = file.body.getReader();
      const prefix: Uint8Array[] = []; let size = 0;
      while (size < 32) {
        const { value, done } = await upstream.read(); if (done) break;
        prefix.push(value); size += value.length;
        if (size > MAX_ROM_BYTES) throw new DownloadError("This game exceeds the inline-player limit.");
      }
      const first = Buffer.concat(prefix);
      const name = fileName(resolvedName ? `attachment; filename*=UTF-8''${encodeURIComponent(resolvedName)}` : file.headers.get("content-disposition") ?? "", id, first, system);
      const displayName = resolvedName && !romError(system, resolvedName, first.length) ? resolvedName : name;
      const reader = upstream;
      const finish = () => { controller.abort(); active = false; };
      const stream = new ReadableStream<Uint8Array>({
        start(s) { s.enqueue(first); },
        async pull(s) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              if (!size || (length && size !== length)) throw new DownloadError("The download was incomplete. Please retry.");
              s.close(); finish(); return;
            }
            size += value.length;
            if (size > MAX_ROM_BYTES) throw new DownloadError("This game exceeds the inline-player limit.");
            s.enqueue(value);
          } catch (e) { s.error(e); await reader.cancel().catch(() => {}); finish(); }
        },
        async cancel() { finish(); await reader.cancel().catch(() => {}); },
      });
      transferred = true;
      return new Response(stream, { headers: {
        "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff",
        "x-vault-filename": encodeURIComponent(displayName), "x-vault-source": source, ...(length ? { "content-length": String(length) } : {}),
      } });
    } catch (e) {
      return c.json({ error: e instanceof DownloadError ? e.message : "The game download was interrupted. Please try again.", code: e instanceof DownloadError ? e.code : "download_failed" }, 502);
    } finally {
      if (!transferred) { controller.abort(); await upstream?.cancel().catch(() => {}); active = false; }
    }
  });
}
