import { homedir, hostname } from "os";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { randomBytes } from "crypto";

export const CYBERDECK_HOME = process.env.CYBERDECK_HOME ?? join(homedir(), ".cyberdeck");

export interface CyberdeckConfig {
  /** Optional applications and physical fullscreen browser on this machine. */
  applications?: { id: string; name: string; description: string; url: string }[];
  kiosk?: { enabled: boolean };
  /** Casework Seed bridge behind the kitchen sink's Agent tab (`/api/seed/*`); the token file defaults to
   *  ~/Library/Application Support/CaseworkSeed/bridge-token. */
  casework?: { url?: string; tokenFile?: string };
  /** Small, staggered peer throughput probes, at most once per peer every six hours. */
  network?: { automatic?: boolean };
  nodeName: string;
  port: number;
  /** Who may reach the daemon: "tailscale" (default) listens on all interfaces but only
   *  accepts loopback and tailnet source addresses; "lan" accepts anything (token-gated);
   *  an explicit IP binds just that address. */
  bind: string;
  /** Tailscale login (e.g. you@example.com) whose tailnet devices are trusted without a
   *  token. null = detect from `tailscale status` at boot and persist. */
  tailscaleOwner?: string | null;
  /** Directories scanned for repos and novel data. */
  roots: string[];
  /** User-data locations inventoried by the data scan (sizes, cache split). */
  dataRoots: string[];
  /** Directory basenames inside data roots that are app caches (reclaimable). */
  cacheDirs: string[];
  /** Watch roots for changes and rescan automatically. */
  watch: boolean;
  /** Keep this node's software current (pull origin + rebuild + restart),
   *  and accept update nudges from fleet peers. */
  autoUpdate: boolean;
  /** Directory basenames treated as derivable junk (reclaimable, never novel). */
  junkDirs: string[];
  /** Directory basenames never descended into while scanning. */
  skipDirs: string[];
  /** Max directory depth when searching roots for git repos. */
  scanDepth: number;
  /** Checkout of the private Fleet repo (projects, handoff, sessions index, collab queue).
   *  The control module shells out to its `bin/deck.ts` CLI. null disables the module. */
  fleetDir?: string | null;
  /** Autonomous agent collaboration: when `auto` is on, `fleet collab tick` runs every
   *  `intervalMinutes` (skipped while a run is in progress). */
  collab?: { auto: boolean; intervalMinutes: number };
  /** Backup replication (ROADMAP M2, not built yet). `targets` are fleet node names that
   *  should hold a copy of this node's novel data; the home dashboard reads it. */
  backup?: { targets: string[] };
  /** Seed agents bridge (voice): which agents server to sign into and as whom. See docs/VOICE.md. */
  seed?: Partial<SeedConfig>;
}

/** Resolved Seed bridge settings: defaults, then `config.seed`, then the CYBERDECK_SEED_* env overrides. */
export interface SeedConfig {
  /** Seed agents server base URL (the voice-capable instance). */
  agentsUrl: string;
  /** Name of the local Seed vault account that signs actions (`cyberdeck seed status` shows whether it loads). */
  identity: string;
  /** Agent and session the voice calls go to; filled by `cyberdeck seed setup` (persisted in seed.json, not here). */
  agentId?: string;
  sessionId?: string;
  /** Model used when setup has to create the "Cyberdeck" agent. */
  modelProvider: string;
  model: string;
}

export const SEED_DEFAULTS: SeedConfig = { agentsUrl: "http://127.0.0.1:3053", identity: "main", modelProvider: "OpenAI", model: "gpt-6-sol" };

