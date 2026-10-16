// Seed agents bridge: signs actions for a Seed agents server as one of this Mac's vault identities,
// keeps the Cyberdeck agent + session pointer, and mints LiveKit voice sessions for the Casework app
// and the web Desk. Every call is a signed DAG-CBOR `AgentsAction` envelope to POST /api/message
// (hypermedia/agent/signed-api.md in the Seed repo). See docs/VOICE.md.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { homedir, hostname } from "os";
import { join } from "path";
import { harnessPrompt, knowledgeSection, memoryPack, readHarnessSources, sha256, PACK_DIR, type HarnessSources } from "./harness";
import * as blobs from "@seed-hypermedia/client/blobs";
import * as cbor from "@seed-hypermedia/client/cbor";
import type { SessionInfo } from "./sessions";
import { CYBERDECK_HOME, type SeedConfig } from "./config";

/** Persisted in `${CYBERDECK_HOME}/seed.json`. */
export type SeedState = {
  queryAgentId?: string; agentId?: string; sessionId?: string; mcpRegisteredAt?: number; mcpTools?: string; lastCallAt?: number; dogfoodTriggerId?: string;
  /** Memory-pack manifests per agent (path → sha256 of what was written), so a sync writes only what changed. */
  memoryPacks?: Record<string, Record<string, string>>;
  /** A pending "Sign in with ChatGPT" login (`cyberdeck seed login`). */
  login?: { loginId: string; providerType: string; startedAt: number };
};

export type SeedHealth = { ok: boolean; voice?: boolean; protocol?: number; version?: string; error?: string; checkedAt: number };

export type SeedStatus = {
  /** Calls can be placed: identity loads, the server answers with voice, and an agent is set up. */
  configured: boolean;
  reason?: string;
  agentsUrl: string;
  identity: { name: string; available: boolean; principal?: string; error?: string; /** Where the key came from: the Seed vault account `name`, the node key file, or the env seed. */ source?: "vault" | "file" | "env" };
  agent?: { id: string; name?: string };
  sessionId?: string;
  health?: SeedHealth;
  mcpRegisteredAt?: number;
  lastCallAt?: number;
  /** The daily fleet check-in trigger (`dogfood()`), read back from the agents server; absent when none. */
  dogfood?: DogfoodStatus;
  /** The voice profile calls will carry (from companion.json) and whether the runtime token to apply it is on hand. */
  profile?: VoiceProfile & { runtimeToken: boolean; source: string };
};

export type DogfoodStatus = { triggerId: string; name: string; enabled: boolean; lastFiredAt?: number; lastError?: string; nextSummary?: string };
export type DogfoodOptions = { timezone?: string; timeOfDay?: string };
type TriggerInfo = { id: string; name: string; enabled: boolean; source: any; lastFiredAt?: number; lastError?: string; createdAt?: number };

/** Cartesia voice id + speaking rate, as the Casework host keeps it in companion.json (`profile`). */
export type VoiceProfile = { voice: string; speed: number };
/** What happened to the profile for one call: applied through the agents server's runtime route, or why not. */
export type VoiceProfileResult = VoiceProfile & { applied: boolean; error?: string };

export type VoiceSession = { sessionId: string; url: string; token: string; room: string; identity: string; expiresAt: number; profile?: VoiceProfileResult };

export type TranscriptMessage = { seq: number; role: "user" | "assistant"; text: string; at: number };
export type Transcript = { supported: boolean; sessionId?: string; messages: TranscriptMessage[]; hasMoreBefore?: boolean; error?: string };

export type SetupOptions = {
  /** Adopt the Casework Companion agent from companion.json when no agent is set up yet (default true). */
  adopt?: boolean;
  /** Create a fresh "Cyberdeck" agent even when one is already set up or a companion could be adopted (CLI `--new`). */
  fresh?: boolean;
  /** Name for a created agent (default "Cyberdeck"). */
  name?: string;
};

export type SetupResult = {
  agent: { id: string; name?: string; origin: "kept" | "adopted" | "created" };
  sessionId: string;
  mcp: { name: string; url: string; state?: string; error?: string; tools?: number };
  warnings: string[];
};

/** Thrown for agents-server errors; `status` is the HTTP status the server answered with. */
export class SeedError extends Error {
  constructor(message: string, public status = 0, public code?: string) { super(message); this.name = "SeedError"; }
}

export const COMPANION_FILE = join(homedir(), "Library", "Application Support", "CaseworkSeed", "companion.json");
/** The experiments agents server's env file; `SEED_AGENTS_VOICE_INTERNAL_TOKEN` in it guards its internal voice routes. */
export const RUNTIME_FILE = join(homedir(), "Library", "Application Support", "CaseworkSeed", "runtime.json");
const RUNTIME_TIMEOUT_MS = 5_000;
// Mirrors the agents server's own validation (voice.ts #handleRuntime) so a bad profile is skipped here, not 400'd there.
const VOICE_ID_RE = /^[a-zA-Z0-9-]{1,100}$/;
const MCP_SERVER_NAME = "cyberdeck";
export const DOGFOOD_TRIGGER_NAME = "cyberdeck-fleet-checkin";
export const DOGFOOD_PROMPT =
  "Daily fleet check-in. Use your cyberdeck tools only (no guessing): call cyberdeck__fleet_status and cyberdeck__services (probe: true) for every host, then cyberdeck__repos and cyberdeck__todo. Write ONE note with cyberdeck__note, under 400 characters, in this shape: 'fleet check-in: <hosts up/down>, <services down or all up>, <repos with unpushed work>, <oldest TODO item worth attention>'. If a tool fails, say which in the note. Do not start any other work.";
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human summary of a schedule source, like the agents server's own trigger pages. */
function scheduleSummary(source: any): string | undefined {
  if (source?.type !== "schedule" || !source.schedule) return undefined;
  const sc = source.schedule;
  if (sc.kind === "interval") return `every ${sc.every} ${sc.unit}`;
  if (sc.kind === "once") return `once at ${new Date(sc.runAt).toISOString()}`;
  if (sc.kind === "weekly") {
    const days: number[] = Array.isArray(sc.daysOfWeek) ? sc.daysOfWeek : [];
    const label = days.length === 7 ? "daily" : days.map((d) => DAY_NAMES[d] ?? String(d)).join(", ");
    return `${label} at ${sc.timeOfDay} ${sc.timezone}`;
  }
  return undefined;
}
const MCP_SECRET_NAME = "cyberdeck-mcp-token";
const HEALTH_TTL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;
const ACTION_TIMEOUT_MS = 60_000;

