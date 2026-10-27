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
  /** The run-completed trigger (`runWatch()`) that announces finished harness runs on the Desk. */
  runWatchTriggerId?: string;
  /** The weekly fleet digest trigger (`digest()`), the signing identity it publishes with (secret name on the agents server) and that identity's hm account. */
  digestTriggerId?: string; digestSignerName?: string; digestAccount?: string;
  /** Lines the agent (or its triggers) left for the owner through the `announce` MCP tool; newest last, capped. */
  notices?: Notice[];
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
  /** Where the agents server is told to reach this node's MCP server (loopback unless `seed.mcpUrl` says otherwise). */
  mcpUrl: string;
  /** The `seed.profiles` entry this bridge is (absent for the default bridge). */
  seedProfile?: string;
  identity: { name: string; available: boolean; principal?: string; error?: string; /** Where the key came from: the Seed vault account `name`, the node key file, or the env seed. */ source?: "vault" | "file" | "env" };
  agent?: { id: string; name?: string };
  sessionId?: string;
  health?: SeedHealth;
  mcpRegisteredAt?: number;
  lastCallAt?: number;
  /** The daily fleet check-in trigger (`dogfood()`), read back from the agents server; absent when none. */
  dogfood?: DogfoodStatus;
  /** The run-completed trigger (`runWatch()`) on the voice agent, read back from the agents server; absent when none. */
  runWatch?: DogfoodStatus;
  /** The weekly fleet digest trigger (`digest()`): the schedule plus the hm account the documents are published under. */
  digest?: DigestStatus;
  /** The voice profile calls will carry (from companion.json) and whether the runtime token to apply it is on hand. */
  profile?: VoiceProfile & { runtimeToken: boolean; source: string };
};

export type DogfoodStatus = { triggerId: string; name: string; enabled: boolean; lastFiredAt?: number; lastError?: string; nextSummary?: string;
  /** Check-in only: the date (YYYY-MM-DD) of the newest `fleet check-in` line in the Deck inbox, and whether the last firing left none. */
  lastNoteDate?: string; missedNote?: boolean };
export type DogfoodOptions = { timezone?: string; timeOfDay?: string };
export type DigestOptions = DogfoodOptions & { dayOfWeek?: number };
/** The digest trigger plus where it publishes: `account` is the signing identity's hm account, `signer` its secret name on the agents server, `url` the public listing. */
export type DigestStatus = DogfoodStatus & { account?: string; signer?: string; url?: string };
/** A line left for the owner on the Desk transcript without a call: the `announce` MCP tool writes one, the run-completed trigger drives it. */
export type Notice = { id: string; at: number; text: string; run?: { id?: string; title?: string; status?: string; sessionId?: string };
  /** A `listen` tool call: the Desk and the iPad apply it to the live call (mute / unmute the mic, or leave). */
  control?: { action: ControlAction } };
/** What the agent may do to the owner's microphone and call through the `listen` MCP tool. */
export type ControlAction = "mute" | "unmute" | "hangup";
export const CONTROL_ACTIONS: readonly ControlAction[] = ["mute", "unmute", "hangup"];
export type AnnounceInput = { text?: string; title?: string; status?: string; runId?: string; sessionId?: string; /** The run's answer, appended to a composed line (`delegateResult`). */ summary?: string };
/** A task handed to the harness agent (`delegate`): the session the answer lands in. */
export type DelegateResult = { sessionId: string; title: string; agentId: string };
/** Where a delegated task stands (`delegateResult`): the newest answer, if one has been written yet. */
export type DelegateStatus = { sessionId: string; title: string; state: "running" | "waiting" | "done"; answer?: string; answeredAt?: number; turns: number };
export type AnnounceResult = { announced: boolean; notice?: Notice; reason?: string };
type TriggerInfo = { id: string; name: string; enabled: boolean; source: any; prompt?: string | unknown[]; continuation?: { kind?: string; tool?: string }; lastFiredAt?: number; lastError?: string; createdAt?: number };

/** Cartesia voice id + speaking rate, as the Casework host keeps it in companion.json (`profile`). */
export type VoiceProfile = { voice: string; speed: number };
/** What happened to the profile for one call: applied through the agents server's runtime route, or why not. */
export type VoiceProfileResult = VoiceProfile & { applied: boolean; error?: string };

export type VoiceSession = { sessionId: string; url: string; token: string; room: string; identity: string; expiresAt: number; profile?: VoiceProfileResult };

