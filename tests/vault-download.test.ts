import { expect, test } from "bun:test";
import { Hono } from "hono";
import { downloadForm, registerVaultDownloadRoutes } from "../src/daemon/api/vault-download";
import { MAX_ROM_BYTES } from "../src/shared/vault-player";
const form = '<form id="dl_form" method="POST" action="//dl3.vimm.net/"><input type="hidden" name="mediaId" value="42"><input type="hidden" name="token" value="a&amp;b"><button>Download</button></form>';
const zip = Uint8Array.from([0x50, 0x4b, 3, 4, ...new Array(100).fill(0)]);
function appWith(fetcher: (url: string | URL | Request, options?: RequestInit) => Response | Promise<Response>) {
  const app = new Hono(); registerVaultDownloadRoutes(app, fetcher as typeof fetch); return app;
}
const play = (app: Hono) => app.request("/api/vimm/download/834?system=NES", { method: "POST" });
test("only enabled normal Vimm forms produce download requests", () => {
  const parsed = downloadForm(form);
  expect(parsed.url.href).toBe("https://dl3.vimm.net/");
  expect(parsed.fields.get("mediaId")).toBe("42");
  expect(parsed.fields.get("token")).toBe("a&b");
  for (const url of ["http://dl3.vimm.net/", "https://vimm.net.evil.test/", "http://127.0.0.1/", "https://dl3.vimm.net:8080/", "https://dl3.vimm.net/other", "https://user@dl3.vimm.net/"]) {
    expect(() => downloadForm(form.replace("//dl3.vimm.net/", url))).toThrow();
  }
  expect(() => downloadForm(form.replace('<button>', '<button disabled>'))).toThrow("available download");
  expect(() => downloadForm(form + 'Download removed at the request of the publisher')).toThrow("available download");
  expect(() => downloadForm('<div class="cf-turnstile"></div>' + form)).toThrow("human verification");
  expect(() => downloadForm(form.replace('value="42"', 'value=""'))).toThrow("hasn't provided");
});
test("play resolves the published form, streams the archive, and accepts a later download", async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const app = appWith((url, options) => {
    calls.push({ url: String(url), options });
    return String(url).includes('/vault/') ? new Response(form) : new Response(zip, { headers: { 'content-type': 'application/zip', 'content-length': String(zip.length) } });
  });
  const result = await play(app);
  expect(result.status).toBe(200);
  expect(result.headers.get('x-vault-filename')).toBe('vimm-834.zip');
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(zip);
  expect(calls[0].url).toBe('https://vimm.net/vault/834');
  expect(calls[1].options?.body).toBe('mediaId=42&token=a%26b');
  expect(calls[1].options?.redirect).toBe('error');
  expect((await play(app)).status).toBe(200);
});
test("verification is reported even when Vimm uses HTTP404, with no file request", async () => {
  let calls = 0;
  const app = appWith(() => { calls++; return new Response('<div class="cf-turnstile">Checking if you are human</div>', { status: 404 }); });
  const response = await play(app);
  expect(response.status).toBe(502);
  expect((await response.json()).code).toBe('verification_required');
  expect(calls).toBe(1);
});
test("invalid consoles and IDs never reach the network", async () => {
  let calls = 0;
  const app = appWith(() => { calls++; return new Response(form); });
  for (const path of ['834?system=PS3','abc?system=NES','834?system=toString'])
    expect((await app.request('/api/vimm/download/'+path, {method:'POST'})).status).toBe(400);
  expect(calls).toBe(0);
});
test("HTML, oversized bodies and foreign file types are rejected and unlock retry", async () => {
  for (const make of [
    () => new Response('<html>Rate limited</html>', {headers:{'content-type':'text/html'}}),
    () => new Response(zip, {headers:{'content-length':String(MAX_ROM_BYTES+1)}}),
    () => new Response('executable', {headers:{'content-disposition':'attachment; filename="game.exe"'}}),
  ]) {
    const app = appWith(url => String(url).includes('/vault/') ? new Response(form) : make());
    expect((await play(app)).status).toBe(502);
    expect((await play(app)).status).toBe(502);
  }
});
test("cancellation releases the single-transfer slot; an incomplete response fails", async () => {
  let release!: () => void;
  const app = appWith(async url => {
    if (String(url).includes('/vault/')) { await new Promise<void>(r => { release = r; }); return new Response(form); }
    return new Response(zip, {headers:{'content-length':String(zip.length+10)}});
  });
  const pending = play(app);
  await Bun.sleep(0);
  expect((await play(app)).status).toBe(409);
  release();
  const response = await pending;
  await expect(response.arrayBuffer()).rejects.toThrow('incomplete');
  const next = play(app); await Bun.sleep(0); release();
  const body = await next; await body.body!.cancel();
  const last = play(app); await Bun.sleep(0); release();
  expect((await last).status).toBe(200);
  await (await last).body?.cancel();
});