export type SeedBridgeOptions = {
  config: SeedConfig;
  /** This daemon's port (the MCP server URL registered with Seed points back here). */
  port: number;
  /** This daemon's bearer token, stored on the agents server as the MCP header secret. Never logged. */
  token: string;
  /** Directory holding seed.json (default CYBERDECK_HOME). */
  home?: string;
  /** Casework Companion state to adopt (default the CaseworkSeed app-support file). */
  companionFile?: string;
  /** Agents-server env file holding SEED_AGENTS_VOICE_INTERNAL_TOKEN (default the CaseworkSeed runtime.json). */
  runtimeFile?: string;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
  /** Harness sources: scan roots (the first holds AGENTS.md), the Deck checkout, and whether node tools are on. */
  roots?: string[];
  fleetDir?: string | null;
  nodeTools?: boolean;
};

type Signer = { principal: Uint8Array; sign(data: Uint8Array): Promise<Uint8Array> };

/** Drop `undefined` recursively: DAG-CBOR turns it into null and the signature would not verify. */
function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(omitUndefined) as T;
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = omitUndefined(v);
    return out as T;
  }
  return value;
}

/**
 * The companion's system prompt: a fleet persona for a voice channel. Applied to the agent
 * Cyberdeck creates, and to an adopted companion with `cyberdeck seed prompt --apply`
 * (never silently: the owner may have tuned the agent by hand on the server).
 */
export const fleetPrompt = (name: string) =>
  `You are ${name}, Eric's fleet companion: the voice of Cyberdeck, the daemon on each of Eric's machines (the laptops yacht and starlight, the servers enuc, sentinel, iris and botical, the phone). Eric reaches you by voice from the Casework app on the iPad or the web Desk, so everything you say is read aloud: lead with the answer, one or two short sentences, plain words, no markdown, lists, code or URLs unless he asks for them.

Work from facts, not memory: call your cyberdeck tools before answering and never guess at the state of a machine, a service or a repo. Pass brief true on every call and read the sentence it returns; ask for the full data only when Eric wants details. Say in a few words what you checked ("I probed the services and read the log on enuc") and name the host and the service when something is down. Keep numbers few and sayable.

Before anything that changes a machine or the shared handoff (restarting a service, queueing or starting a collab task, removing a handoff entry) say what you are about to do and wait for a yes. Reading status, logs, notes, repos and sessions needs no confirmation. Leave a trace: handoff_note for what you did on a host, note for something Eric should see later, todo_add for work someone has to pick up.

When a tool fails, say which one and what it said, retry at most once, and offer the next step. When you do not know, say so plainly.`;

export type PromptResult = { agentId: string; name?: string; current: string; desired: string; changed: boolean; applied: boolean };

/** What `syncHarness` did to one agent. */
export type AgentSync = {
  agentId: string;
  name?: string;
  role: "harness" | "voice";
  created: boolean;
  /** The definition fields the sync rewrote (systemPrompt, model, reasoningLevel, mcpServers), or none. */
  definition: string[];
  /** Why the definition was left alone. */
  skipped?: string;
  memory: { written: number; deleted: number; unchanged: number; files: number; error?: string };
};
export type HarnessSyncResult = {
  sources: { rules?: string; deck?: string; notes: number };
  promptBytes: number;
  agents: AgentSync[];
  warnings: string[];
};
export type HarnessStatus = {
  nodeTools: boolean;
  model: string; reasoningLevel: string;
  sources: { rules?: string; deck?: string; notes: number; memoryDirs: string[] };
  queryAgent?: { id: string; name?: string; model?: string; reasoningLevel?: string; promptHash?: string; promptCurrent: boolean; memoryFiles: number };
  voiceAgent?: { id: string; name?: string; managed: boolean; promptCurrent: boolean; memoryFiles: number };
};
export type LoginStart = { loginId: string; authUrl: string; expiresAt: number; providerType: string };
export type LoginStatus = { loginId: string; status: "pending" | "completed" | "failed"; secretName?: string; error?: string; provider?: string };

/** Marker kept in an agent's `metadata` so a later sync knows which prompt it wrote. */
const META_KEY = "cyberdeck";
type CyberdeckMeta = { promptHash?: string; node?: string; role?: "harness" | "voice"; syncedAt?: number };
const metaOf = (definition: Record<string, unknown>): CyberdeckMeta => {
  const m = definition.metadata;
  const c = m && typeof m === "object" ? (m as Record<string, unknown>)[META_KEY] : undefined;
  return c && typeof c === "object" ? (c as CyberdeckMeta) : {};
};

export class SeedBridge {
  readonly config: SeedConfig;
  readonly stateFile: string;
  readonly companionFile: string;
  readonly runtimeFile: string;
  #port: number;
  #token: string;
  #fetch: typeof fetch;
  #state: SeedState;
  #signer: Signer | null = null;
  #signerSource: "env" | "file" | "vault" = "vault";
  #signerError: string | null = null;
  #signerLoading: Promise<Signer | null> | null = null;
  #health: SeedHealth | null = null;
  #healthInFlight: Promise<SeedHealth> | null = null;
  #dogfood: { value: DogfoodStatus | undefined; checkedAt: number; agentId: string } | null = null;
  #agentName: string | undefined;
  #agentNameTriedAt = 0;
  #querySetup: Promise<string> | null = null;
  #roots: string[];
  #fleetDir: string | null;
  #nodeTools: boolean;
  #syncing: Promise<HarnessSyncResult> | null = null;

