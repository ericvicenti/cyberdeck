// Exercise the compressed, encrypted local vault path that the voice API tests bypass.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { encrypt } from "@seed-hypermedia/client/encryption";
import * as cbor from "@seed-hypermedia/client/cbor";

async function vaultSigner(missingDecompression = false) {
  const home = mkdtempSync(join(tmpdir(), "cyberdeck-seed-vault-"));
  // Synthetic test keys only. Never open the developer's vault or OS keychain.
  const seed = new Uint8Array(32).fill(7);
  const kek = new Uint8Array(32).fill(8);
  const dek = new Uint8Array(32).fill(9);
  try {
    const compressed = gzipSync(cbor.encode({ version: 2, accounts: [{ name: "main", seed, createTime: 1, delegations: [] }] }));
    const path = join(home, "vault.json");
    writeFileSync(path, JSON.stringify({
      encryptedData: Buffer.from(await encrypt(compressed, dek)).toString("base64"),
      wrappedDEK: Buffer.from(await encrypt(dek, kek)).toString("base64"),
    }), { mode: 0o600 });
    // Separate process: voice.test.ts sets a seed override, and globals/module caches must
    // not let that override (or another test's runtime) mask the actual vault reader.
    const proc = Bun.spawn([process.execPath, "-e", `
      import { SeedBridge } from "./src/daemon/seed";
      import { seedConfig } from "./src/daemon/config";
      import * as blobs from "@seed-hypermedia/client/blobs";
      if (${missingDecompression}) delete globalThis.DecompressionStream;
      const bridge = new SeedBridge({
        config: seedConfig({}, {}), home: process.env.CYBERDECK_HOME,
        port: 4777, token: "test-only",
        fetch: async () => Response.json({ status: "ok", voice: true }),
      });
      const signer = await bridge.signer();
      if (!signer) console.log(JSON.stringify({ error: (await bridge.status()).identity.error }));
      else {
        const signed = await blobs.sign(signer, { type: "AgentsAction", signer: signer.principal, sig: new Uint8Array(64), account: signer.principal, protocol: 3, action: { _: "ListAgents", ts: 1 } });
        await blobs.nativeCryptoReady;
        const expected = blobs.nobleKeyPairFromSeed(new Uint8Array(32).fill(7));
        console.log(JSON.stringify({ matches: blobs.principalEqual(signer.principal, expected.principal), verified: blobs.verify(signed) }));
      }
    `], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CYBERDECK_HOME: home, CYBERDECK_SEED_KEY_SEED: "", SEED_VAULT_PATH: path, SEED_VAULT_KEK: Buffer.from(kek).toString("base64") },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`vault signer failed (${code}): ${err}`);
    return JSON.parse(out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("local encrypted gzip vault produces the correct signer and valid signed actions", async () => {
  expect(await vaultSigner()).toEqual({ matches: true, verified: true });
});

test("missing DecompressionStream gives an actionable runtime error", async () => {
  expect((await vaultSigner(true)).error).toContain("Run bun upgrade, then cyberdeck restart");
});
