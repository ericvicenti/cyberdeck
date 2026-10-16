import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  parseCatalog,
  parseShelves,
  parseGames,
  VimmClient,
  registerVimmRoutes,
} from "../src/daemon/api/vimm";
const fixture = (name: string) =>
  Bun.file(`${import.meta.dir}/fixtures/vimm/${name}.html`).text();
const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
const fake = (
  fn: (url: string, init?: RequestInit) => Response | Promise<Response>,
) => fn as unknown as typeof fetch;

describe("Vimm public catalog adapter", () => {
  test("parses regional results, decoded titles, ratings, and manual links", async () => {
    const r = parseCatalog(await fixture("search"), "NES", 1);
    expect(r.games).toHaveLength(3);
    expect(r.games[2]).toEqual({
      id: "504",
      title: "Legend of Zelda, The",
      system: "NES",
      regions: ["USA"],
      version: "1.1",
      rating: 8.9,
      manual: "783",
    });
    expect(
      parseGames(
        '<tr><td><a href="/vault/123">Tom &amp; Jerry&#039;s &lt;Game&gt;</a></td><td>8.5</td></tr>',
        "NES",
      )[0].title,
    ).toBe("Tom & Jerry's <Game>");
  });
  test("global searches preserve each console and upstream pagination", async () => {
    const r = parseCatalog(await fixture("global"), "", 1);
    expect(r.pages).toBe(3);
    expect(r.games[0].system).toBe("SMS");
    expect(r.games[1].system).toBe("GBA");
    expect(r.games[0].rating).toBeUndefined();
  });
  test("monthly and community shelves use relative and absolute game links", async () => {
    const shelves = parseShelves(await fixture("shelves"), "NES");
    expect(shelves).toHaveLength(2);
    expect(shelves[0].games).toHaveLength(10);
    expect(shelves[0].games[0].id).toBe("834");
    expect(shelves[0].games[0].rating).toBeUndefined();
    expect(shelves[1].games[0].rating).toBe(9.05);
  });
  test("empty results differ from an unrecognized page", async () => {
    expect(parseCatalog(await fixture("empty"), "", 1).games).toEqual([]);
    expect(() => parseCatalog("<main>Maintenance</main>", "", 1)).toThrow(
      "unfamiliar",
    );
  });
  test("deduplicates requests, caches results, and expires entries", async () => {
    let calls = 0,
      now = 0;
    const client = new VimmClient(
      fake(async () => {
        calls++;
        await Bun.sleep(5);
        return html("<main>ok</main>");
      }),
      () => now,
    );
    await Promise.all([client.html("/vault/NES"), client.html("/vault/NES")]);
    await client.html("/vault/NES");
    expect(calls).toBe(1);
    now = 600001;
    await client.html("/vault/NES");
    expect(calls).toBe(2);
  });
  test("upstream errors, verification and unexpected image types fail without caching", async () => {
    for (const response of [
      () => html("offline", 503),
      () => html('<main class="cf-turnstile">Verify</main>'),
      () =>
        new Response("<svg/>", {
          headers: { "content-type": "image/svg+xml" },
        }),
    ]) {
      let calls = 0;
      const client = new VimmClient(
        fake(() => {
          calls++;
          return response();
        }),
      );
      await expect(client.get("/vault/NES")).rejects.toThrow();
      await expect(client.get("/vault/NES")).rejects.toThrow();
      expect(calls).toBe(2);
    }
  });
  test("accepts Vimm's 404 for no matches, but rejects ordinary 404 pages", async () => {
    const empty = await fixture("empty");
    const client = new VimmClient(fake(() => html(empty, 404)));
    expect(
      parseCatalog(await client.html("/vault/?p=list&q=missing"), "", 1).games,
    ).toEqual([]);
    await expect(
      new VimmClient(fake(() => html("<main>Not found</main>", 404))).html(
        "/vault/NES",
      ),
    ).rejects.toThrow("404");
  });
  test("limits all upstream concurrency to four", async () => {
    let active = 0,
      max = 0;
    const client = new VimmClient(
      fake(async () => {
        active++;
        max = Math.max(active, max);
        await Bun.sleep(10);
        active--;
        return html("ok");
      }),
    );
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => client.html(`/vault/?q=${i}`)),
    );
    expect(max).toBe(4);
  });
  test("validates routes before fetching and fixes outbound hosts", async () => {
    const urls: string[] = [];
    const client = new VimmClient(
      fake((url, init) => {
        urls.push(url);
        expect(init?.redirect).toBe("error");
        return html("<main><table class=hovertable></table></main>");
      }),
    );
    const app = new Hono();
    registerVimmRoutes(app, client);
    for (const path of [
      "catalog?system=http://evil",
      "catalog?q=ab",
      "catalog?system=NES&letter=../",
      "catalog?q=abc&page=-1",
      "image/12?type=../../etc",
      "image/abc",
    ])
      expect((await app.request(`/api/vimm/${path}`)).status).toBe(400);
    expect(urls).toHaveLength(0);
    expect(
      (await app.request("/api/vimm/catalog?q=Tom%20%26%20Jerry")).status,
    ).toBe(200);
    expect(urls[0]).toBe(
      "https://vimm.net/vault/?p=list&page=1&q=Tom+%26+Jerry",
    );
  });
  test("home reports partial failures, all-failed home is an actionable error", async () => {
    const shelf = await fixture("shelves");
    const app = new Hono();
    registerVimmRoutes(
      app,
      new VimmClient(
        fake((url) => (url.endsWith("SNES") ? html(shelf) : html("down", 503))),
      ),
    );
    const r = await app.request("/api/vimm/home");
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.shelves).toHaveLength(1);
    expect(data.errors).toHaveLength(3);
    const failed = new Hono();
    registerVimmRoutes(failed, new VimmClient(fake(() => html("down", 503))));
    const bad = await failed.request("/api/vimm/home");
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toContain("503");
  });
  test("images reject active formats and oversized responses", async () => {
    const client = new VimmClient(
      fake(
        () =>
          new Response("<svg/>", {
            headers: { "content-type": "image/svg+xml" },
          }),
      ),
    );
    await expect(client.get("/image.php?type=box&id=1", true)).rejects.toThrow(
      "Unexpected",
    );
    const large = new VimmClient(
      fake(() => html("x".repeat(2 * 1024 * 1024 + 1))),
    );
    await expect(large.html("/vault/NES")).rejects.toThrow("too large");
  });
});