  constructor(opts: SeedBridgeOptions) {
    this.config = opts.config;
    this.#port = opts.port;
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    const home = opts.home ?? CYBERDECK_HOME;
    this.stateFile = join(home, "seed.json");
    this.companionFile = opts.companionFile ?? COMPANION_FILE;
    this.runtimeFile = opts.runtimeFile ?? RUNTIME_FILE;
    this.#roots = opts.roots ?? [join(homedir(), "Code")];
    this.#fleetDir = opts.fleetDir ?? null;
    this.#nodeTools = opts.nodeTools !== false;
    this.#state = this.#load();
    // Agent/session from config.json seed a fresh state file (setup overwrites them in seed.json).
    if (!this.#state.agentId && opts.config.agentId) this.#state.agentId = opts.config.agentId;
    if (!this.#state.sessionId && opts.config.sessionId) this.#state.sessionId = opts.config.sessionId;
  }

  get state(): Readonly<SeedState> { return this.#state; }
  get mcpUrl(): string { return `http://127.0.0.1:${this.#port}/api/mcp`; }

  #load(): SeedState {
    try { return existsSync(this.stateFile) ? (JSON.parse(readFileSync(this.stateFile, "utf8")) as SeedState) : {}; }
    catch (e) { console.error(`seed: unreadable ${this.stateFile}: ${String(e)}`); return {}; }
  }
  #save(): void {
    mkdirSync(join(this.stateFile, ".."), { recursive: true });
    writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.#state, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  // ---- identity -------------------------------------------------------------------------------

  /** Lazy signer: CYBERDECK_SEED_KEY_SEED (hex, 32 bytes; tests and headless boxes) or the local Seed vault account named `identity`. */
  async signer(): Promise<Signer | null> {
    if (this.#signer) return this.#signer;
    if (this.#signerLoading) return this.#signerLoading;
    this.#signerLoading = (async () => {
      try {
        const hex = process.env.CYBERDECK_SEED_KEY_SEED;
        const fileHex = !hex && existsSync(this.config.keyFile) ? readFileSync(this.config.keyFile, "utf8").trim() : null;
        if (hex || fileHex) {
          const seed = hex || fileHex!;
          if (!/^[0-9a-fA-F]{64}$/.test(seed)) throw new Error(hex ? "CYBERDECK_SEED_KEY_SEED must be 32 bytes of hex" : `${this.config.keyFile} must hold 32 bytes of hex`);
          this.#signer = blobs.nobleKeyPairFromSeed(Uint8Array.from(Buffer.from(seed, "hex")));
          this.#signerSource = hex ? "env" : "file";
        } else {
          this.#signerSource = "vault";
          if (typeof DecompressionStream === "undefined") {
            throw new Error(`Bun ${Bun.version} cannot read the Seed vault; Bun 1.3.3 or newer is required. Run bun upgrade, then cyberdeck restart.`);
          }
          const vault = await import("@seed-hypermedia/client/vault-local");
          const accounts = await vault.loadLocalVaultAccounts();
          if (!accounts) throw new Error("no local Seed vault found (is the Seed desktop app or daemon installed on this machine?)");
          const account = accounts.find((a) => a.name === this.config.identity);
          if (!account) throw new Error(`vault has no account named "${this.config.identity}" (available: ${accounts.map((a) => a.name).join(", ") || "none"})`);
          this.#signer = blobs.nobleKeyPairFromSeed(account.seed);
        }
        this.#signerError = null;
        return this.#signer;
      } catch (e) {
        this.#signerError = e instanceof Error ? e.message : String(e);
        return null;
      } finally {
        this.#signerLoading = null;
      }
    })();
    return this.#signerLoading;
  }

  // ---- transport ------------------------------------------------------------------------------

  /** GET /api/health with a 3 s timeout; the answer (good or bad) is cached 10 s. */
  async health(): Promise<SeedHealth> {
    if (this.#health && Date.now() - this.#health.checkedAt < HEALTH_TTL_MS) return this.#health;
    if (this.#healthInFlight) return this.#healthInFlight;
    this.#healthInFlight = (async () => {
      const checkedAt = Date.now();
      try {
        const res = await this.#fetch(`${this.config.agentsUrl}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        if (!res.ok) return (this.#health = { ok: false, error: `HTTP ${res.status}`, checkedAt });
        const j = (await res.json()) as { status?: string; voice?: boolean; protocol?: number; version?: string };
        return (this.#health = { ok: j.status === "ok" || res.ok, voice: j.voice === true, protocol: j.protocol, version: j.version, checkedAt });
      } catch (e) {
        return (this.#health = { ok: false, error: e instanceof Error ? e.message : String(e), checkedAt });
      } finally {
        this.#healthInFlight = null;
      }
    })();
    return this.#healthInFlight;
  }

  /** Sign and send one action; returns the decoded response. Throws SeedError with the server's message. */
  async action<T = any>(input: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<T> {
    const signer = await this.signer();
    if (!signer) throw new SeedError(`Seed identity unavailable: ${this.#signerError ?? "unknown"}`);
    const envelope = await blobs.sign(signer as any, {
      type: "AgentsAction",
      signer: signer.principal,
      sig: new Uint8Array(64),
      account: signer.principal,
      protocol: 3,
      action: omitUndefined({ ...input, ts: Date.now() }),
    } as any);
    let res: Response;
    try {
      res = await this.#fetch(`${this.config.agentsUrl}/api/message`, {
        method: "POST",
        headers: { "content-type": "application/cbor", accept: "application/cbor" },
        body: cbor.encode(envelope) as unknown as BodyInit,
        signal: AbortSignal.timeout(opts.timeoutMs ?? ACTION_TIMEOUT_MS),
      });
    } catch (e) {
      throw new SeedError(`agents server unreachable at ${this.config.agentsUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let body: any = null;
    try { body = bytes.length ? cbor.decode(bytes) : null; } catch { body = null; }
    if (!res.ok) {
      const message = body?.message ?? body?.error ?? `HTTP ${res.status}`;
      throw new SeedError(`${String(input._)} failed: ${message}`, res.status, body?.code);
    }
    if (body?._ === "Error") throw new SeedError(`${String(input._)} failed: ${body.message ?? "error"}`, res.status, body.code);
    return body as T;
  }

  // ---- status ---------------------------------------------------------------------------------

  async status(): Promise<SeedStatus> {
    const [signer, health] = await Promise.all([this.signer(), this.health()]);
    // The name is learned at setup; after a daemon restart, ask the agents server once (best effort).
    if (signer && health.ok && this.#state.agentId && !this.#agentName && Date.now() - this.#agentNameTriedAt > 5 * 60_000) {
      this.#agentNameTriedAt = Date.now();
      await this.action<{ agent: { definition: { name?: unknown } } }>({ _: "GetAgent", agentId: this.#state.agentId })
        .then((r) => { if (typeof r.agent?.definition?.name === "string") this.#agentName = r.agent.definition.name; })
        .catch(() => {});
    }
    const s: SeedStatus = {
      configured: false,
      agentsUrl: this.config.agentsUrl,
      identity: signer
        ? { name: this.config.identity, source: this.#signerSource, available: true, principal: blobs.principalToString(signer.principal) }
        : { name: this.config.identity, available: false, error: this.#signerError ?? undefined },
      health,
      ...(this.#state.agentId ? { agent: { id: this.#state.agentId, ...(this.#agentName ? { name: this.#agentName } : {}) } } : {}),
      ...(this.#state.sessionId ? { sessionId: this.#state.sessionId } : {}),
      ...(this.#state.mcpRegisteredAt ? { mcpRegisteredAt: this.#state.mcpRegisteredAt } : {}),
      ...(this.#state.lastCallAt ? { lastCallAt: this.#state.lastCallAt } : {}),
    };
    if (!signer) s.reason = `Seed identity unavailable: ${this.#signerError}`;
    else if (!health.ok) s.reason = `agents server ${this.config.agentsUrl} unreachable: ${health.error ?? "unknown"}`;
    else if (!health.voice) s.reason = `agents server ${this.config.agentsUrl} has no voice pipeline`;
    else if (!this.#state.agentId) s.reason = "no agent set up yet: run `cyberdeck seed setup`";
    else s.configured = true;
    if (signer && health.ok && this.#state.agentId) {
      const dogfood = await this.#dogfoodStatus().catch(() => undefined);
      if (dogfood) s.dogfood = dogfood;
    }
    const profile = this.voiceProfile();
    if (profile) s.profile = { ...profile, runtimeToken: this.#runtimeToken() !== null, source: this.companionFile };
    return s;
  }

  /** The check-in trigger as the agents server has it; cached 10 s like health. */
  async #dogfoodStatus(): Promise<DogfoodStatus | undefined> {
    const agentId = this.#state.agentId;
    if (!agentId) return undefined;
    if (this.#dogfood && this.#dogfood.agentId === agentId && Date.now() - this.#dogfood.checkedAt < HEALTH_TTL_MS) return this.#dogfood.value;
    const found = await this.#findDogfoodTrigger(agentId);
    const value = found ? this.#toDogfood(found) : undefined;
    this.#dogfood = { value, checkedAt: Date.now(), agentId };
    return value;
  }

  async #findDogfoodTrigger(agentId: string): Promise<TriggerInfo | undefined> {
    const res = await this.action<{ triggers?: TriggerInfo[] }>({ _: "ListAgentTriggers", agentId });
    const triggers = (res.triggers ?? []).filter((t) => t && t.name === DOGFOOD_TRIGGER_NAME);
    // Prefer the id we recorded; else the newest by name.
    return triggers.find((t) => t.id === this.#state.dogfoodTriggerId) ?? triggers.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  }

  #toDogfood(t: TriggerInfo): DogfoodStatus {
    const summary = scheduleSummary(t.source);
    return { triggerId: t.id, name: t.name, enabled: t.enabled !== false, ...(t.lastFiredAt ? { lastFiredAt: t.lastFiredAt } : {}), ...(t.lastError ? { lastError: t.lastError } : {}), ...(summary ? { nextSummary: summary } : {}) };
  }

  /**
   * Make sure the daily fleet check-in schedule trigger exists on the agent (idempotent: reused by
   * name). The agent runs it with the cyberdeck MCP tools and leaves one note in the Deck inbox.
   */
  async dogfood(opts: DogfoodOptions = {}): Promise<DogfoodStatus & { created: boolean }> {
    const agentId = this.#state.agentId;
    if (!agentId) throw new SeedError("no agent set up: run `cyberdeck seed setup`");
    const timeOfDay = opts.timeOfDay?.trim() || "07:00";
    if (!/^\d{2}:\d{2}$/.test(timeOfDay)) throw new SeedError(`timeOfDay must be HH:MM, got "${timeOfDay}"`);
    const timezone = opts.timezone?.trim() || "Europe/Madrid";
    const existing = await this.#findDogfoodTrigger(agentId);
    let trigger = existing;
    let created = false;
    if (!trigger) {
      const res = await this.action<{ trigger: TriggerInfo }>({
        _: "CreateAgentTrigger",
        agentId,
        trigger: {
          name: DOGFOOD_TRIGGER_NAME,
          enabled: true,
          source: { type: "schedule", schedule: { kind: "weekly", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timeOfDay, timezone } },
          prompt: DOGFOOD_PROMPT,
          continuation: { kind: "newThread" },
        },
      });
      trigger = res.trigger;
      created = true;
    }
    if (this.#state.dogfoodTriggerId !== trigger.id) { this.#state.dogfoodTriggerId = trigger.id; this.#save(); }
    const value = this.#toDogfood(trigger);
    this.#dogfood = { value, checkedAt: Date.now(), agentId };
    return { ...value, created };
  }

  /** The shape the Casework app and `/api/state` expect. */
  async voiceSummary(): Promise<{ configured: boolean; provider: "livekit" | "none"; engine: "seed"; reason?: string }> {
    const s = await this.status();
    return { configured: s.configured, provider: s.configured ? "livekit" : "none", engine: "seed", ...(s.reason ? { reason: s.reason } : {}) };
  }

  // ---- setup ----------------------------------------------------------------------------------

  async setup(opts: SetupOptions = {}): Promise<SetupResult> {
    const warnings: string[] = [];
    const name = opts.name?.trim() || "Cyberdeck";
    // 1. MCP server pointing back at this daemon; the bearer token lives on the server as a secret.
    await this.action({ _: "SetSecret", name: MCP_SECRET_NAME, value: new TextEncoder().encode(`Bearer ${this.#token}`), metadata: { purpose: "Authorization header for the cyberdeck MCP server" } });
    const mcpRes = await this.action<{ server?: { status?: { state?: string; error?: string }; tools?: unknown[] } }>({
      _: "SetMcpServer",
      name: MCP_SERVER_NAME,
      config: { url: this.mcpUrl, transport: "http", secretRefs: { Authorization: MCP_SECRET_NAME } },
    });
    const mcp: SetupResult["mcp"] = { name: MCP_SERVER_NAME, url: this.mcpUrl, state: mcpRes?.server?.status?.state, error: mcpRes?.server?.status?.error, tools: Array.isArray(mcpRes?.server?.tools) ? mcpRes!.server!.tools!.length : undefined };
    this.#state.mcpRegisteredAt = Date.now();
    this.#state.mcpTools = (await this.#ownTools().catch(() => [])).join(",") || undefined;
    // Persist now: the agent step below can fail (no model provider yet on a fresh identity) and the MCP record is already on the server.
    this.#save();
    if (mcp.state === "error") warnings.push(`MCP discovery failed: ${mcp.error ?? "unknown"} (the server record is saved; it retries on the next connect)`);

    // 2. The agent: keep, adopt the Casework Companion, or create.
    let agent: SetupResult["agent"] | null = null;
    if (opts.fresh) { this.#state.agentId = undefined; this.#state.sessionId = undefined; this.#agentName = undefined; }
    if (this.#state.agentId) {
      const kept = await this.#grantMcp(this.#state.agentId).catch((e: SeedError) => { warnings.push(`existing agent ${this.#state.agentId} not usable (${e.message}); setting up a new one`); return null; });
      if (kept) agent = { id: this.#state.agentId, name: kept, origin: "kept" };
      else { this.#state.agentId = undefined; this.#state.sessionId = undefined; }
    }
    if (!agent && opts.adopt !== false && !opts.fresh) {
      const companion = this.#readCompanion();
      if (companion?.agentId) {
        try {
          const agentName = await this.#grantMcp(companion.agentId);
          this.#state.agentId = companion.agentId;
          this.#state.sessionId = undefined;
          agent = { id: companion.agentId, name: agentName, origin: "adopted" };
        } catch (e) {
          warnings.push(`could not adopt the Casework Companion agent ${companion.agentId}: ${e instanceof Error ? e.message : String(e)}; creating "${name}" instead`);
        }
      }
    }
    if (!agent) {
      const created = await this.action<{ agentId: string }>({
        _: "CreateAgent",
        definition: { name, systemPrompt: fleetPrompt(name), modelProvider: this.config.modelProvider, model: this.config.model, mcpServers: [MCP_SERVER_NAME] },
      }).catch((e: unknown) => {
        if (e instanceof SeedError && /provider not found/i.test(e.message)) throw new SeedError(`${e.message}: this identity has no model provider named "${this.config.modelProvider}" on ${this.config.agentsUrl}. Run \`cyberdeck seed login\` (Sign in with ChatGPT), then \`cyberdeck seed setup\` again; the MCP server is already registered.`, e.status, e.code);
        throw e;
      });
      this.#state.agentId = created.agentId;
      this.#state.sessionId = undefined;
      this.#agentName = name;
      agent = { id: created.agentId, name, origin: "created" };
    }
    this.#save();

    // 3. A session for the calls.
    const sessionId = await this.ensureSession();
    return { agent, sessionId, mcp, warnings };
  }

  /** This daemon's MCP tool names, from its own `tools/list`. */
  async #ownTools(): Promise<string[]> {
    const res = await fetch(this.mcpUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as { result?: { tools?: { name: string }[] } };
    return (j.result?.tools ?? []).map((t) => t.name).sort();
  }

  /** The agents server keeps the tool list it discovered at registration, so a deploy that adds or
   *  changes tools re-registers the MCP server (same config, fresh discovery) once the list differs. */
  /** The companion's system prompt next to the fleet persona; with `apply`, the persona is written to the agent. */
  async prompt(apply = false): Promise<PromptResult> {
    if (!this.#state.agentId) throw new SeedError("no agent set up yet: run `cyberdeck seed setup`", 409);
    const agentId = this.#state.agentId;
    const res = await this.action<{ agent: { definition: Record<string, unknown> & { name?: string; systemPrompt?: string } } }>({ _: "GetAgent", agentId });
    const definition = res.agent.definition;
    const name = typeof definition.name === "string" ? definition.name : undefined;
    if (name) this.#agentName = name;
    const current = typeof definition.systemPrompt === "string" ? definition.systemPrompt : "";
    const desired = fleetPrompt(name ?? "Cyberdeck");
    const changed = current !== desired;
    let applied = false;
    if (apply && changed) {
      await this.action({ _: "UpdateAgent", agentId, definition: { ...definition, systemPrompt: desired } });
      applied = true;
    }
    return { agentId, name, current, desired, changed, applied };
  }

  async refreshMcp(names?: string[]): Promise<"skipped" | "unchanged" | "refreshed"> {
    if (!this.#state.mcpRegisteredAt) return "skipped";
    const fp = (names ?? (await this.#ownTools())).slice().sort().join(",");
    if (!fp || fp === this.#state.mcpTools) return "unchanged";
    await this.action({ _: "SetMcpServer", name: MCP_SERVER_NAME, config: { url: this.mcpUrl, transport: "http", secretRefs: { Authorization: MCP_SECRET_NAME } } });
    this.#state.mcpTools = fp;
    this.#state.mcpRegisteredAt = Date.now();
    this.#save();
    return "refreshed";
  }

  /** Make sure `agentId` exists and lists the cyberdeck MCP server; returns the agent's name. */
  async #grantMcp(agentId: string): Promise<string | undefined> {
    const res = await this.action<{ agent: { definition: Record<string, unknown> & { name?: string; mcpServers?: string[] } } }>({ _: "GetAgent", agentId });
    const definition = res.agent.definition;
    const servers = Array.isArray(definition.mcpServers) ? definition.mcpServers : [];
    if (!servers.includes(MCP_SERVER_NAME)) {
      await this.action({ _: "UpdateAgent", agentId, definition: { ...definition, mcpServers: [...servers, MCP_SERVER_NAME] } });
    }
    this.#agentName = typeof definition.name === "string" ? definition.name : undefined;
    return this.#agentName;
  }

  #readCompanion(): { agentId?: string; sessionId?: string; profile?: { voice?: unknown; speed?: unknown } } | null {
    try { return existsSync(this.companionFile) ? JSON.parse(readFileSync(this.companionFile, "utf8")) : null; } catch { return null; }
  }

  /** Text queries need a signer and reachable configured agent server; voice support is optional. */
  async queryReady(): Promise<boolean> {
    const [signer, health] = await Promise.all([this.signer(), this.health()]);
    return !!signer && health.ok && !!this.#state.agentId && !!this.#state.mcpRegisteredAt;
  }

  /** A separate agent keeps text queries out of the voice companion's session and spoken-reply prompt. */
  async queryAgent(): Promise<string> {
    if (this.#state.queryAgentId) return this.#state.queryAgentId;
    if (this.#querySetup) return this.#querySetup;
    this.#querySetup = (async () => {
      if (!await this.queryReady()) throw new SeedError("Seed queries are not configured on this node; run cyberdeck seed setup");
      const id = await this.#createHarnessAgent();
      // Best effort: the pack can be synced again later; the agent is usable without it.
      await this.#syncMemory(id, this.#pack()).catch((e) => console.error(`seed: memory pack for ${id}: ${e instanceof Error ? e.message : e}`));
      return id;
    })();
    try { return await this.#querySetup; } finally { this.#querySetup = null; }
  }

  // ---- harness: prompt, memory pack, definition --------------------------------------------------

  #sources(): HarnessSources { return readHarnessSources({ roots: this.#roots, fleetDir: this.#fleetDir, memoryDirs: this.config.memoryDirs }); }
  #ctx() { return { nodeName: this.#nodeName(), hostname: hostname(), mcpName: MCP_SERVER_NAME, nodeTools: this.#nodeTools, packDir: PACK_DIR }; }
  #nodeName(): string { return process.env.CYBERDECK_NODE_NAME ?? hostname().replace(/\.local$/, ""); }
  /** The harness agent's system prompt, from this node's files right now. */
  harnessPromptText(src = this.#sources()): string { return harnessPrompt(src, this.#ctx()); }
  #pack(src = this.#sources()): Map<string, string> { return memoryPack(src, this.#ctx()); }
  #meta(definition: Record<string, unknown>, patch: CyberdeckMeta): Record<string, unknown> {
    const m = definition.metadata && typeof definition.metadata === "object" ? (definition.metadata as Record<string, unknown>) : {};
    return { ...m, [META_KEY]: { ...metaOf(definition), ...patch, node: this.#nodeName(), syncedAt: Date.now() } };
  }

  async #createHarnessAgent(): Promise<string> {
    const prompt = this.harnessPromptText();
    const created = await this.action<{ agentId: string }>({ _: "CreateAgent", definition: {
      name: "Cyberdeck", modelProvider: this.config.modelProvider, model: this.config.model,
      ...(this.config.reasoningLevel ? { reasoningLevel: this.config.reasoningLevel } : {}),
      mcpServers: [MCP_SERVER_NAME],
      systemPrompt: prompt,
      metadata: { [META_KEY]: { promptHash: sha256(prompt), role: "harness", node: this.#nodeName(), syncedAt: Date.now() } },
    } });
    this.#state.queryAgentId = created.agentId;
    this.#save();
    return created.agentId;
  }

  /** Write the pack files that changed since the last sync and delete pack files no longer in it. */
  async #syncMemory(agentId: string, pack: Map<string, string>): Promise<AgentSync["memory"]> {
    const before = this.#state.memoryPacks?.[agentId] ?? {};
    const after: Record<string, string> = {};
    let written = 0, deleted = 0, unchanged = 0;
    // The server is the truth for what exists: a file the manifest claims but the agent lost is rewritten.
    let present: Set<string> | null = null;
    try {
      const r = await this.action<{ entries?: { path: string; type?: string }[] }>({ _: "ListAgentMemoryDir", agentId, path: PACK_DIR });
      present = new Set((r.entries ?? []).map((e) => e.path));
      for (const sub of ["notes"]) {
        const n = await this.action<{ entries?: { path: string }[] }>({ _: "ListAgentMemoryDir", agentId, path: `${PACK_DIR}/${sub}` }).catch(() => null);
        for (const e of n?.entries ?? []) present.add(e.path);
      }
    } catch { present = null; }
    for (const [path, content] of pack) {
      const h = sha256(content);
      after[path] = h;
      if (before[path] === h && (present === null || present.has(path))) { unchanged++; continue; }
      await this.action({ _: "WriteAgentMemoryFile", agentId, path, content });
      written++;
    }
    for (const path of Object.keys(before)) {
      if (after[path]) continue;
      await this.action({ _: "DeleteAgentMemoryFile", agentId, path }).catch(() => {});
      deleted++;
    }
    this.#state.memoryPacks = { ...(this.#state.memoryPacks ?? {}), [agentId]: after };
    this.#save();
    return { written, deleted, unchanged, files: pack.size };
  }

  /**
   * Bring the agents on the server in line with this node: the harness agent gets the prompt built
   * from this node's AGENTS.md files, the configured model and reasoning level, and the cyberdeck
   * MCP grant; both agents get the memory pack. The voice companion's prompt is only touched when
   * Cyberdeck already owns it (metadata marker) or `voice: true` adopts it; its model is never changed.
   * Idempotent: the prompt hash and the pack manifest make a second run a no-op.
   */
  async syncHarness(opts: { voice?: boolean; force?: boolean } = {}): Promise<HarnessSyncResult> {
    if (this.#syncing) return this.#syncing;
    this.#syncing = this.#syncHarness(opts).finally(() => { this.#syncing = null; });
    return this.#syncing;
  }

  async #syncHarness(opts: { voice?: boolean; force?: boolean }): Promise<HarnessSyncResult> {
    if (!await this.queryReady()) throw new SeedError("Seed is not configured on this node; run cyberdeck seed setup");
    const src = this.#sources();
    const pack = this.#pack(src);
    const prompt = harnessPrompt(src, this.#ctx());
    const warnings: string[] = [];
    const agents: AgentSync[] = [];
    const result: HarnessSyncResult = { sources: { rules: src.rules?.path, deck: src.deck?.path, notes: src.notes.length }, promptBytes: prompt.length, agents, warnings };
    if (!src.rules) warnings.push(`no AGENTS.md / CLAUDE.md at ${this.#roots[0] ?? "the scan root"}: the prompt carries no fleet rules`);
    if (!src.deck) warnings.push("no Deck checkout (fleetDir) here: the prompt carries no Deck protocol");

    // 1. The harness agent.
    let created = false;
    let harnessId = this.#state.queryAgentId;
    let def: Record<string, unknown> & { name?: string } | null = null;
    if (harnessId) {
      try { def = (await this.action<{ agent: { definition: Record<string, unknown> } }>({ _: "GetAgent", agentId: harnessId })).agent.definition; }
      catch (e) {
        if (!(e instanceof SeedError && (e.status === 404 || e.status === 403))) throw e;
        warnings.push(`harness agent ${harnessId} is gone from the server; creating a new one`);
        harnessId = undefined;
      }
    }
    if (!harnessId) { harnessId = await this.#createHarnessAgent(); created = true; def = null; }
    const changed: string[] = [];
    if (def) {
      const want: Record<string, unknown> = {};
      const h = sha256(prompt);
      if (opts.force || metaOf(def).promptHash !== h) { want.systemPrompt = prompt; changed.push("systemPrompt"); }
      if (def.model !== this.config.model) { want.model = this.config.model; changed.push("model"); }
      if (def.modelProvider !== this.config.modelProvider) { want.modelProvider = this.config.modelProvider; changed.push("modelProvider"); }
      const level = this.config.reasoningLevel || undefined;
      if ((def.reasoningLevel ?? undefined) !== level) { want.reasoningLevel = level; changed.push("reasoningLevel"); }
      const servers = Array.isArray(def.mcpServers) ? (def.mcpServers as string[]) : [];
      if (!servers.includes(MCP_SERVER_NAME)) { want.mcpServers = [...servers, MCP_SERVER_NAME]; changed.push("mcpServers"); }
      if (changed.length) {
        const next = omitUndefined({ ...def, ...want, metadata: this.#meta(def, { promptHash: h, role: "harness" }) });
        if (want.reasoningLevel === undefined && "reasoningLevel" in want) delete (next as Record<string, unknown>).reasoningLevel;
        await this.action({ _: "UpdateAgent", agentId: harnessId, definition: next });
      }
    }
    const memory = await this.#syncMemory(harnessId, pack).catch((e): AgentSync["memory"] => ({ written: 0, deleted: 0, unchanged: 0, files: pack.size, error: e instanceof Error ? e.message : String(e) }));
    agents.push({ agentId: harnessId, name: typeof def?.name === "string" ? def.name : "Cyberdeck", role: "harness", created, definition: created ? ["created"] : changed, memory });

    // 2. The voice companion: same knowledge appended to its spoken persona, same pack.
    const voiceId = this.#state.agentId;
    if (voiceId && voiceId !== harnessId) {
      let vdef: Record<string, unknown> & { name?: string } | null = null;
      try { vdef = (await this.action<{ agent: { definition: Record<string, unknown> } }>({ _: "GetAgent", agentId: voiceId })).agent.definition; }
      catch (e) { warnings.push(`voice agent ${voiceId}: ${e instanceof Error ? e.message : e}`); }
      if (vdef) {
        const name = typeof vdef.name === "string" ? vdef.name : "Cyberdeck";
        const persona = `${fleetPrompt(name)}\n\n${knowledgeSection(src, this.#ctx())}`;
        const h = sha256(persona);
        const meta = metaOf(vdef);
        const owned = meta.role === "voice" && !!meta.promptHash;
        const vchanged: string[] = [];
        let skipped: string | undefined;
        if (!owned && !opts.voice) skipped = "the companion's prompt is not managed by Cyberdeck; `cyberdeck seed sync --voice` adopts it";
        else if (opts.force || meta.promptHash !== h) {
          await this.action({ _: "UpdateAgent", agentId: voiceId, definition: omitUndefined({ ...vdef, systemPrompt: persona, metadata: this.#meta(vdef, { promptHash: h, role: "voice" }) }) });
          vchanged.push("systemPrompt");
        }
        const vmem = await this.#syncMemory(voiceId, pack).catch((e): AgentSync["memory"] => ({ written: 0, deleted: 0, unchanged: 0, files: pack.size, error: e instanceof Error ? e.message : String(e) }));
        agents.push({ agentId: voiceId, name, role: "voice", created: false, definition: vchanged, ...(skipped ? { skipped } : {}), memory: vmem });
      }
    }
    return result;
  }

  /** What the harness looks like right now (for `cyberdeck seed status` and the API). */
  async harnessStatus(): Promise<HarnessStatus> {
    const src = this.#sources();
    const out: HarnessStatus = {
      nodeTools: this.#nodeTools, model: this.config.model, reasoningLevel: this.config.reasoningLevel,
      sources: { rules: src.rules?.path, deck: src.deck?.path, notes: src.notes.length, memoryDirs: this.config.memoryDirs },
    };
    const prompt = harnessPrompt(src, this.#ctx());
    const files = (id: string) => Object.keys(this.#state.memoryPacks?.[id] ?? {}).length;
    const qid = this.#state.queryAgentId;
    if (qid) {
      const d = await this.action<{ agent: { definition: Record<string, unknown> } }>({ _: "GetAgent", agentId: qid }).then((r) => r.agent.definition).catch(() => null);
      const meta = d ? metaOf(d) : {};
      out.queryAgent = { id: qid, name: typeof d?.name === "string" ? d.name : undefined, model: typeof d?.model === "string" ? d.model : undefined, reasoningLevel: typeof d?.reasoningLevel === "string" ? d.reasoningLevel : undefined, promptHash: meta.promptHash, promptCurrent: meta.promptHash === sha256(prompt), memoryFiles: files(qid) };
    }
    const vid = this.#state.agentId;
    if (vid && vid !== qid) {
      const d = await this.action<{ agent: { definition: Record<string, unknown> } }>({ _: "GetAgent", agentId: vid }).then((r) => r.agent.definition).catch(() => null);
      const meta = d ? metaOf(d) : {};
      const name = typeof d?.name === "string" ? d.name : undefined;
      const persona = `${fleetPrompt(name ?? "Cyberdeck")}\n\n${knowledgeSection(src, this.#ctx())}`;
      out.voiceAgent = { id: vid, name, managed: meta.role === "voice" && !!meta.promptHash, promptCurrent: meta.promptHash === sha256(persona), memoryFiles: files(vid) };
    }
    return out;
  }

  // ---- node identity and provider sign-in ------------------------------------------------------------

  /** Create the node's own Seed signing key (for machines without a vault). Refuses to overwrite unless `force`. */
  keygen(opts: { force?: boolean } = {}): { keyFile: string; created: boolean } {
    const keyFile = this.config.keyFile;
    if (existsSync(keyFile) && !opts.force) return { keyFile, created: false };
    mkdirSync(join(keyFile, ".."), { recursive: true });
    writeFileSync(`${keyFile}.tmp`, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    renameSync(`${keyFile}.tmp`, keyFile);
    this.#signer = null; this.#signerError = null;
    return { keyFile, created: true };
  }

  /** Begin "Sign in with ChatGPT" on the agents server for this identity; the owner opens `authUrl` and pastes the redirect back. */
  async loginStart(providerType = "openai"): Promise<LoginStart> {
    const r = await this.action<{ loginId: string; authUrl: string; expiresAt: number }>({ _: "StartProviderOAuth", providerType });
    this.#state.login = { loginId: r.loginId, providerType, startedAt: Date.now() };
    this.#save();
    return { loginId: r.loginId, authUrl: r.authUrl, expiresAt: r.expiresAt, providerType };
  }

  /** Hand the pasted code (or full redirect URL) to the server, then save the provider record that uses the credentials. */
  async loginSubmit(code: string, loginId = this.#state.login?.loginId): Promise<LoginStatus> {
    if (!loginId) throw new SeedError("no login in progress: run `cyberdeck seed login` first", 409);
    await this.action({ _: "SubmitProviderOAuthCode", loginId, code: code.trim() });
    return this.loginStatus(loginId);
  }

  async loginStatus(loginId = this.#state.login?.loginId): Promise<LoginStatus> {
    if (!loginId) throw new SeedError("no login in progress", 409);
    const r = await this.action<{ loginId: string; status: "pending" | "completed" | "failed"; secretName?: string; error?: string }>({ _: "GetProviderOAuthStatus", loginId });
    const out: LoginStatus = { loginId: r.loginId, status: r.status, ...(r.secretName ? { secretName: r.secretName } : {}), ...(r.error ? { error: r.error } : {}) };
    if (r.status === "completed" && r.secretName) {
      const type = this.#state.login?.providerType ?? "openai";
      await this.action({ _: "SetModelProvider", name: this.config.modelProvider, provider: { name: this.config.modelProvider, type, authMode: "subscription", secretRefs: { oauth: r.secretName } } });
      out.provider = this.config.modelProvider;
      this.#state.login = undefined;
      this.#save();
    } else if (r.status === "failed") { this.#state.login = undefined; this.#save(); }
    return out;
  }

  /** The account's model providers, as the server redacts them. */
  async providers(): Promise<{ name: string; type: string; authMode?: string; authStatus?: string }[]> {
    const r = await this.action<{ providers?: { name: string; type: string; authMode?: string; authStatus?: string }[] }>({ _: "ListModelProviders" });
    return (r.providers ?? []).map((p) => ({ name: p.name, type: p.type, ...(p.authMode ? { authMode: p.authMode } : {}), ...(p.authStatus ? { authStatus: p.authStatus } : {}) }));
  }

  /** Convert server sessions to the shared session-strip shape without inventing a terminal. */
  queryInfo(s: { id: string; title?: string; status?: string; createdAt?: number; updatedAt?: number }): SessionInfo {
    return { id: `seed-${s.id}`, title: s.title || "Seed query", cwd: this.config.agentsUrl, cmd: null, tool: "seed", prompt: null, runner: "agent",
      state: "running", createdAt: s.createdAt ?? 0, exitedAt: null, exitCode: null, clients: 0, lastOutputAt: s.updatedAt ?? null,
      bells: 0, busy: s.status === "streaming" };
  }

  /** List text conversations from the agents server, including after a Cyberdeck restart. */
  async querySessions(): Promise<SessionInfo[]> {
    if (!this.#state.queryAgentId) return [];
    const r = await this.action<{ sessions: Parameters<SeedBridge["queryInfo"]>[0][] }>({ _: "ListSessions", agentId: this.#state.queryAgentId, includeChildren: false, limit: 100 }, { timeoutMs: 5000 });
    return r.sessions.map((s) => this.queryInfo(s));
  }

  /** Start a durable text session. The caller sends the first message after creation. */
  async createQuery(title: string): Promise<SessionInfo> {
    const agentId = await this.queryAgent();
    const r = await this.action<{ sessionId: string }>({ _: "CreateSession", agentId, title });
    return this.queryInfo({ id: r.sessionId, title, createdAt: Date.now() });
  }

  /** Read one query and its transcript; reject access through this API to unrelated agent sessions. */
  async getQuery(id: string, beforeSeq?: number): Promise<any> {
    const r = await this.action<any>({ _: "GetSession", sessionId: id, limit: 100, beforeSeq });
    if (!this.#state.queryAgentId || r.session?.agentId !== this.#state.queryAgentId) throw new SeedError("No such Seed query", 404);
    return r;
  }

  /** Send a text turn, with optional fleet/directory context, to an existing query. */
  async messageQuery(id: string, text: string, context?: string[], clientMessageId?: string): Promise<void> {
    await this.getQuery(id);
    await this.action({ _: "MessageSession", sessionId: id, content: [{ type: "text", text }, ...(context?.length ? [{ type: "context", lines: context }] : [])], clientMessageId });
  }

  // ---- voice profile --------------------------------------------------------------------------

  /** The profile the Casework host set (companion.json `profile`); null when absent or malformed. */
  voiceProfile(): VoiceProfile | null {
    const p = this.#readCompanion()?.profile;
    if (!p || typeof p.voice !== "string" || !VOICE_ID_RE.test(p.voice) || typeof p.speed !== "number" || !(p.speed >= 0.6 && p.speed <= 2)) return null;
    return { voice: p.voice, speed: p.speed };
  }

  /** CYBERDECK_SEED_VOICE_INTERNAL_TOKEN, else SEED_AGENTS_VOICE_INTERNAL_TOKEN from the runtime file. Never logged. */
  #runtimeToken(): string | null {
    const env = process.env.CYBERDECK_SEED_VOICE_INTERNAL_TOKEN?.trim();
    if (env) return env;
    try {
      if (!existsSync(this.runtimeFile)) return null;
      const t = (JSON.parse(readFileSync(this.runtimeFile, "utf8")) as { SEED_AGENTS_VOICE_INTERNAL_TOKEN?: unknown }).SEED_AGENTS_VOICE_INTERNAL_TOKEN;
      return typeof t === "string" && t.trim() ? t.trim() : null;
    } catch { return null; }
  }

  /**
   * Tell the agents server's voice runtime which voice to speak with in `room` (POST /api/voice/runtime,
   * the same call the casework-host script makes). Failures never fail the call: the room still works
   * with the worker's default voice, and the result says why.
   */
  async #applyProfile(room: string, profile: VoiceProfile): Promise<VoiceProfileResult> {
    const r = await this.#runtime({ room, profile });
    return { ...profile, applied: r.ok, ...(r.error ? { error: r.error } : {}) };
  }

  /** One POST to the agents server's internal voice runtime route; never throws, never logs the token. */
  async #runtime(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const token = this.#runtimeToken();
    if (!token) return { ok: false, error: `no voice runtime token (${this.runtimeFile})` };
    try {
      const res = await this.#fetch(`${this.config.agentsUrl}/api/voice/runtime`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RUNTIME_TIMEOUT_MS),
      });
      return res.ok ? { ok: true } : { ok: false, error: `voice runtime HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- sessions -------------------------------------------------------------------------------

  /** The session calls go to: created on demand, following `continue_session` successors like the desktop does. */
  async ensureSession(): Promise<string> {
    if (!this.#state.agentId) throw new SeedError("no agent set up: run `cyberdeck seed setup`");
    if (!this.#state.sessionId) return this.#createSession();
    for (let hop = 0; hop < 50; hop++) {
      let res: { session?: { agentId?: string; continuedTo?: { sessionId?: string } } };
      try { res = await this.action({ _: "GetSession", sessionId: this.#state.sessionId, limit: 1 }); }
      catch (e) {
        if (e instanceof SeedError && (e.status === 404 || e.status === 403)) return this.#createSession();
        throw e;
      }
      const next = res.session?.continuedTo?.sessionId;
      if (!next) return this.#state.sessionId!;
      this.#state.sessionId = next;
      this.#save();
    }
    throw new SeedError("session continuation chain too long");
  }

  async #createSession(): Promise<string> {
    const created = await this.action<{ sessionId: string }>({ _: "CreateSession", agentId: this.#state.agentId!, title: "Cyberdeck voice" });
    this.#state.sessionId = created.sessionId;
    this.#save();
    return created.sessionId;
  }

  /**
   * Start a fresh session for the next call. With `room` (a live call's LiveKit room) the agents server's
   * voice runtime is told to switch that room to the new session too, so the caller keeps talking without
   * hanging up; `room.switched` says whether that worked (the call goes on with the old session if not).
   */
  async resetSession(opts: { room?: string } = {}): Promise<{ sessionId: string; previous?: string; room?: { name: string; switched: boolean; error?: string } }> {
    if (!this.#state.agentId) throw new SeedError("no agent set up: run `cyberdeck seed setup`");
    const previous = this.#state.sessionId;
    const sessionId = await this.#createSession();
    const room = opts.room?.trim() ? await this.#switchRoom(opts.room.trim(), sessionId) : undefined;
    if (room && !room.switched) console.error(`voice: room ${room.name} kept its session: ${room.error}`);
    return { sessionId, ...(previous ? { previous } : {}), ...(room ? { room } : {}) };
  }

  async #switchRoom(name: string, sessionId: string): Promise<{ name: string; switched: boolean; error?: string }> {
    const r = await this.#runtime({ room: name, sessionId });
    return { name, switched: r.ok, ...(r.error ? { error: r.error } : {}) };
  }

  // ---- voice ----------------------------------------------------------------------------------

  async createVoiceSession(): Promise<VoiceSession> {
    const sessionId = await this.ensureSession();
    const r = await this.action<{ url: string; token: string; room: string; identity: string; expiresAt: number }>({ _: "CreateVoiceSession", sessionId });
    this.#state.lastCallAt = Date.now();
    this.#save();
    const wanted = this.voiceProfile();
    const profile = wanted ? await this.#applyProfile(r.room, wanted) : undefined;
    if (profile && !profile.applied) console.error(`voice: profile not applied to ${r.room}: ${profile.error}`);
    return { sessionId, url: r.url, token: r.token, room: r.room, identity: r.identity, expiresAt: r.expiresAt, ...(profile ? { profile } : {}) };
  }

  /** Recent user/assistant messages of the current session (GetSession's transcript tail; cheap). */
  async transcript(limit = 20): Promise<Transcript> {
    const n = Math.max(1, Math.min(200, Math.floor(limit) || 20));
    if (!this.#state.sessionId) return { supported: true, messages: [] };
    const res = await this.action<{ events?: { seq: number; createdAt: number; event: { type?: string; role?: string; content?: unknown } }[]; hasMoreBefore?: boolean }>({ _: "GetSession", sessionId: this.#state.sessionId, limit: n * 3 });
    const messages: TranscriptMessage[] = [];
    for (const ev of res.events ?? []) {
      const p = ev.event;
      if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant") || typeof p.content !== "string" || !p.content.trim()) continue;
      messages.push({ seq: ev.seq, role: p.role, text: p.content, at: ev.createdAt });
    }
    return { supported: true, sessionId: this.#state.sessionId, messages: messages.slice(-n), hasMoreBefore: res.hasMoreBefore || messages.length > n };
  }
}
