import type { Hono } from "hono";
import {
  VIMM_SYSTEMS,
  systemName,
  type VaultGame,
  type VaultShelf,
} from "../../shared/vimm";

const ORIGIN = "https://vimm.net";
const systems = new Set<string>(VIMM_SYSTEMS.map((s) => s[0]));
const entities: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  eacute: "é",
  ndash: "–",
  mdash: "—",
};
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, code: string) => {
      if (!code.startsWith("#")) return entities[code] ?? all;
      const n =
        code[1].toLowerCase() === "x"
          ? parseInt(code.slice(2), 16)
          : Number(code.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}
const mainContent = (html: string) =>
  html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? "";
/** Parse only known catalog rows; upstream HTML is never rendered in the client. */
export function parseGames(html: string, system = ""): VaultGame[] {
  const games = new Map<string, VaultGame>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (m) => m[1],
    );
    const index = cells.findIndex((c) =>
      /href=["'](?:\/vault\/)?\d+["']/i.test(c),
    );
    if (index < 0) continue;
    const link = cells[index].match(
      /<a\b[^>]*href=["'](?:\/vault\/)?(\d+)["'][^>]*>([\s\S]*?)<\/a>/i,
    )!;
    const title = plain(link[2]);
    if (!title) continue;
    const regionCell = cells[index + 1] ?? "";
    const regions = [
      ...regionCell.matchAll(/<img\b[^>]*title=["']([^"']+)["'][^>]*>/gi),
    ].map((m) => plain(m[1]));
    const ratingText =
      cells.length === 2 ? plain(cells[1]) : plain(cells[index + 4] ?? "");
    const rating = /^\d+(\.\d+)?$/.test(ratingText)
      ? Number(ratingText)
      : undefined;
    const manual = cells[index].match(/href=["']\/manual\/(\d+)["']/)?.[1];
    games.set(link[1], {
      id: link[1],
      title,
      system: system || plain(cells[0]),
      regions,
      ...(cells.length > 2 ? { version: plain(cells[index + 2] ?? "") } : {}),
      ...(rating != null && rating <= 10 ? { rating } : {}),
      ...(manual ? { manual } : {}),
    });
  }
  return [...games.values()];
}
export function parseCatalog(html: string, system: string, page: number) {
  const content = mainContent(html);
  if (/No matches found\./i.test(plain(content)))
    return { games: [], page, pages: page };
  if (!/hovertable/.test(content))
    throw new Error(
      "Vimm returned an unfamiliar catalog page. Open Vimm to continue.",
    );
  const pages = Math.max(
    page,
    ...[...content.matchAll(/[?&](?:amp;)?page=(\d+)/g)].map((m) =>
      Number(m[1]),
    ),
  );
  return { games: parseGames(content, system), page, pages };
}
export function parseShelves(html: string, system: string): VaultShelf[] {
  const content = mainContent(html);
  const shelves: VaultShelf[] = [];
  for (const table of content.matchAll(
    /<table\b[^>]*>\s*<caption>([\s\S]*?)<\/caption>([\s\S]*?)<\/table>/gi,
  )) {
    const title = plain(table[1]);
    if (!/Top \d+|Overall Rating/i.test(title)) continue;
    const games = parseGames(table[2], system).slice(0, 12);
    if (games.length)
      shelves.push({
        title: /Overall/.test(title) ? "Community favorites" : title,
        system,
        games,
      });
  }
  if (!shelves.length)
    throw new Error(
      `The ${systemName(system)} shelves are temporarily unavailable.`,
    );
  return shelves;
}

/** Bounded cache + shared in-flight requests; a handful of upstream connections for the whole node. */
export class VimmClient {
  private cache = new Map<
    string,
    { data: Uint8Array; type: string; expires: number }
  >();
  private pending = new Map<
    string,
    Promise<{ data: Uint8Array; type: string }>
  >();
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  async get(
    path: string,
    image = false,
  ): Promise<{ data: Uint8Array; type: string }> {
    const key = `${image}:${path}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.queue.length >= 100)
      throw new Error("The Vault is busy. Try again shortly.");
    const job = this.load(path, image)
      .then((result) => {
        this.cache.delete(key);
        this.cache.set(key, {
          ...result,
          expires: this.now() + (image ? 21600000 : 600000),
        });
        let bytes = [...this.cache.values()].reduce(
          (n, x) => n + x.data.byteLength,
          0,
        );
        while (this.cache.size > 256 || bytes > 32 * 1024 * 1024) {
          const first = this.cache.keys().next().value!;
          bytes -= this.cache.get(first)!.data.byteLength;
          this.cache.delete(first);
        }
        return result;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }
  private async load(path: string, image: boolean) {
    if (this.active >= 4)
      await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
    try {
      const response = await this.request(
        (image ? "https://dl.vimm.net" : ORIGIN) + path,
        {
          redirect: "error",
          signal: AbortSignal.timeout(12000),
          headers: {
            "User-Agent": "Cyberdeck-Vault/1.0",
            ...(image ? { Referer: `${ORIGIN}/vault/` } : {}),
          },
        },
      );
      if (!response.ok && !(response.status === 404 && !image)) {
        await response.body?.cancel();
        throw new Error(
          `Vimm is unavailable (HTTP ${response.status}). Try again or open Vimm.`,
        );
      }
      const type = response.headers.get("content-type")?.split(";")[0] ?? "";
      if (
        image
          ? !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
              type,
            )
          : type !== "text/html"
      ) {
        await response.body?.cancel();
        throw new Error("Unexpected response from Vimm.");
      }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("Vimm response is too large.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      if (
        !image &&
        /cf-turnstile|turnstile-message|Checking if you are human/i.test(
          new TextDecoder().decode(data),
        )
      ) {
        throw new Error(
          "Vimm needs human verification. Open Vimm in your browser, or try again later.",
        );
      }
      if (
        !response.ok &&
        !/No matches found\./i.test(
          plain(mainContent(new TextDecoder().decode(data))),
        )
      )
        throw new Error(
          `Vimm is unavailable (HTTP ${response.status}). Try again or open Vimm.`,
        );
      return { data, type };
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
  async html(path: string) {
    return new TextDecoder().decode((await this.get(path)).data);
  }
}
export function registerVimmRoutes(app: Hono, client = new VimmClient()) {
  app.get("/api/vimm/home", async (c) => {
    const result = await Promise.allSettled(
      ["SNES", "PS1", "N64", "Genesis"].map(
        async (system) =>
          parseShelves(await client.html(`/vault/${system}`), system)[0]!,
      ),
    );
    const shelves: VaultShelf[] = [],
      errors: string[] = [];
    for (const r of result) {
      if (r.status === "fulfilled") shelves.push(r.value);
      else errors.push(r.reason.message);
    }
    return c.json(
      {
        shelves,
        errors,
        ...(!shelves.length
          ? { error: errors[0] ?? "Vimm is temporarily unavailable." }
          : {}),
      },
      shelves.length ? 200 : 502,
    );
  });
  app.get("/api/vimm/catalog", async (c) => {
    const system = c.req.query("system") ?? "",
      q = (c.req.query("q") ?? "").trim();
    const letter = c.req.query("letter") ?? "",
      pageText = c.req.query("page") ?? "1";
    if (
      (system && !systems.has(system)) ||
      q.length > 120 ||
      (q && q.length < 3) ||
      (letter && !/^(number|[A-Z])$/.test(letter)) ||
      !/^\d{1,4}$/.test(pageText) ||
      Number(pageText) < 1 ||
      (!q && !system)
    )
      return c.json(
        { error: "Choose a console or search with 3–120 characters." },
        400,
      );
    try {
      if (!q && !letter)
        return c.json({
          shelves: parseShelves(await client.html(`/vault/${system}`), system),
        });
      const params = new URLSearchParams({ p: "list", page: pageText });
      if (system) params.set("system", system);
      if (q) params.set("q", q);
      else params.set("section", letter);
      const source = `${ORIGIN}/vault/?${params}`;
      return c.json({
        ...parseCatalog(
          await client.html(`/vault/?${params}`),
          system,
          Number(pageText),
        ),
        source,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      return c.json(
        {
          error:
            e instanceof Error ? e.message : "Vimm is temporarily unavailable.",
        },
        502,
      );
    }
  });
  app.get("/api/vimm/image/:id", async (c) => {
    const id = c.req.param("id"),
      type = c.req.query("type") ?? "box";
    if (!/^\d{1,8}$/.test(id) || !["box", "screen"].includes(type))
      return c.json({ error: "Invalid artwork." }, 400);
    try {
      const image = await client.get(`/image.php?type=${type}&id=${id}`, true);
      return new Response(image.data as BodyInit, {
        headers: {
          "content-type": image.type,
          "cache-control": "private, max-age=21600",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return c.json({ error: "Artwork unavailable." }, 502);
    }
  });
}
