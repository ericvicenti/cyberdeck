import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { romError, MAX_ROM_BYTES } from "../src/shared/vault-player";
import { nodeRoms, registerVaultRomRoutes } from "../src/daemon/api/vault-roms";
test("ROM validation distinguishes supported systems, formats, size and empty files", () => {
  expect(romError("NES", "game.nes", 32768)).toBeNull();
  expect(romError("N64", "game.Z64", 32768)).toBeNull();
  expect(romError("SNES", "game.zip", 32768)).toBeNull();
  expect(romError("PS3", "game.iso", 10)).toContain("not available");
  expect(romError("NES", "page.html", 10)).toContain(".nes");
  expect(romError("NES", "game.nes", 0)).toContain("empty");
  expect(romError("NES", "game.nes", MAX_ROM_BYTES + 1)).toContain("128");
});
test("node library lists and streams only bounded game files confined to Games", async () => {
  const root = await mkdtemp(join(tmpdir(), "vault-roms-"));
  try {
    const dir = join(root, "Games");
    await mkdir(join(dir, "nes", "homebrew"), { recursive: true });
    await writeFile(join(dir, "nes", "homebrew", "demo.nes"), "rom");
    await writeFile(join(root, "secret.nes"), "secret");
    await symlink(join(root, "secret.nes"), join(dir, "nes", "outside.nes"));
    await symlink(root, join(dir, "snes"));
    await writeFile(join(dir, "nes", "readme.txt"), "notes");
    const games = await nodeRoms(dir);
    expect(games).toHaveLength(1);
    expect(games[0].name).toBe("demo.nes");
    const app = new Hono();
    registerVaultRomRoutes(app, dir);
    const listing = await (await app.request("/api/vimm/roms")).json();
    expect(listing.games[0].path).toBeUndefined();
    const file = await app.request(`/api/vimm/roms/${games[0].id}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("rom");
    expect((await app.request("/api/vimm/roms/invalid")).status).toBe(400);
    expect((await app.request("/api/vimm/roms/" + "0".repeat(24))).status).toBe(
      404,
    );
    await rm(join(dir, "nes", "homebrew", "demo.nes"));
    expect((await app.request(`/api/vimm/roms/${games[0].id}`)).status).toBe(
      404,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