export function seedConfig(cfg: Pick<CyberdeckConfig, "seed">, env: NodeJS.ProcessEnv = process.env): SeedConfig {
  const fromFile = Object.fromEntries(Object.entries(cfg.seed ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const out: SeedConfig = { ...SEED_DEFAULTS, ...fromFile };
  if (env.CYBERDECK_SEED_AGENTS_URL) out.agentsUrl = env.CYBERDECK_SEED_AGENTS_URL;
  if (env.CYBERDECK_SEED_IDENTITY) out.identity = env.CYBERDECK_SEED_IDENTITY;
  out.agentsUrl = out.agentsUrl.replace(/\/+$/, "");
  return out;
}

const DEFAULTS: CyberdeckConfig = {
  nodeName: hostname().replace(/\.local$/, ""),
  port: 4777,
  bind: "tailscale",
  tailscaleOwner: null,
  roots: [join(homedir(), "Code")],
  dataRoots: [
    join(homedir(), "Desktop"),
    join(homedir(), "Documents"),
    join(homedir(), "Downloads"),
    join(homedir(), "Pictures"),
    join(homedir(), "Movies"),
    join(homedir(), "Music"),
    join(homedir(), "Library", "Application Support"),
  ],
  cacheDirs: [
    "Cache", "Caches", "cache", "GPUCache", "Code Cache", "DawnCache", "DawnGraphiteCache",
    "DawnWebGPUCache", "CachedData", "CachedProfilesData", "CachedExtensions",
    "ShaderCache", "GrShaderCache", "logs", "Logs", "tmp", "Temp", "Crashpad",
    "Service Worker", "blob_storage", "IndexedDB-journal",
  ],
  watch: true,
  autoUpdate: true,
  junkDirs: [
    "node_modules", ".next", ".turbo", ".cache", "dist", "build", ".parcel-cache",
    "target", ".gradle", "Pods", "DerivedData", ".venv", "venv", "__pycache__",
    ".expo", ".vercel", ".output", "coverage",
  ],
  skipDirs: [".git", "Library", ".Trash"],
  scanDepth: 3,
  fleetDir: [join(homedir(), "Code", "Deck"), join(homedir(), "Code", "Fleet")].find((d) => existsSync(d)) ?? null,
  collab: { auto: false, intervalMinutes: 30 },
};

/** One-time migration from the Steward era: copy identity + data into ~/.cyberdeck (the old dir is left for the old service until install.sh re-runs). */
function migrateFromSteward(): void {
  const old = join(homedir(), ".steward");
  if (process.env.CYBERDECK_HOME || !existsSync(old) || existsSync(join(CYBERDECK_HOME, "node-id"))) return;
  mkdirSync(CYBERDECK_HOME, { recursive: true });
  const pairs: [string, string][] = [["token", "token"], ["node-id", "node-id"], ["config.json", "config.json"], ["steward.db", "cyberdeck.db"]];
  for (const [from, to] of pairs) if (existsSync(join(old, from)) && !existsSync(join(CYBERDECK_HOME, to))) copyFileSync(join(old, from), join(CYBERDECK_HOME, to));
  console.log(`migrated identity and data from ${old} to ${CYBERDECK_HOME}`);
}

export function loadConfig(): CyberdeckConfig {
  migrateFromSteward();
  mkdirSync(CYBERDECK_HOME, { recursive: true });
  const path = join(CYBERDECK_HOME, "config.json");
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + "\n");
    return { ...DEFAULTS };
  }
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  if (onDisk.bind === "0.0.0.0") {
    // The pre-tailscale default was written to every config on first run; it meant
    // "reachable on the LAN". Tighten to the tailnet; set bind to "lan" to opt back in.
    onDisk.bind = "tailscale";
    writeFileSync(path, JSON.stringify(onDisk, null, 2) + "\n");
    console.log('config: bind "0.0.0.0" migrated to "tailscale" (set "lan" to allow LAN clients)');
  }
  return { ...DEFAULTS, ...onDisk, collab: { ...DEFAULTS.collab!, ...(onDisk.collab ?? {}) } };
}

/** Persist a partial config change (merged over what is on disk, not over defaults). */
export function saveConfigPatch(patch: Partial<CyberdeckConfig>): void {
  const path = join(CYBERDECK_HOME, "config.json");
  const onDisk = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...onDisk, ...patch }, null, 2) + "\n");
}

/** Stable node identity, minted on first run. */
export function loadNodeId(): string {
  const path = join(CYBERDECK_HOME, "node-id");
  if (!existsSync(path)) {
    writeFileSync(path, "stw-" + randomBytes(12).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(path, "utf8").trim();
}

/** Bearer token gating the local HTTP API. Created on first run, mode 0600. */
export function loadToken(): string {
  const path = join(CYBERDECK_HOME, "token");
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(path, "utf8").trim();
}