export type TranscriptMessage = { seq: number; role: "user" | "assistant"; text: string; at: number };
export type Transcript = { supported: boolean; sessionId?: string; messages: TranscriptMessage[]; hasMoreBefore?: boolean; error?: string; notices?: Notice[] };

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
/** How long `delegate` waits for the first turn to be refused before reporting the session as handed off. */
const DELEGATE_GRACE_MS = 1_500;
/** The agents server answers MessageSession when the run ends; a delegated run may take a while. */
const DELEGATE_RUN_TIMEOUT_MS = 30 * 60_000;
// Mirrors the agents server's own validation (voice.ts #handleRuntime) so a bad profile is skipped here, not 400'd there.
const VOICE_ID_RE = /^[a-zA-Z0-9-]{1,100}$/;
const MCP_SERVER_NAME = "cyberdeck";
export const DOGFOOD_TRIGGER_NAME = "cyberdeck-fleet-checkin";
export const DOGFOOD_PROMPT =
  "Daily fleet check-in. Make exactly these five tool calls, in this order, each with brief: true, and no other tool call: 1) cyberdeck__fleet_status, 2) cyberdeck__services with probe: true, 3) cyberdeck__repos with kind: 'unpushed', 4) cyberdeck__todo, 5) cyberdeck__note with text = ONE line under 400 characters in this shape: 'fleet check-in: <hosts up/down>, <services down or all up>, <repos with unpushed work>, <oldest TODO item worth attention>'. Do not look anything up further, do not read tool contracts, do not call todo again: write the note from what the four answers said, and if one of them failed say which inside the note. The note is the only output of this run and nobody reads your text answer, so answer with nothing once the note is written; the run has failed if cyberdeck__note was not called.";
export const RUNWATCH_TRIGGER_NAME = "cyberdeck-run-completed";
/** The fallback thread when the headless tool call cannot run: the agent relays the event to `announce` itself. */
export const RUNWATCH_PROMPT =
  "A run of the fleet agent just finished; its runId, runTitle, runStatus and sessionId are in this message. Call cyberdeck__announce exactly once with them (title, status, runId, sessionId): it writes the line Eric sees on the Desk transcript. Do nothing else: no other tools, no text answer, and no retry if it says the run was skipped.";
export const DIGEST_TRIGGER_NAME = "cyberdeck-fleet-digest";
/** The label of the signing identity `digest()` creates on the agents server; documents are published under its hm account. */
export const DIGEST_SIGNER_LABEL = "Cyberdeck fleet";
/** Where the digests of a signing identity are listed (the hm account's home on the public gateway). */
export function digestUrl(account: string): string { return `https://hyper.media/hm/${account}`; }
/**
 * The weekly digest prompt: fleet facts from the cyberdeck tools, one public hypermedia document under the
 * digest identity's account (top level, `fleet-digest-<date>`, because `document.create` wants an existing parent),
 * then a Deck inbox note and a Desk announcement with the address. The account is baked in so the agent never guesses it.
 */
export function digestPrompt(account: string): string {
  return `Weekly fleet digest. The document slug is today's date as YYYY-MM-DD (for example fleet-digest-2026-10-26). Use your cyberdeck tools only (no guessing): call cyberdeck__fleet_status, cyberdeck__services (probe: true), cyberdeck__repos (kind: 'unpushed') and cyberdeck__todo. Read hm://${account}/:directory and, if an earlier fleet-digest document exists, read the newest one so the new document can say what changed. Then read ~/tools/write/documents once and call write exactly once: address 'hm://${account}/fleet-digest-<date>', options {name: 'Fleet digest <date>'}, content = markdown under 3000 characters with the sections 'Hosts' (up and down, by name), 'Services' (down, or all up), 'Repos' (unpushed work by host), 'TODO' (the oldest items worth attention) and 'Since last week'. The document is public: never include tokens, keys, passwords, IP addresses or file paths. Then call cyberdeck__note exactly once with ONE line under 400 characters: 'fleet digest <date>: hm://${account}/fleet-digest-<date> - <one sentence>', and cyberdeck__announce exactly once with text 'Fleet digest <date> is published at hm://${account}/fleet-digest-<date>'. Nobody reads your final answer: the document, the note and the announcement are the only outputs of this run; if a tool fails, say which in the note. Do not start any other work.`;
}
/**
 * Did the check-in's last firing leave its inbox line? The trigger runs in a fresh session and the note is its
 * only output, so the Deck inbox (`notes/inbox.md`, lines `- YYYY-MM-DD (host) fleet check-in: …`) is the record.
 * The firing's day is taken in the trigger's own timezone; a note dated that day or later means it landed.
 */
