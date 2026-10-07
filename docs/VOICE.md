# Voice on Cyberdeck

Talk to a Seed agent about the fleet from the Casework iPad app or the web Desk. Cyberdeck does not
run speech itself: it signs into a Seed agents server as one of this Mac's vault identities, keeps a
pointer to the agent and session the calls go to, and hands the client a LiveKit room. The agents
server's voice worker transcribes the caller, runs the Seed session as the LLM (with Cyberdeck's own
MCP tools enabled), and speaks the reply back.

```
Casework app / web Desk
   │  GET  /api/voice/config          -> {configured, provider: "livekit"}
   │  POST /api/voice/livekit         -> {url, token, room, identity, expiresAt}
   ▼
Cyberdeck daemon (src/daemon/api/voice.ts, src/daemon/seed.ts)
   │  signed DAG-CBOR AgentsAction envelope, POST /api/message
   │  CreateVoiceSession {sessionId}
   ▼
Seed agents server (voice-capable instance)
   │  mints a LiveKit participant token for the session's room
   ▼
LiveKit room  <──>  seed-voice worker (STT -> Seed session turn -> TTS)
                       │  the session's agent calls tools, among them the `cyberdeck` MCP server
                       ▼
                    Cyberdeck POST /api/mcp (docs/AGENTS.md)
```

The client joins `url` with `token`, enables its microphone, and sends "Hi" on the `lk.chat` text
topic; from there the worker drives the conversation. Nothing on the call path needs the node token:
the Casework pairing key reaches every `/api/voice/*` route except `setup`.

## Signed client

