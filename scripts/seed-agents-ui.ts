#!/usr/bin/env bun
// Vendors Seed's agents UI package (@seed-hypermedia/agents-ui) into vendor/seed-agents-ui.
//
//   bun scripts/seed-agents-ui.ts [--seed ~/Code/Seed] [--no-build]
//
// Builds frontend/packages/agents-ui in a Seed checkout (its dependencies must be installed there),
// copies dist/ here without source maps, and records the Seed commit in SOURCE.json. Nodes build
// Cyberdeck from this copy, so none of them needs a Seed checkout. Run `bun install` afterwards.
// When the package is on npm, depend on it there instead and delete this script.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = resolve((flag("--seed") ?? join(homedir(), "Code/Seed")).replace(/^~/, homedir()));
const pkg = join(seed, "frontend/packages/agents-ui");
const dest = resolve(import.meta.dir, "../vendor/seed-agents-ui");
if (!existsSync(join(pkg, "package.json"))) throw new Error(`${pkg} is not the agents-ui package (pass --seed <Seed checkout>)`);

const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr.toString()}${r.stdout.toString()}`);
  return r.stdout.toString().trim();
};

if (!args.includes("--no-build")) {
  console.log(`building ${pkg} ...`);
  console.log(run(["node", "scripts/build.mjs"], pkg).split("\n").filter((l) => !l.includes("externalized for browser")).join("\n"));
}
const dist = join(pkg, "dist");
if (!existsSync(join(dist, "index.js"))) throw new Error(`${dist} has no build`);

rmSync(dest, { recursive: true, force: true });
cpSync(dist, dest, { recursive: true, filter: (src) => !src.endsWith(".map") });
// Built files still name their source maps; drop the comments so browsers do not ask for missing files.
for (const file of new Bun.Glob("**/*.js").scanSync(dest)) {
  const path = join(dest, file);
  writeFileSync(path, readFileSync(path, "utf8").replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n"));
}
const source = {
  package: JSON.parse(readFileSync(join(dest, "package.json"), "utf8")).version,
  seedCommit: run(["git", "rev-parse", "HEAD"], seed),
  seedBranch: run(["git", "rev-parse", "--abbrev-ref", "HEAD"], seed),
  seedDirty: run(["git", "status", "--porcelain", "--", "frontend/packages", "agents/protocol"], seed) !== "",
  vendoredAt: new Date().toISOString(),
};
writeFileSync(join(dest, "SOURCE.json"), JSON.stringify(source, null, 2) + "\n");
console.log(`vendored @seed-hypermedia/agents-ui ${source.package} from ${source.seedBranch}@${source.seedCommit.slice(0, 9)}${source.seedDirty ? " (dirty)" : ""} -> ${dest}`);