export function checkinNoteStatus(inbox: string | null, lastFiredAt: number | undefined, timezone = "Europe/Madrid"): { lastNoteDate?: string; missedNote?: boolean } {
  const dates = inbox ? [...inbox.matchAll(/^-\s+(\d{4}-\d{2}-\d{2})\s+\([^)]*\)\s+fleet check-in:/gm)].map((m) => m[1]) : [];
  const lastNoteDate = dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : undefined;
  if (!lastFiredAt) return lastNoteDate ? { lastNoteDate } : {};
  let fired: string;
  try { fired = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(lastFiredAt)); }
  catch { fired = new Date(lastFiredAt).toISOString().slice(0, 10); }
  return { ...(lastNoteDate ? { lastNoteDate } : {}), missedNote: !lastNoteDate || lastNoteDate < fired };
}
/**
 * The plain text of a trigger prompt as the agents server returns it: the string we sent, or the
 * `seed-prompt-blocks` document it was parsed into (paragraph blocks with `text`). Underscores and
 * whitespace are dropped before comparing, because the block parser reads `__` as formatting.
 */
export function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  const blocks = Array.isArray(prompt) ? prompt : prompt && typeof prompt === "object" && Array.isArray((prompt as any).blocks) ? (prompt as any).blocks : [];
  return blocks.map((b: any) => (typeof b?.block?.text === "string" ? b.block.text : typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n");
}
export const samePrompt = (a: unknown, b: unknown): boolean => promptText(a).replace(/[_\s]+/g, "") === promptText(b).replace(/[_\s]+/g, "");
const NOTICES_MAX = 50;
function clipText(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human summary of a schedule source, like the agents server's own trigger pages. */
function scheduleSummary(source: any): string | undefined {
  if (source?.type === "run-completed") return `after each ${source.status ?? "finished"} run${source.agentId ? ` of agent ${String(source.agentId).slice(0, 8)}` : ""}${source.titleMatch ? ` titled *${source.titleMatch}*` : ""}`;
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
  /** A `seed.profiles` entry: the state lives in `seed-<profile>.json`, next to the default bridge's seed.json. */
  profile?: string;
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
  `You are ${name}, Eric's fleet companion: the voice of Cyberdeck, the daemon on each of Eric's machines (the laptops yacht and starlight, the Madrid Mac mini clipper that hosts you, the servers enuc, sentinel, iris and botical, the phone). Eric reaches you by voice from the Casework app on the iPad or the web Desk, so everything you say is read aloud: lead with the answer, one or two short sentences, plain words, no markdown, lists, code or URLs unless he asks for them.

Work from facts, not memory: call your cyberdeck tools before answering and never guess at the state of a machine, a service or a repo. Pass brief true on every call and read the sentence it returns; ask for the full data only when Eric wants details. Say in a few words what you checked ("I probed the services and read the log on enuc") and name the host and the service when something is down. Keep numbers few and sayable.

Before anything that changes a machine or the shared handoff (restarting a service, queueing or starting a collab task, removing a handoff entry) say what you are about to do and wait for a yes. Reading status, logs, notes, repos and sessions needs no confirmation. Leave a trace: handoff_note for what you did on a host, note for something Eric should see later, todo_add for work someone has to pick up.

Hand long jobs to the fleet agent instead of doing them in the call: anything that touches several machines or takes more than a few seconds (check every host and say what is down, probe all services, read the logs on three servers, compare the repos on two laptops). Call delegate with the task in full sentences and a short title, tell Eric you handed it off and that a line appears on the Desk when it is done, and go on with his next question. When he asks what it found, call delegate_result with that session id and read the answer; if it is still running, say so and offer to check again.

Eric controls the call by voice too: "stop listening", "mute", "hold on" means call listen with action mute (then stay silent until he unmutes); "you can listen again" means unmute; "that's all", "hang up", "goodbye" means say a short goodbye first, then call listen with action hangup, because nothing after it is heard.

When a tool fails, say which one and what it said, retry at most once, and offer the next step. When you do not know, say so plainly.`;

/** `managed`: `cyberdeck seed sync --voice` owns this prompt (persona + knowledge pack, hash in the agent's metadata); then
 *  `desired` is the whole managed text and `--apply` rewrites it the way the sync does instead of stripping the pack. */
export type PromptResult = { agentId: string; name?: string; current: string; desired: string; changed: boolean; applied: boolean; managed: boolean };

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
  /** The `seed.profiles` name, or undefined for the default bridge. */
  readonly profile: string | undefined;
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
  #runWatch: { value: DogfoodStatus | undefined; checkedAt: number; agentId: string } | null = null;
  #digest: { value: DigestStatus | undefined; checkedAt: number; agentId: string } | null = null;
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
    this.profile = opts.profile || undefined;
    this.stateFile = join(home, this.profile ? `seed-${this.profile}.json` : "seed.json");
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
  /** Where the agents server reaches this node's MCP server: `seed.mcpUrl` (the `cyberdeck serve mcp` public route for a
   *  hosted server), else loopback, which only an agents server on this machine can follow. */
  get mcpUrl(): string { return this.config.mcpUrl || `http://127.0.0.1:${this.#port}/api/mcp`; }
  /** Whether the agents server is on this machine (loopback), so the default loopback MCP URL reaches back. */
  get agentsLocal(): boolean {
    try { return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(this.config.agentsUrl).hostname); } catch { return false; }
  }

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
      mcpUrl: this.mcpUrl,
      ...(this.profile ? { seedProfile: this.profile } : {}),
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
      const runWatch = await this.#runWatchStatus().catch(() => undefined);
      if (runWatch) s.runWatch = runWatch;
      const digest = await this.#digestStatus().catch(() => undefined);
      if (digest) s.digest = digest;
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
    return this.#findTrigger(agentId, DOGFOOD_TRIGGER_NAME, this.#state.dogfoodTriggerId);
  }

  /** The trigger of that name on the agent: the id we recorded if it is still there, else the newest by name. */
  async #findTrigger(agentId: string, name: string, recordedId?: string): Promise<TriggerInfo | undefined> {
    const res = await this.action<{ triggers?: TriggerInfo[] }>({ _: "ListAgentTriggers", agentId });
    const triggers = (res.triggers ?? []).filter((t) => t && t.name === name);
    return triggers.find((t) => t.id === recordedId) ?? triggers.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  }

  /** The run-completed trigger as the agents server has it; cached like the check-in. */
  async #runWatchStatus(): Promise<DogfoodStatus | undefined> {
    const agentId = this.#state.agentId;
    if (!agentId) return undefined;
    if (this.#runWatch && this.#runWatch.agentId === agentId && Date.now() - this.#runWatch.checkedAt < HEALTH_TTL_MS) return this.#runWatch.value;
    const found = await this.#findTrigger(agentId, RUNWATCH_TRIGGER_NAME, this.#state.runWatchTriggerId);
    const value = found ? this.#toDogfood(found) : undefined;
    this.#runWatch = { value, checkedAt: Date.now(), agentId };
    return value;
  }

  /** The weekly digest trigger as the agents server has it; cached like the check-in. */
  async #digestStatus(): Promise<DigestStatus | undefined> {
    const agentId = this.#state.agentId;
    if (!agentId) return undefined;
    if (this.#digest && this.#digest.agentId === agentId && Date.now() - this.#digest.checkedAt < HEALTH_TTL_MS) return this.#digest.value;
    const found = await this.#findTrigger(agentId, DIGEST_TRIGGER_NAME, this.#state.digestTriggerId);
    const value = found ? this.#toDigest(found) : undefined;
    this.#digest = { value, checkedAt: Date.now(), agentId };
    return value;
  }

  #toDigest(t: TriggerInfo): DigestStatus {
    const account = this.#state.digestAccount;
    return { ...this.#toDogfood(t), ...(account ? { account, url: digestUrl(account) } : {}), ...(this.#state.digestSignerName ? { signer: this.#state.digestSignerName } : {}) };
  }

  /**
   * Make sure the agent publishes a weekly fleet digest document (roadmap P6): a signing identity labelled
   * DIGEST_SIGNER_LABEL on the agents server (created once; its hm account is where the documents live),
   * granted to the agent through `definition.signingKeys` (the publish grant), and a weekly schedule trigger
   * named DIGEST_TRIGGER_NAME (Monday 08:00 Europe/Madrid by default) whose prompt is `digestPrompt(account)`.
   * Idempotent like `dogfood()`: reused by name, a stale prompt is rewritten.
   */
  async digest(opts: DigestOptions = {}): Promise<DigestStatus & { created: boolean; updated: boolean; granted: boolean; identityCreated: boolean }> {
    const agentId = this.#state.agentId;
    if (!agentId) throw new SeedError("no agent set up: run `cyberdeck seed setup`");
    const timeOfDay = opts.timeOfDay?.trim() || "08:00";
    if (!/^\d{2}:\d{2}$/.test(timeOfDay)) throw new SeedError(`timeOfDay must be HH:MM, got "${timeOfDay}"`);
    const timezone = opts.timezone?.trim() || "Europe/Madrid";
    const dayOfWeek = opts.dayOfWeek ?? 1;
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new SeedError(`dayOfWeek must be 0 (Sunday) to 6, got "${opts.dayOfWeek}"`);

    // 1. The signing identity: the one recorded, else the one with our label, else a new one.
    type Identity = { id?: string; name: string; accountId?: string; label?: string };
    const listed = await this.action<{ identities?: Identity[] }>({ _: "ListSigningIdentities" });
    const identities = (listed.identities ?? []).filter((i) => i && typeof i.name === "string");
    let identity = identities.find((i) => i.name === this.#state.digestSignerName) ?? identities.find((i) => i.label === DIGEST_SIGNER_LABEL);
    let identityCreated = false;
    if (!identity) {
      const res = await this.action<{ identity: Identity }>({ _: "CreateSigningIdentity", label: DIGEST_SIGNER_LABEL }, { timeoutMs: 60_000 });
      identity = res.identity;
      identityCreated = true;
    }
    if (!identity?.accountId) throw new SeedError(`signing identity ${identity?.name ?? "?"} has no hm account`);
    const account = identity.accountId;
    if (this.#state.digestSignerName !== identity.name || this.#state.digestAccount !== account) { this.#state.digestSignerName = identity.name; this.#state.digestAccount = account; this.#save(); }

    // 2. The grant: the agent may sign with it.
    const got = await this.action<{ agent: { definition: Record<string, unknown> & { signingKeys?: string[]; signingKey?: string } } }>({ _: "GetAgent", agentId });
    const def = got.agent.definition;
    const keys = Array.isArray(def.signingKeys) ? def.signingKeys : def.signingKey ? [def.signingKey] : [];
    let granted = false;
    if (!keys.includes(identity.name)) {
      await this.action({ _: "UpdateAgent", agentId, definition: { ...def, signingKeys: [...keys, identity.name] } });
      granted = true;
    }

    // 3. The trigger.
    const prompt = digestPrompt(account);
    let trigger = await this.#findTrigger(agentId, DIGEST_TRIGGER_NAME, this.#state.digestTriggerId);
    let created = false;
    let updated = false;
    if (trigger && typeof trigger.prompt === "string" && trigger.prompt !== prompt) {
      const res = await this.action<{ trigger?: TriggerInfo }>({ _: "UpdateAgentTrigger", triggerId: trigger.id, patch: { prompt } });
      trigger = { ...trigger, ...(res.trigger ?? {}), prompt };
      updated = true;
    }
    if (!trigger) {
      const res = await this.action<{ trigger: TriggerInfo }>({
        _: "CreateAgentTrigger",
        agentId,
        trigger: {
          name: DIGEST_TRIGGER_NAME,
          enabled: true,
          source: { type: "schedule", schedule: { kind: "weekly", daysOfWeek: [dayOfWeek], timeOfDay, timezone } },
          prompt,
          continuation: { kind: "newThread" },
        },
      });
      trigger = res.trigger;
      created = true;
    }
    if (this.#state.digestTriggerId !== trigger.id) { this.#state.digestTriggerId = trigger.id; this.#save(); }
    const value = this.#toDigest(trigger);
    this.#digest = { value, checkedAt: Date.now(), agentId };
    return { ...value, created, updated, granted, identityCreated };
  }

  /**
   * Make sure the voice agent announces finished runs of the harness agent (the one behind the prompt
   * bar and the Seed view, where the owner delegates work): a `run-completed` trigger whose continuation
   * calls the `announce` MCP tool headlessly with the event (no model turn), falling back to a thread
   * with RUNWATCH_PROMPT when the server cannot run it that way. Idempotent by name; a stale prompt or a
   * changed harness agent is patched in place. Sub-steps without a session are dropped by `announce`.
   */
  async runWatch(): Promise<DogfoodStatus & { created: boolean; updated: boolean; watches: string; headless: boolean }> {
    const agentId = this.#state.agentId;
    if (!agentId) throw new SeedError("no agent set up: run `cyberdeck seed setup`");
    const watched = this.#state.queryAgentId;
    if (!watched) throw new SeedError("no harness agent yet: run `cyberdeck seed sync` (or one prompt-bar query) first");
    const source = { type: "run-completed", agentId: watched };
    const input = { runId: "$event.runId", title: "$event.runTitle", status: "$event.runStatus", sessionId: "$event.sessionId", agentId: "$event.agentId" };
    const headless = { kind: "tool", tool: `${MCP_SERVER_NAME}__announce`, input, onFailure: "thread" };
    // The server checks the continuation's tool against the agent's current tool list, which may predate
    // this build (the MCP registration is refreshed on boot, but not necessarily yet): a refusal naming the
    // tool gets one re-registration and one retry before the thread form is used.
    const refused = (e: unknown): e is SeedError => e instanceof SeedError && (e.status === 400 || e.status === 422);
    const withHeadless = async <T>(attempt: (continuation: unknown) => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
      try { return await attempt(headless); }
      catch (e) {
        if (!refused(e)) throw e;
        if (/not one of this agent's tools/i.test(e.message)) {
          const refreshed = await this.refreshMcp().catch(() => "skipped" as const);
          if (refreshed !== "skipped") { try { return await attempt(headless); } catch (e2) { if (!refused(e2)) throw e2; } }
        }
        console.error(`seed: run-completed trigger: headless announce call refused (${e.message}); using a thread`);
        return fallback();
      }
    };
    let trigger = await this.#findTrigger(agentId, RUNWATCH_TRIGGER_NAME, this.#state.runWatchTriggerId);
    let created = false;
    let updated = false;
    if (trigger) {
      const patch: Record<string, unknown> = {};
      if (typeof trigger.prompt === "string" && trigger.prompt !== RUNWATCH_PROMPT) patch.prompt = RUNWATCH_PROMPT;
      if (trigger.source?.type !== "run-completed" || trigger.source?.agentId !== watched) patch.source = source;
      const threadForm = trigger.continuation?.kind !== "tool" || trigger.continuation.tool !== headless.tool;
      if (Object.keys(patch).length || threadForm) {
        const t = trigger;
        const update = (p: Record<string, unknown>) => this.action<{ trigger?: TriggerInfo }>({ _: "UpdateAgentTrigger", triggerId: t.id, patch: p }).then((res) => ({ ...t, ...(res.trigger ?? {}), ...p } as TriggerInfo));
        // A trigger left in thread form (older build, or the tool was not registered then) is upgraded to the headless call.
        trigger = threadForm
          ? await withHeadless((continuation) => update({ ...patch, continuation }), () => (Object.keys(patch).length ? update(patch) : Promise.resolve(t)))
          : await update(patch);
        updated = trigger !== t;
      }
    } else {
      const make = (continuation: unknown) => this.action<{ trigger: TriggerInfo }>({
        _: "CreateAgentTrigger", agentId,
        trigger: { name: RUNWATCH_TRIGGER_NAME, enabled: true, source, prompt: RUNWATCH_PROMPT, continuation },
      });
      trigger = (await withHeadless(make, () => make({ kind: "newThread" }))).trigger;
      created = true;
    }
    if (this.#state.runWatchTriggerId !== trigger.id) { this.#state.runWatchTriggerId = trigger.id; this.#save(); }
    const value = this.#toDogfood(trigger);
    this.#runWatch = { value, checkedAt: Date.now(), agentId };
    return { ...value, created, updated, watches: watched, headless: trigger.continuation?.kind === "tool" };
  }

  /**
   * Leave a line for the owner on the Desk transcript (the `announce` MCP tool). Without `text` the
   * line is composed from the run fields; a run that has no session is a workflow sub-step and is
   * skipped, so one delegated job announces once, not once per internal await.
   */
  announce(input: AnnounceInput): AnnounceResult {
    const text = input.text?.trim();
    const title = input.title?.trim();
    const status = input.status?.trim();
    if (!text && !title) return { announced: false, reason: "nothing to say: give text, or the run's title and status" };
    if (!text && input.runId && !input.sessionId) return { announced: false, reason: "skipped: a sub-step with no session is not announced" };
    const verb = status === "succeeded" ? "finished" : status === "failed" ? "failed" : status === "canceled" ? "was canceled" : status ? `is ${status}` : "finished";
    const summary = input.summary?.trim().replace(/\s+/g, " ");
    const line = text ?? `${verb === "finished" ? "Done" : verb === "failed" ? "Failed" : "Update"}: "${clipText(title!, 160)}" ${verb}${summary ? `: ${clipText(summary, 220)}` : "."}`;
    const run = input.runId || title || status || input.sessionId ? { ...(input.runId ? { id: input.runId } : {}), ...(title ? { title: clipText(title, 200) } : {}), ...(status ? { status } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}) } : undefined;
    const notice: Notice = { id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), text: clipText(line, 400), ...(run ? { run } : {}) };
    const list = [...(this.#state.notices ?? []), notice];
    this.#state.notices = list.slice(-NOTICES_MAX);
    this.#save();
    return { announced: true, notice };
  }

  /**
   * The `listen` MCP tool: a control notice the live call acts on within a few seconds (the Desk and the iPad
   * poll `/api/voice/control`), with a line in the transcript that says what happened and why.
   */
  control(action: ControlAction): Notice {
    const text = action === "mute" ? "Microphone muted at your request; unmute when you want me back." : action === "unmute" ? "Microphone back on." : "Call ended at your request.";
    const notice: Notice = { id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), text, control: { action } };
    this.#state.notices = [...(this.#state.notices ?? []), notice].slice(-NOTICES_MAX);
    this.#save();
    return notice;
  }

  /** Control notices with `since < at <= now`, oldest first: what a live call that last asked at `since` still has to apply. */
  controls(since: number, now = Date.now()): Notice[] {
    return (this.#state.notices ?? []).filter((n) => n.control && n.at > since && n.at <= now);
  }

  /** The newest notices, oldest first. */
  notices(limit = 20): Notice[] {
    const n = Math.max(1, Math.min(NOTICES_MAX, Math.floor(limit) || 20));
    return (this.#state.notices ?? []).slice(-n);
  }

  #toDogfood(t: TriggerInfo): DogfoodStatus {
    const summary = scheduleSummary(t.source);
    const note = t.name === DOGFOOD_TRIGGER_NAME ? checkinNoteStatus(this.#inbox(), t.lastFiredAt, t.source?.schedule?.timezone) : {};
    return { triggerId: t.id, name: t.name, enabled: t.enabled !== false, ...(t.lastFiredAt ? { lastFiredAt: t.lastFiredAt } : {}), ...(t.lastError ? { lastError: t.lastError } : {}), ...(summary ? { nextSummary: summary } : {}), ...note };
  }

  /** The Deck inbox on this node (the `note` tool writes it through `deck note`), or null without a Deck checkout. */
  #inbox(): string | null {
    if (!this.#fleetDir) return null;
    try { return readFileSync(join(this.#fleetDir, "notes", "inbox.md"), "utf8"); } catch { return null; }
  }

  /**
   * Make sure the daily fleet check-in schedule trigger exists on the agent (idempotent: reused by
   * name, and its prompt is rewritten when it differs from DOGFOOD_PROMPT). The agent runs it with the
   * cyberdeck MCP tools and leaves one note in the Deck inbox.
   */
  async dogfood(opts: DogfoodOptions = {}): Promise<DogfoodStatus & { created: boolean; updated: boolean }> {
    const agentId = this.#state.agentId;
    if (!agentId) throw new SeedError("no agent set up: run `cyberdeck seed setup`");
    const timeOfDay = opts.timeOfDay?.trim() || "07:00";
    if (!/^\d{2}:\d{2}$/.test(timeOfDay)) throw new SeedError(`timeOfDay must be HH:MM, got "${timeOfDay}"`);
    const timezone = opts.timezone?.trim() || "Europe/Madrid";
    const existing = await this.#findDogfoodTrigger(agentId);
    let trigger = existing;
    let created = false;
    let updated = false;
    if (trigger && !samePrompt(trigger.prompt, DOGFOOD_PROMPT)) {
      // The prompt ships with Cyberdeck: a trigger made by an older build gets the current wording. The server
      // hands the prompt back as parsed blocks, not the string we sent, so the comparison goes through the text.
      const res = await this.action<{ trigger?: TriggerInfo }>({ _: "UpdateAgentTrigger", triggerId: trigger.id, patch: { prompt: DOGFOOD_PROMPT } });
      trigger = { ...trigger, ...(res.trigger ?? {}), prompt: DOGFOOD_PROMPT };
      updated = true;
    }
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
    return { ...value, created, updated };
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
    // A hosted agents server (a profile such as agent.hm) cannot follow a loopback MCP URL: refuse before anything is written there.
    if (this.profile && !this.config.mcpUrl && !this.agentsLocal) {
      throw new SeedError(`seed profile "${this.profile}": ${this.config.agentsUrl} is not on this machine and seed.profiles.${this.profile}.mcpUrl is unset, so it could never reach this node's MCP server. Run \`cyberdeck serve mcp\` and put the public URL it prints (\`cyberdeck mcp --json\`, "public") in config.json as seed.profiles.${this.profile}.mcpUrl, then run setup again.`, 0);
    }
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
  /** The companion's system prompt next to the fleet persona; with `apply`, the persona is written to the agent.
   *  A prompt the sync manages (persona + knowledge pack) is compared by the hash the sync left in the agent's
   *  metadata, like `voiceAgent.promptCurrent`, and applied with the pack (2026-10-26: the hub's companion read
   *  as "differs" forever, and `--apply` from another node would have dropped its three pack sections). */
  async prompt(apply = false): Promise<PromptResult> {
    if (!this.#state.agentId) throw new SeedError("no agent set up yet: run `cyberdeck seed setup`", 409);
    const agentId = this.#state.agentId;
    const res = await this.action<{ agent: { definition: Record<string, unknown> & { name?: string; systemPrompt?: unknown } } }>({ _: "GetAgent", agentId });
    const definition = res.agent.definition;
    const name = typeof definition.name === "string" ? definition.name : undefined;
    if (name) this.#agentName = name;
    // The server hands a prompt back as blocks once it has stored one (the 2026-10-24 trigger lesson): read it as
    // text and compare like samePrompt does, or an applied persona reads as "(empty)" and "differs" forever.
    const current = promptText(definition.systemPrompt);
    const meta = metaOf(definition);
    const managed = meta.role === "voice" && !!meta.promptHash;
    const persona = fleetPrompt(name ?? "Cyberdeck");
    const desired = managed ? `${persona}\n\n${knowledgeSection(this.#sources(), this.#ctx())}` : persona;
    const changed = managed ? meta.promptHash !== sha256(desired) : !samePrompt(definition.systemPrompt, desired);
    let applied = false;
    if (apply && changed) {
      const patch = managed ? { systemPrompt: desired, metadata: this.#meta(definition, { promptHash: sha256(desired), role: "voice" }) } : { systemPrompt: desired };
      await this.action({ _: "UpdateAgent", agentId, definition: omitUndefined({ ...definition, ...patch }) });
      applied = true;
    }
    return { agentId, name, current, desired, changed, applied, managed };
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

  /**
   * Hand a task to the harness agent (the `delegate` MCP tool): a fresh durable session titled
   * `title`, with `task` as its first turn. The run-completed trigger (`runWatch`) announces the finish on
   * the Desk, and `delegateResult` reads the answer back; the voice agent is free again right away.
   */
  async delegate(task: string, title?: string): Promise<DelegateResult> {
    const text = task.trim();
    if (!text) throw new SeedError("delegate needs a task");
    // Cheap precheck before the signer and the health probe: a node without a bridge answers at once.
    if (!this.#state.agentId || !this.#state.mcpRegisteredAt) throw new SeedError("Seed is not set up on this node (no agent, or its MCP server is not registered): run cyberdeck seed setup", 409);
    const name = clipText((title?.trim() || text.split(/\r?\n/)[0]!).replace(/\s+/g, " "), 120);
    const s = await this.createQuery(name);
    const sessionId = s.id.replace(/^seed-/, "");
    // MessageSession answers only when the run is over (the agents server runs it inline), so the turn is
    // sent and left running: the caller gets the session back after a short grace period in which an
    // immediate refusal still surfaces. The run-completed trigger announces the end; delegateResult reads it.
    const turn = this.action({ _: "MessageSession", sessionId, content: [{ type: "text", text }] }, { timeoutMs: DELEGATE_RUN_TIMEOUT_MS });
    const settled = await Promise.race([
      turn.then(() => "done" as const, (e) => { throw e; }),
      new Promise<"sent">((resolve) => setTimeout(() => resolve("sent"), DELEGATE_GRACE_MS)),
    ]);
    if (settled === "sent") turn.catch((e) => console.error(`seed: delegated run ${sessionId}: ${e instanceof Error ? e.message : e}`));
    return { sessionId, title: name, agentId: this.#state.queryAgentId! };
  }

  /** The newest assistant answer in a harness session and whether the agent is still working on it. */
  async delegateResult(sessionId: string): Promise<DelegateStatus> {
    const id = sessionId.trim().replace(/^seed-/, "");
    if (!id) throw new SeedError("delegate_result needs a session id");
    if (!this.#state.queryAgentId) throw new SeedError("no delegated sessions yet: nothing has been handed to the fleet agent on this node", 404);
    const r = await this.getQuery(id) as { session?: { title?: string; status?: string }; events?: { seq: number; createdAt: number; event: { type?: string; role?: string; content?: unknown } }[] };
    let answer: { text: string; at: number } | undefined;
    let lastUserSeq = -1;
    let answerSeq = -1;
    let turns = 0;
    for (const ev of r.events ?? []) {
      const p = ev.event;
      if (p?.type !== "message" || typeof p.content !== "string" || !p.content.trim()) continue;
      if (p.role === "user") { lastUserSeq = ev.seq; turns++; } else if (p.role === "assistant") { answer = { text: p.content.trim(), at: ev.createdAt }; answerSeq = ev.seq; }
    }
    const streaming = r.session?.status === "streaming";
    const state: DelegateStatus["state"] = streaming ? "running" : answer && answerSeq > lastUserSeq ? "done" : "waiting";
    return { sessionId: id, title: r.session?.title || "Seed query", state, ...(answer ? { answer: answer.text, answeredAt: answer.at } : {}), turns };
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
    if (!this.#state.sessionId) return { supported: true, messages: [], notices: this.notices(n) };
    const res = await this.action<{ events?: { seq: number; createdAt: number; event: { type?: string; role?: string; content?: unknown } }[]; hasMoreBefore?: boolean }>({ _: "GetSession", sessionId: this.#state.sessionId, limit: n * 3 });
    const messages: TranscriptMessage[] = [];
    for (const ev of res.events ?? []) {
      const p = ev.event;
      if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant") || typeof p.content !== "string" || !p.content.trim()) continue;
      messages.push({ seq: ev.seq, role: p.role, text: p.content, at: ev.createdAt });
    }
    return { supported: true, sessionId: this.#state.sessionId, messages: messages.slice(-n), hasMoreBefore: res.hasMoreBefore || messages.length > n, notices: this.notices(n) };
  }
}
