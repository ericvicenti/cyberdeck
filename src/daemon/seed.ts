// Seed agents bridge: signs actions for a Seed agents server as one of this Mac's vault identities,
// keeps the Cyberdeck agent + session pointer, and mints LiveKit voice sessions for the Casework app
// and the web Desk. Every call is a signed DAG-CBOR `AgentsAction` envelope to POST /api/message
// (hypermedia/agent/signed-api.md in the Seed repo). See docs/VOICE.md.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as blobs from "@seed-hypermedia/client/blobs";
import * as cbor from "@seed-hypermedia/client/cbor";
import { CYBERDECK_HOME, type SeedConfig } from "./config";

/** Persisted in `${CYBERDECK_HOME}/seed.json`. */
export type SeedState = { agentId?: string; sessionId?: string; mcpRegisteredAt?: number; lastCallAt?: number; dogfoodTriggerId?: string };

export type SeedHealth = { ok: boolean; voice?: boolean; protocol?: number; version?: string; error?: string; checkedAt: number };

export type SeedStatus = {
  /** Calls can be placed: identity loads, the server answers with voice, and an agent is set up. */
  configured: boolean;
  reason?: string;
  agentsUrl: string;
  identity: { name: string; available: boolean; principal?: string; error?: string };
  agent?: { id: string; name?: string };
  sessionId?: string;
  health?: SeedHealth;
  mcpRegisteredAt?: number;
  lastCallAt?: number;
  /** The daily fleet check-in trigger (`dogfood()`), read back from the agents server; absent when none. */
  dogfood?: DogfoodStatus;
};

export type DogfoodStatus = { triggerId: string; name: string; enabled: boolean; lastFiredAt?: number; lastError?: string; nextSummary?: string };
export type DogfoodOptions = { timezone?: string; timeOfDay?: string };
type TriggerInfo = { id: string; name: string; enabled: boolean; source: any; lastFiredAt?: number; lastError?: string; createdAt?: number };

export type VoiceSession = { sessionId: string; url: string; token: string; room: string; identity: string; expiresAt: number };

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
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
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

const systemPrompt = (name: string) =>
  `You are ${name}, Eric's fleet companion. People reach you by voice through Cyberdeck (the fleet-and-data daemon on Eric's machines) from the Casework iPad app or the web Desk, so your replies are spoken aloud: answer in one or two short sentences, lead with the answer, and skip markdown, lists and code.

You have the cyberdeck tools: status of this node and its paired nodes, the fleet manifest (hosts, services), the project tree, the handoff TODO, the cross-host coding-agent session index, repo risk, service probes, the collab queue (queue a task for a laptop agent, start a queued task, read a run's log), notes to the inbox, and a rescan. Reach for them before guessing; say when something is not known. Confirm before queueing or starting work.`;

export class SeedBridge {
  readonly config: SeedConfig;
  readonly stateFile: string;
  readonly companionFile: string;
  #port: number;
  #token: string;
  #fetch: typeof fetch;
  #state: SeedState;
  #signer: Signer | null = null;
  #signerError: string | null = null;
  #signerLoading: Promise<Signer | null> | null = null;
  #health: SeedHealth | null = null;
  #healthInFlight: Promise<SeedHealth> | null = null;
  #dogfood: { value: DogfoodStatus | undefined; checkedAt: number; agentId: string } | null = null;
  #agentName: string | undefined;

  constructor(opts: SeedBridgeOptions) {
    this.config = opts.config;
    this.#port = opts.port;
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    const home = opts.home ?? CYBERDECK_HOME;
    this.stateFile = join(home, "seed.json");
    this.companionFile = opts.companionFile ?? COMPANION_FILE;
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
        if (hex) {
          if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("CYBERDECK_SEED_KEY_SEED must be 32 bytes of hex");
          this.#signer = blobs.nobleKeyPairFromSeed(Uint8Array.from(Buffer.from(hex, "hex")));
        } else {
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
    const s: SeedStatus = {
      configured: false,
      agentsUrl: this.config.agentsUrl,
      identity: signer
        ? { name: this.config.identity, available: true, principal: blobs.principalToString(signer.principal) }
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
        definition: { name, systemPrompt: systemPrompt(name), modelProvider: this.config.modelProvider, model: this.config.model, mcpServers: [MCP_SERVER_NAME] },
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

  #readCompanion(): { agentId?: string; sessionId?: string } | null {
    try { return existsSync(this.companionFile) ? JSON.parse(readFileSync(this.companionFile, "utf8")) : null; } catch { return null; }
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

  async resetSession(): Promise<{ sessionId: string; previous?: string }> {
    if (!this.#state.agentId) throw new SeedError("no agent set up: run `cyberdeck seed setup`");
    const previous = this.#state.sessionId;
    const sessionId = await this.#createSession();
    return { sessionId, ...(previous ? { previous } : {}) };
  }

  // ---- voice ----------------------------------------------------------------------------------

  async createVoiceSession(): Promise<VoiceSession> {
    const sessionId = await this.ensureSession();
    const r = await this.action<{ url: string; token: string; room: string; identity: string; expiresAt: number }>({ _: "CreateVoiceSession", sessionId });
    this.#state.lastCallAt = Date.now();
    this.#save();
    return { sessionId, url: r.url, token: r.token, room: r.room, identity: r.identity, expiresAt: r.expiresAt };
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
