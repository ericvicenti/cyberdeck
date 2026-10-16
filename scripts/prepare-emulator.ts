/** Fixed, hash-verified EmulatorJS assets. No npm lifecycle scripts or floating core versions. */
import { createHash } from "crypto";
import { mkdir, rename } from "fs/promises";
import { dirname, join } from "path";
import manifest from "./emulator-assets.json";
const root = join(import.meta.dir, "../ui/public/emulatorjs", manifest.version);
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let downloaded = 0;
const queue = [...manifest.assets];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const asset = queue.shift()!;
      const path = join(root, asset.path);
      const file = Bun.file(path);
      if (
        (await file.exists()) &&
        digest(new Uint8Array(await file.arrayBuffer())) === asset.sha256
      )
        continue;
      const response = await fetch(asset.url, {
        signal: AbortSignal.timeout(60000),
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `Emulator asset ${asset.path}: HTTP ${response.status}`,
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
        throw new Error(`Emulator asset integrity mismatch: ${asset.path}`);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await Bun.write(temp, bytes);
      await rename(temp, path);
      downloaded++;
    }
  }),
);
console.log(
  `EmulatorJS ${manifest.version}: ${manifest.assets.length} assets verified (${downloaded} downloaded).`,
);