`SeedBridge` (`src/daemon/seed.ts`) is a minimal signed client for the agents server's
[signed API](https://github.com/seed-hypermedia/seed/blob/main/hypermedia/agent/signed-api.md):
every action is `{type: 'AgentsAction', signer, account, sig, protocol: 3, action: {..., ts}}`,
signed with `@seed-hypermedia/client/blobs` and encoded with `@seed-hypermedia/client/cbor`. The
signer is lazy.

Local vault loading requires **Bun 1.3.3 or newer** for `DecompressionStream`. If setup reports
an unsupported runtime, run `bun upgrade`, then `cyberdeck restart` once active terminal sessions
have finished. Updating Cyberdeck's source alone does not update the running Bun process.

Identity sources:

- `CYBERDECK_SEED_KEY_SEED` (32 bytes, hex) builds the keypair directly: tests and headless boxes.
- Otherwise the local Seed vault (`@seed-hypermedia/client/vault-local`: the desktop app's
  `vault.json`, unlocked with the keychain secret or `SEED_VAULT_KEK`) is read and the account named
  by `seed.identity` is used. On this Mac that is `main` = `z6MkmZUb…`.

`undefined` fields are stripped before signing (DAG-CBOR would turn them into `null` and break the
signature). Server errors come back as `SeedError` with the server's message and HTTP status; the
node token and the LiveKit token are never logged.

## Configuration

`~/.cyberdeck/config.json`:

```json
"seed": {
  "agentsUrl": "http://127.0.0.1:3053",
  "identity": "main",
  "modelProvider": "OpenAI",
  "model": "gpt-6-sol"
}
```

| Key | Default | Meaning |
|---|---|---|
| `agentsUrl` | `http://127.0.0.1:3053` | The agents server. Its `GET /api/health` must report `voice: true`. Env `CYBERDECK_SEED_AGENTS_URL` overrides. |
| `identity` | `main` | Vault account name that signs. Env `CYBERDECK_SEED_IDENTITY` overrides. |
| `modelProvider`, `model` | `OpenAI`, `gpt-6-sol` | Used only when setup has to create the agent. The provider name must be one configured on the agents server for that account. |
| `agentId`, `sessionId` | unset | Optional fixed pointers; normally setup fills `seed.json` instead. |

State lives in `~/.cyberdeck/seed.json` (`{agentId, sessionId, mcpRegisteredAt, lastCallAt}`, mode
0600); it is written by setup, by session changes, and by every call.

Today the default points at the **experiments** agents server on this Mac (launchd
`com.casework.seed-experiments`, worktree `~/Code/Seed-worktrees/agent-voice`). That instance was
set up by the Casework experiments and already owns the "Casework Companion" agent.

## Setup

```
cyberdeck seed setup            # adopt the companion (or create "Cyberdeck"), register the MCP server
cyberdeck seed setup --new      # ignore the current agent and create a fresh "Cyberdeck" agent
cyberdeck seed setup --no-adopt # never adopt the companion
cyberdeck seed setup --name X   # name for a created agent
```

Setup (`POST /api/voice/setup`, node token only) does, in order:

1. `SetSecret cyberdeck-mcp-token` = `Bearer <~/.cyberdeck/token>` (encrypted at rest on the agents
   server) and `SetMcpServer cyberdeck` → `http://127.0.0.1:<port>/api/mcp` with that secret as the
   `Authorization` header. The agents server connects immediately; the result reports the discovery
   state and tool count (15 today).
2. The agent. An agent already in `seed.json` is kept (and granted `cyberdeck` in its `mcpServers`
   if missing). Otherwise, when `~/Library/Application Support/CaseworkSeed/companion.json` names
   an agent, that Casework Companion is adopted: `GetAgent` + `UpdateAgent` adding `cyberdeck` to its
   MCP servers, keeping the others (`casework_host`). Otherwise `CreateAgent "Cyberdeck"` with
   `mcpServers: ['cyberdeck']` and a system prompt that says it is Eric's fleet companion reached by
   voice through Cyberdeck, has the cyberdeck tools, and speaks concisely. If adoption fails for a
   protocol reason the fallback is the created agent, with the reason in `warnings`.
3. `CreateSession` for the agent (title "Cyberdeck voice"). The companion's own session is not
   reused: Cyberdeck's calls get their own transcript.

Re-running setup is idempotent for the MCP registration and keeps the agent and session. Rotating
the node token (`~/.cyberdeck/token`) requires a re-run so the secret on the agents server follows.

## Routes

| Route | Key | Returns |
|---|---|---|
| `GET /api/voice/config` | pairing | `{configured, provider: 'livekit' \| 'none', engine: 'seed', reason?, agentId?, sessionId?}` |
| `POST /api/voice/livekit` | pairing | `{sessionId, url, token, room, identity, expiresAt}` from `CreateVoiceSession`; `503 {error: 'voice not configured', reason}` when unconfigured; `502 {error}` on a server failure |
| `GET /api/voice/status` | pairing | `{configured, reason?, agentsUrl, identity: {name, available, principal?, error?}, agent?: {id, name?}, sessionId?, health: {ok, voice, protocol, version, error?, checkedAt}, mcpRegisteredAt?, lastCallAt?}` |
| `POST /api/voice/session/reset` | pairing | `{sessionId, previous?}`: a new session for the next call |
| `GET /api/voice/transcript?limit=` | pairing | `{supported: true, sessionId?, messages: [{seq, role, text, at}], hasMoreBefore}`: user/assistant text of the current session (`GetSession`'s tail, cheap) |
| `POST /api/voice/dogfood` | node token | `{triggerId, name, enabled, lastFiredAt?, lastError?, nextSummary?, created}`: the daily fleet check-in trigger (below); body `{timezone?, timeOfDay?}` |
| `POST /api/voice/setup` | node token | the setup result above (`{agent: {id, name?, origin: kept\|adopted\|created}, sessionId, mcp: {name, url, state, tools?, error?}, warnings}`); body `{new?, adopt?, name?}` |

`status` also carries `dogfood: {triggerId, name, enabled, lastFiredAt?, lastError?, nextSummary?}`
once the check-in trigger exists (read back from `ListAgentTriggers`, cached 10 s).

`configured` is true when the identity loads, the agents server answers `/api/health` with
`voice: true` (probed with a 3 s timeout, cached 10 s), and an agent is set up. The same summary
rides on `GET /api/state` and the Casework `welcome` frame as `voice`.

Each call follows `continue_session` successors (a session the agent continued into) before minting
the room, and recreates the session if the server no longer has it.

## CLI

```
cyberdeck seed status          # server health, identity, agent, session, last call; exit 1 when not ready
cyberdeck seed setup [--new]   # see above
cyberdeck seed reset-session   # next call starts a fresh session
cyberdeck seed call            # smoke test: mint a room and print it (token withheld); nothing joins it
cyberdeck seed transcript [n]  # last n user/assistant messages
cyberdeck seed dogfood [--tz Europe/Madrid] [--at 07:00]   # daily fleet check-in trigger (idempotent)
```

## Dogfood: the daily fleet check-in

`cyberdeck seed dogfood` makes sure a schedule trigger named `cyberdeck-fleet-checkin` exists on the
agent (`ListAgentTriggers` by name, else `CreateAgentTrigger`; the id is kept in `seed.json`). It is
weekly on all seven days at 07:00 Europe/Madrid by default (`{kind: 'weekly', daysOfWeek: [0..6],
timeOfDay, timezone}`, Sunday = 0), continuation `newThread`, and its prompt tells the agent to use
only the cyberdeck tools (`fleet_status`, `services` with a probe, `repos`, `todo`) and leave one
note under 400 characters in the Deck inbox via `cyberdeck__note`. Options only apply when the
trigger is created; edit it in the agent's Triggers tab afterwards.

All of these go through the local daemon's HTTP API with the node token, like the other commands.

## Browser microphone and HTTPS

Browsers only expose `getUserMedia` on secure origins, so the web Desk can place calls from
`http://localhost:4777` on the node itself but not from a plain-HTTP tailnet address. Run
`cyberdeck serve` and use `https://<node>.<tailnet>.ts.net`. The LiveKit `url` the experiments server
hands out is its own (today a LAN `ws://` address), so the caller must be able to reach that too.

## Not done

- **Voice profile** (Cartesia voice id and speed in `companion.json`) is not applied: that goes
  through the agents server's internal runtime endpoint (`/api/voice/runtime`, bearer
  `SEED_AGENTS_VOICE_INTERNAL_TOKEN`), which Cyberdeck does not hold. The companion keeps whatever
  profile the Casework host set.
- **Production agents server** is not wired: the default is the local experiments instance. Pointing
  `seed.agentsUrl` at a hosted server also needs the MCP URL to be reachable from there
  (docs/AGENTS.md, Reachability) and that server to run a voice pipeline.
- **Transcript** is the session's durable events, not the live call: the LiveKit transcription
  events arrive on the client, not through this daemon.
- No web Desk UI section here: the UI half lives in `ui/` and talks to the same routes.
