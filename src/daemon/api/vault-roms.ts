import type { Hono } from "hono";
import { createHash } from "crypto";
import { realpath, readdir, stat } from "fs/promises";
import { join, sep } from "path";
import { homedir } from "os";
import {
  PLAYER_SYSTEMS,
  romError,
  type NodeRom,
} from "../../shared/vault-player";

/** Only known game folders, at most one subfolder deep; never follow a path outside Games. */
export async function nodeRoms(
  dir: string,
): Promise<(NodeRom & { path: string })[]> {
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    return [];
  }
  const result: (NodeRom & { path: string })[] = [];
  for (const [system, config] of Object.entries(PLAYER_SYSTEMS)) {
    const walk = async (path: string, depth: number) => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || result.length >= 2000) continue;
        const candidate = join(path, entry.name);
        let resolved: string;
        try {
          resolved = await realpath(candidate);
        } catch {
          continue;
        }
        if (!resolved.startsWith(root + sep)) continue;
        const info = await stat(resolved).catch(() => null);
        if (!info) continue;
        if (info.isDirectory()) {
          if (depth < 1) await walk(resolved, depth + 1);
          continue;
        }
        if (!info.isFile() || romError(system, entry.name, info.size)) continue;
        const id = createHash("sha256")
          .update(system + "/" + resolved)
          .digest("hex")
          .slice(0, 24);
        result.push({
          id,
          system,
          name: entry.name,
          size: info.size,
          path: resolved,
        });
      }
    };
    // Validate the system directory too, including empty/parent symlinks.
    const systemRoot = await realpath(join(root, config.folder)).catch(
      () => "",
    );
    if (systemRoot.startsWith(root + sep)) await walk(systemRoot, 0);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
export function registerVaultRomRoutes(
  app: Hono,
  dir = join(homedir(), "Games"),
) {
  app.get("/api/vimm/roms", async (c) =>
    c.json({ games: (await nodeRoms(dir)).map(({ path: _, ...rom }) => rom) }),
  );
  app.get("/api/vimm/roms/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]{24}$/.test(id))
      return c.json({ error: "Invalid game." }, 400);
    const rom = (await nodeRoms(dir)).find((g) => g.id === id);
    if (!rom)
      return c.json(
        { error: "This game file is no longer in the library." },
        404,
      );
    return new Response(Bun.file(rom.path), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
