# Voice on Cyberdeck

Talk to a Seed agent about the fleet from the Casework iPad app or the web Desk. Cyberdeck does not
run speech itself: it signs into a Seed agents server as one of this node's identities, keeps a
pointer to the agent and session the calls go to, and hands the client a LiveKit room. The agents
server's voice worker transcribes the caller, runs the Seed session as the LLM (with Cyberdeck's own
MCP tools enabled), and speaks the reply back.

**Voice is centralized.** The whole voice system (LiveKit, the voice-capable agents server, the
speech keys, the voice profile) runs on one node of the fleet, the **voice hub**: clipper since
2026-10-16. Every other node is configured with `voice.hub` and relays each of its `/api/voice/*`
routes there, so the iPad app (which only talks to the node it is paired with), the web Desk on any
node and the CLI all reach the same server, agent and session. The Desk has no machine to pick.

```
Casework app / web Desk / cyberdeck seed CLI, on any node
   │  GET  /api/voice/config          -> {configured, provider: "livekit", via: {node, name}}
   │  POST /api/voice/livekit         -> {url, secureUrl, token, room, identity, expiresAt, via}
   ▼
Cyberdeck daemon on that node: relays every /api/voice/* route to the hub (config voice.hub)
   │  fleet proxy, x-cyberdeck-voice-direct
   ▼
Cyberdeck daemon on the hub, clipper (src/daemon/api/voice.ts, src/daemon/seed.ts)
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

`~/.cyberdeck/config.json`. On every node but the hub:

```json
"voice": { "hub": "clipper" }
```

On the hub itself (the `seed` block is only read where the bridge answers locally):

```json
"voice": { "hub": "clipper" },
"seed": {
  "agentsUrl": "http://127.0.0.1:3053",
  "modelProvider": "OpenAI",
  "model": "gpt-6-sol",
  "companionFile": "/Users/ericvicenti/Library/Application Support/CyberdeckSeed/companion.json",
  "runtimeFile": "/Users/ericvicenti/Library/Application Support/CyberdeckSeed/runtime.json"
}
```

| Key | Default | Meaning |
|---|---|---|
| `voice.hub` | unset | Name (or node id) of the paired node that runs the voice system. Set, every voice route relays there, whatever this node's own bridge says; naming this node means "answer here". Unset: this node's bridge, else the first paired node that has one. Env `CYBERDECK_VOICE_HUB` overrides. |
| `seed.companionFile` | `~/Library/Application Support/CaseworkSeed/companion.json` | Where the voice profile (and a Casework Companion to adopt) is read. |
| `seed.runtimeFile` | `~/Library/Application Support/CaseworkSeed/runtime.json` | The agents server's env file; its `SEED_AGENTS_VOICE_INTERNAL_TOKEN` lets the bridge apply the profile per room. |
| `seed.mcpUrl` | `http://127.0.0.1:<port>/api/mcp` | Where the agents server is told to reach this node's MCP server. Loopback is right for a server on this machine; a hosted server needs the public route `cyberdeck serve mcp` prints. |
| `seed.profiles.<name>` | none | Further agents servers (see "Profiles" below): each entry is a `seed` block of its own, layered over this one. |

| Key | Default | Meaning |
|---|---|---|
| `agentsUrl` | `http://127.0.0.1:3053` | The agents server. Its `GET /api/health` must report `voice: true`. Env `CYBERDECK_SEED_AGENTS_URL` overrides. |
| `identity` | `main` | Vault account name that signs. Env `CYBERDECK_SEED_IDENTITY` overrides. |
| `modelProvider`, `model` | `OpenAI`, `gpt-6-sol` | The harness agent's model (applied by the sync; also used when setup creates the voice agent). The provider name must be one configured on the agents server for that account (`cyberdeck seed login` creates `OpenAI`). Env `CYBERDECK_SEED_MODEL` overrides the model. |
| `reasoningLevel` | `medium` | Reasoning level of the harness agent (`low`…`max` for gpt-6; `""` = provider default). Env `CYBERDECK_SEED_REASONING` overrides. |
| `keyFile` | `~/.cyberdeck/seed-key` | A node identity for machines without a Seed vault (32 bytes of hex, `cyberdeck seed keygen`). Used when it exists and `CYBERDECK_SEED_KEY_SEED` is unset. |
| `memoryDirs` | Claude Code's memory dir for the first scan root | Extra directories of markdown notes for the memory pack (docs/AGENTS.md, "The harness"). |
| `agentId`, `sessionId` | unset | Optional fixed pointers; normally setup fills `seed.json` instead. |

State lives in `~/.cyberdeck/seed.json` (`{agentId, sessionId, queryAgentId, mcpRegisteredAt, mcpTools,
lastCallAt, dogfoodTriggerId, memoryPacks, login}`, mode 0600); it is written by setup, by the harness
sync, by session changes, and by every call.

### Nodes without a Seed vault

A Mac without the Seed app (clipper) or a Linux server has no vault to sign with. `cyberdeck seed
keygen` writes a fresh Ed25519 seed to `keyFile` (mode 0600) and the bridge signs as that node
identity from then on (`cyberdeck seed status` says `node key file -> z6Mk…`). The identity is its own
account on the agents server: it owns the agents and MCP record it creates, and it needs its own model
provider. `cyberdeck seed login` runs "Sign in with ChatGPT" for it (the agents server must run with
`SEED_AGENTS_SUBSCRIPTION_AUTH=true`): it prints the authorize URL, you open it in a browser that is
signed in to ChatGPT, approve, and paste the `localhost:1455/...` URL it redirects to (or just the
code) back into the prompt (`cyberdeck seed login --code <url>` works later too; `--status` polls).
On completion the bridge saves a `subscription` provider named `modelProvider` that references the
stored credentials. `cyberdeck seed providers` lists what the identity has. Then `cyberdeck seed setup
--no-adopt` and the first query (or `cyberdeck seed sync`) create the agents.

An agents server for such a node is the Seed repo's `agents/` service run with `bun src/main.ts`
and an env file. **The hub, clipper** (since 2026-10-16, moved from yacht's experiments server):

- launchd `sh.cyberdeck.seed-agents` runs `~/Library/Application Support/CyberdeckSeed/run-server.py`
  (umask 077, env from `runtime.json`, never logged) from the worktree
  `~/Code/Seed-worktrees/agent-voice/agents`, which is the Seed branch `voice-tool-feedback-pr` at the
  commit yacht ran (voice is not on Seed main yet; its migrations are older than main's, so the
  server has its own database `agents-voice.sqlite` and data dir `data-voice` in that folder; the
  Seed.app-binary server's database from before the move is kept beside it). Port 3053, hyper.media
  gateway, subscription auth, `SEED_AGENTS_VOICE_ENABLED=1`, worker `child`, Deepgram + Cartesia keys,
  `SEED_AGENTS_LIVEKIT_URL=ws://127.0.0.1:7880`, `SEED_AGENTS_LIVEKIT_PUBLIC_URL=ws://100.72.8.73:7880`
  (clipper's tailnet address: media reaches it from any tailnet device).
- launchd `sh.cyberdeck.livekit` runs `livekit-server --config .../CyberdeckSeed/livekit.yaml`
  (port 7880, rtc 7881/7882, `node_ip` the tailnet address; the API key and secret in
  `CyberdeckSeed/secrets/livekit.json` match `runtime.json`).
- `tailscale serve --bg --https=7443 http://127.0.0.1:7880` publishes LiveKit as
  `wss://clipper.<tailnet>:7443` (the `secureUrl` every grant carries) and `--https=443` the Desk.
- The identity is the node key (`z6Mku4qH…`), the OpenAI subscription provider was copied into the
  new database, `cyberdeck seed setup --no-adopt`, `sync --voice` and `dogfood` were re-run there.

yacht's former experiments server (`com.casework.seed-experiments`) keeps running for the Casework
experiments but with voice off (`SEED_AGENTS_VOICE_ENABLED=0`, LiveKit unloaded, no `:7443`), so no
node can discover it as a voice peer.

## Profiles: a second agents server

The default bridge signs into one agents server (`seed.agentsUrl`, the voice hub's). `seed.profiles` adds more, by name,
each with its own bridge, its own state file (`~/.cyberdeck/seed-<name>.json`: agent, session, MCP registration) and its
own agent on that server. The use is production Seed (`https://agentic.seed.hyper.media`, "agent.hm" in the Deck notes): an agent there that reaches this node through the
public MCP route (`cyberdeck serve mcp`, docs/AGENTS.md), while the voice hub keeps its experiments server.

```json
"seed": {
  "profiles": {
    "prod": { "agentsUrl": "https://agentic.seed.hyper.media", "mcpUrl": "https://yacht.tail0bb35a.ts.net:8443/api/mcp" }
  }
}
```

Names are lowercase letters, digits and dashes (they become file names; a bad name is reported in the log and skipped). An
entry inherits the file's `seed` block (identity, model, key file) and overrides what it sets; the `CYBERDECK_SEED_*` env
only ever applies to the default bridge; the default's `agentId`/`sessionId` never apply to a profile. `cyberdeck seed
--profile <name> status|setup|providers|login|reset-session|call` and `?profile=<name>` on
`/api/voice/status|setup|providers|login|session/reset|livekit|transcript` address the entry; `cyberdeck seed profiles`
(`GET /api/voice/profiles`) lists the default and every entry with its server, MCP url, agent and health. A profile is
answered by this node itself: the hub relay and "hub offline" never apply to it. `setup` of a profile whose server is not
on this machine refuses to run until `mcpUrl` is set, because the agents server could never call a loopback URL back. The
dogfood/runwatch/digest triggers, the harness sync and the boot-time MCP refresh stay with the default bridge.

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

The agents server keeps the tool list it discovered when the MCP server was registered, so 5 s after boot the
daemon compares its own `tools/list` with the fingerprint in `seed.json` (`mcpTools`) and re-sends `SetMcpServer`
when they differ (`SeedBridge.refreshMcp`): a deploy that adds a tool reaches the companion without a manual setup.

Re-running setup is idempotent for the MCP registration and keeps the agent and session. Rotating
the node token (`~/.cyberdeck/token`) requires a re-run so the secret on the agents server follows.

## Routes

| Route | Key | Returns |
|---|---|---|
| `GET /api/voice/config` | pairing | `{configured, provider: 'livekit' \| 'none', engine: 'seed', reason?, agentId?, sessionId?, via?}` |
| `POST /api/voice/livekit` | pairing | `{sessionId, url, token, room, identity, expiresAt, profile?}` from `CreateVoiceSession`; `secureUrl?` is the `wss://` twin of a local plain `ws://` url when tailscale serve publishes it; `profile: {voice, speed, applied, error?}` says whether the voice profile below reached the room; `503 {error: 'voice not configured', reason}` when unconfigured; `502 {error}` on a server failure |
| `GET /api/voice/status` | pairing | `{configured, reason?, agentsUrl, mcpUrl, seedProfile?, identity: {name, available, principal?, error?}, agent?: {id, name?}, sessionId?, health: {ok, voice, protocol, version, error?, checkedAt}, mcpRegisteredAt?, lastCallAt?, profile?: {voice, speed, runtimeToken, source}}`; `?profile=<name>` answers for that `seed.profiles` bridge (404 for an unknown name; also on `setup`, `providers`, `login`, `session/reset`, `livekit`, `transcript`) |
| `GET /api/voice/profiles` | node | `{profiles: [{name: null \| string, agentsUrl, mcpUrl, configured, reason?, identity, agent?, sessionId?, health, stateFile}]}`: the default bridge (`name: null`) then every `seed.profiles` entry |
| `POST /api/voice/session/reset` | pairing | `{sessionId, previous?, room?}`: a new session for the next call; body `{room?}` names a live call's LiveKit room, which the voice runtime is then switched to the new session (`room: {name, switched, error?}`), so the caller keeps talking |
| `GET /api/voice/transcript?limit=` | pairing | `{supported: true, sessionId?, messages: [{seq, role, text, at}], hasMoreBefore, notices: [{id, at, text, run?}]}`: user/assistant text of the current session (`GetSession`'s tail, cheap) plus the lines left by the `announce` tool (below) |
| `POST /api/voice/dogfood` | node token | `{triggerId, name, enabled, lastFiredAt?, lastError?, nextSummary?, created, updated}`: the daily fleet check-in trigger (below); body `{timezone?, timeOfDay?}` |
| `POST /api/voice/digest` | node token | `{triggerId, name, enabled, lastFiredAt?, lastError?, nextSummary?, account, signer, url, created, updated, granted, identityCreated}`: the weekly fleet digest trigger (below); body `{timezone?, timeOfDay?, dayOfWeek?}` |
| `POST /api/voice/runwatch` | node token | same shape plus `watches` (the harness agent id) and `headless`: the run-completed trigger that announces finished harness runs on the Desk (below) |
| `GET /api/voice/prompt` | node token | `{agentId, name?, current, desired, changed, applied: false}`: the agent's system prompt next to the fleet persona Cyberdeck ships (`fleetPrompt` in `src/daemon/seed.ts`) |
| `POST /api/voice/prompt` | node token | the same, after writing the persona to the agent when it differs (`applied: true`); the next session uses it |
| `POST /api/voice/setup` | node token | the setup result above (`{agent: {id, name?, origin: kept\|adopted\|created}, sessionId, mcp: {name, url, state, tools?, error?}, warnings}`); body `{new?, adopt?, name?}` |

`status` also carries `dogfood: {triggerId, name, enabled, lastFiredAt?, lastError?, nextSummary?}`, `runWatch` (same shape) and `digest` (same shape plus `account`, `signer`, `url`)
once the check-in trigger exists (read back from `ListAgentTriggers`, cached 10 s).

`configured` is true when the identity loads, the agents server answers `/api/health` with
`voice: true` (probed with a 3 s timeout, cached 10 s), and an agent is set up. The same summary
rides on `GET /api/state` and the Casework `welcome` frame as `voice`. On a node without a bridge
the pairing-key routes are relayed to a paired node that has one and every answer carries
`via: {node, name}` (see "Nodes without voice"); `status` then returns the voice node's status with
this node's own under `local`.

Each call follows `continue_session` successors (a session the agent continued into) before minting
the room, and recreates the session if the server no longer has it.

## CLI

```
cyberdeck seed status          # server health, identity, agent, session, last call; exit 1 when not ready
cyberdeck seed setup [--new]   # see above
cyberdeck seed profiles        # the default bridge and every seed.profiles entry: server, MCP url, agent, health
cyberdeck seed --profile prod status|setup|providers|login|reset-session|call   # the same, for a seed.profiles entry
cyberdeck seed reset-session   # next call starts a fresh session
cyberdeck seed call            # smoke test: mint a room and print it (token withheld, profile result included); nothing joins it
cyberdeck seed transcript [n]  # last n user/assistant messages
cyberdeck seed dogfood [--tz Europe/Madrid] [--at 07:00]   # daily fleet check-in trigger (idempotent; rewrites a stale prompt)
cyberdeck seed runwatch        # run-completed trigger: finished harness runs are announced on the Desk (idempotent)
cyberdeck seed digest [--tz Europe/Madrid] [--at 08:00] [--day 1]   # weekly fleet digest document: signing identity + publish grant + trigger (idempotent)
cyberdeck seed prompt [--apply]  # the agent's system prompt vs the fleet persona; --apply writes the persona
```

## Voice profile

The chosen voice lives in the hub's companion file (`seed.companionFile`, on clipper
`~/Library/Application Support/CyberdeckSeed/companion.json`, copied from the Casework host's
`CaseworkSeed/companion.json` on yacht) as `profile: {voice: <Cartesia voice id>, speed}`. The agents server applies a profile per room through
its internal runtime route (`POST /api/voice/runtime {room, profile}`, bearer
`SEED_AGENTS_VOICE_INTERNAL_TOKEN`), which the worker consults when it speaks. Every
`POST /api/voice/livekit` now does what the casework-host script did: right after `CreateVoiceSession`
it reads the profile from the companion file, reads the token from `SEED_AGENTS_VOICE_INTERNAL_TOKEN` in
the agents server's env file (`seed.runtimeFile`; env `CYBERDECK_SEED_VOICE_INTERNAL_TOKEN` overrides,
tests pass a `runtimeFile`), and posts
`{room, profile}` with a 5 s timeout. The call never fails on this step: the response's `profile`
says `applied: true`, or `applied: false` with the reason (`no voice runtime token (...)`,
`voice runtime HTTP 401`, a timeout), and the room speaks with the worker's default voice. A profile
that would not pass the server's validation (voice id `[a-zA-Z0-9-]{1,100}`, speed 0.6 to 2) is
skipped silently and `profile` is absent.

`status` reports `profile: {voice, speed, runtimeToken, source}` whenever `companion.json` has a valid
profile, so `cyberdeck seed status` and the Desk's bridge strip ("voice 13ff5deb x1") show which voice
calls will use and whether the token to apply it is on hand (amber LED when it is not). Only the hub
has the files; relayed status carries the hub's profile.

## Dogfood: the daily fleet check-in

`cyberdeck seed dogfood` makes sure a schedule trigger named `cyberdeck-fleet-checkin` exists on the
agent (`ListAgentTriggers` by name, else `CreateAgentTrigger`; the id is kept in `seed.json`). It is
weekly on all seven days at 07:00 Europe/Madrid by default (`{kind: 'weekly', daysOfWeek: [0..6],
timeOfDay, timezone}`, Sunday = 0), continuation `newThread`, and its prompt tells the agent to use
only the cyberdeck tools (`fleet_status`, `services` with a probe, `repos` with `kind: unpushed`,
`todo`, all `brief: true`) and leave one note under 400 characters in the Deck inbox via
`cyberdeck__note`. The prompt is `DOGFOOD_PROMPT` in `src/daemon/seed.ts`: when the trigger's prompt
differs from it (a trigger made by an older build), `dogfood` rewrites it with `UpdateAgentTrigger`
and answers `updated: true`, so a deploy plus `cyberdeck seed dogfood` moves the check-in to the
current wording. The 2026-10-15 run ended with a text answer and no note at all, which is why the
prompt now says the note is the run's only output. Schedule options only apply when the trigger is
created; edit the time in the agent's Triggers tab afterwards.

All of these go through the local daemon's HTTP API with the node token, like the other commands.

## Dogfood: the weekly fleet digest document

`cyberdeck seed digest` gives the agent a place to publish and a reason to: it makes sure of three things on
the agents server, each idempotent, and answers what it did (`identityCreated`, `granted`, `created`, `updated`).

1. A **signing identity** labelled `Cyberdeck fleet` (`ListSigningIdentities` by the recorded secret name,
   else by label, else `CreateSigningIdentity`). The agents server generates an hm account key for it, keeps
   it as an encrypted secret and publishes the account's profile and home to its `hmServerUrl` (hyper.media
   on the hub). That account is where the digests live: `status.digest.account` and `url`
   (`https://hyper.media/hm/<account>`); the secret name is `signer`.
2. The **publish grant**: the agent's definition lists that secret in `signingKeys` (`GetAgent`, then
   `UpdateAgent` with the rest of the definition untouched), so the `write` verb can sign `hm://` documents
   with it. Without a grant the server refuses every write ("No signing identities are enabled for this agent").
3. A weekly schedule trigger named `cyberdeck-fleet-digest`, Monday 08:00 Europe/Madrid by default
   (`--day 0-6`, Sunday = 0, `--at`, `--tz`; only applied when the trigger is created), continuation
   `newThread`, prompt `digestPrompt(account)` in `src/daemon/seed.ts`: fleet facts from the cyberdeck
   tools (`fleet_status`, `services` with a probe, `repos` unpushed, `todo`), the account's `:directory`
   and the newest earlier digest for "Since last week", then exactly one `write` to
   `hm://<account>/fleet-digest-<YYYY-MM-DD>` (top level, because `document.create` wants an existing
   parent), one `cyberdeck__note` line in the Deck inbox and one `cyberdeck__announce` on the Desk with the
   address. The prompt says the document is public and forbids tokens, keys, IP addresses and file paths.
   A trigger whose prompt differs (older build, or the account changed) is rewritten like the check-in.

The documents are published under the agent's own account, not Eric's: writing into Eric's space needs a
capability from Eric's key to the `Cyberdeck fleet` account (the agents server's `write` guide,
`capability.create`), which only Eric can sign. Until then the digest page is the agent account's home.
`seed.json` keeps `digestTriggerId`, `digestSignerName` and `digestAccount`.

## Run announcements: the agent tells you when a delegated run is done

Work delegated to the Seed harness agent (the prompt bar, the Seed view, a sub-run the voice agent
spawns) finishes while nobody is in a call. `cyberdeck seed runwatch` makes sure a `run-completed`
trigger named `cyberdeck-run-completed` exists on the voice agent, watching the harness agent
(`source: {type: 'run-completed', agentId: <queryAgentId>}`; the voice agent's own turns are runs
too, which is why the trigger is scoped to the other agent). Its continuation is the headless
`tool` kind: the agents server calls `cyberdeck__announce` with
`{runId, title, status, sessionId, agentId}` taken from the event (`$event.runTitle` and friends),
no model turn and no token spent; `onFailure: 'thread'` falls back to a thread with
`RUNWATCH_PROMPT`, which tells the agent to make that one call itself. The server checks the
continuation's tool against the agent's current tool list (verified on the experiments server: the shape is
accepted with a registered tool and refused with `Trigger tool "cyberdeck__announce" is not one of this
agent's tools` before the daemon that serves it is deployed), so a refusal naming the tool gets one
`refreshMcp` and one retry; a server that still rejects it gets the thread form, and a trigger left in
thread form is upgraded to the headless call by the next `runwatch`. Like `dogfood`, it is idempotent by name,
keeps the id in `seed.json`, and patches a stale prompt or a changed harness agent in place; it needs
the harness agent to exist (`cyberdeck seed sync`, or one prompt-bar query).

The `announce` MCP tool composes the line (`Done: "<title>" finished.`, `Failed: "<title>" failed.`)
or takes `text` as given, keeps the newest 50 in `seed.json` (`notices`), and
`GET /api/voice/transcript` returns them as `notices` next to the messages, so a node without a
bridge sees the hub's announcements through the relay. A run without a `sessionId` is a workflow
sub-step (Seed's `await` children have no session; the owner's runs and delegated agent runs do), and
is skipped with `announced: false` so one job announces once. The web Desk sorts notices into the
transcript by time with a `fleet` label and refreshes the history every 20 s between calls; the
spoken side (the worker saying it when a call is live) is not done, see "Not done".

## Voice-initiated workflows: "check every host and tell me what is down"

A call should stay a conversation, so the voice agent does not sit through a job that touches several
machines. Its prompt (`fleetPrompt`) tells it to hand such jobs to the fleet agent: the `delegate` MCP
tool (`task`, optional `title`) creates a fresh session on the harness agent (the one behind the prompt
bar and the Seed view, `queryAgentId`), sends the task as its first turn and returns the `sessionId`
after a short grace period (1.5 s, long enough for an immediate refusal to surface). The agents server
answers `MessageSession` only when the run is over, so the daemon keeps that request open in the
background (up to 30 min) and the voice agent is free to say "handed off, the Desk gets a line when it
is done" and take the next question. The harness agent runs the job with the same cyberdeck tools and
its own fleet knowledge; the Seed view (journal) shows the session like any prompt-bar query.

When the run finishes, the `cyberdeck-run-completed` trigger calls `announce` with the run's title,
status and session, and the line now carries the answer: `Done: "Fleet check" finished: Two hosts are
down: starlight and clipper. The other seven answer.` (the newest assistant message of that session,
clipped to 220 characters; failed runs and lines given as `text` are left alone). `delegate_result`
(`sessionId`) reads the answer back at any time, for "what did it find?" on the next call: `state` is
`running` while the session is streaming, `waiting` when no answer has been written yet, `done` once an
answer follows the last question. A node without a Seed bridge set up refuses both tools at once with
the `cyberdeck seed setup` hint instead of probing anything. Tests: `tests/seed-delegate.test.ts` (a
fake agents server playing the session API) and the refusal in `tests/mcp.test.ts`.

## The voice hub

The voice system runs on one node, named by `voice.hub` on every node (`createVoiceRelay` in
`src/daemon/api/voice.ts` with `pinned`). A node whose hub is another node relays `config`, `livekit`,
`status`, `transcript` and `session/reset` to that paired peer through the fleet proxy (reads give up
after 6 s, the call grant and `session/reset` after 15 s), whatever its own bridge says, and every answer
carries `via: {node, name}`; `status` adds the local bridge under `local`. `setup`, `dogfood`, `runwatch` and `prompt` always target the node itself. A request that
arrives with the `x-cyberdeck-voice-direct` header is never relayed again, so a misconfigured hub
cannot bounce. When the hub is not paired with the node, voice is simply off there with the reason
`voice hub clipper is not paired with this node` (pair it from Home). `/api/state`, the Casework
`welcome` frame and `cyberdeck seed status` (`voice hub: clipper (…) answers every voice route of this
node`) say the same.

The companion's triggers and prompt go the same way: `POST /api/voice/dogfood|runwatch|digest` and
`GET|POST /api/voice/prompt` (node token; `cyberdeck seed dogfood|runwatch|digest|prompt`) on a node pinned to a
hub act on the hub's companion and answer with `via`, so the fleet has one check-in, one digest identity and one
persona wherever the command is typed (2026-10-26: before this, `cyberdeck seed digest` on yacht made a second
trigger, grant and signing identity on yacht's own agents server while `status` showed clipper's). A pinned hub that
is not paired refuses them (503, `not paired`) instead of acting locally. `?profile=<name>` stays local (a profile is
this node's own bridge), and so do `setup`, `keygen`, `login`, `providers` and the harness routes: the identity and
the prompt-bar harness are per node.

A paired hub that does not answer (asleep, off the tailnet) is a different state, **hub offline**, not a
setup problem: the relay remembers the failure for 10 s (`HUB_DOWN_TTL_MS`) so the Desk's and the iPad's
polls answer at once instead of each waiting out a connect, and every voice route says
`voice hub clipper is paired but not answering (no answer in time; last seen 2 h ago); calls resume when
it is back on the network` with `via` and `hub: {name, node, reachable: false, since, lastSeen}` next to
`reason` (`config` → `configured: false`; `livekit` and `session/reset` → 503 `voice hub unreachable`;
`transcript` → 503, `supported: true`; `status` → `configured: false` over the local bridge). `/api/state`
and `welcome` carry the same reason. The web Desk shows an amber "voice hub clipper is offline" card
(`voice-hub-offline`, no setup button), the bridge strip reads `voice clipper offline`, and the page
rechecks every 15 s so TALK comes back by itself when the hub does.

When the hub does not answer because **this node** is the one off the tailnet (its Tailscale is stopped or
logged out: `tailscale status --json` `BackendState` other than `Running`, read by `Tailscale.backend()` after
a relay failure and never otherwise), the same routes blame this node instead: `yacht is off the tailnet, so
voice hub clipper is out of reach (Tailscale on yacht is logged out: log in from the Tailscale menu there, or
run tailscale up; hub last seen 10 h ago); calls resume once this node is back on the tailnet`, with
`hub.tailnet: {state: "NeedsLogin" | "Stopped" | …, running: false}`. The Desk card then reads "yacht is off
the tailnet" and the strip `voice clipper out of reach`. The Tailscale login url is written to the daemon log
only (`voice: relay to clipper failed: … log in at https://login.tailscale.com/a/…`), never into an HTTP
answer: the pairing-key routes reach devices that must not be able to re-home the node (2026-10-27: yacht's
node key had expired overnight and every answer said clipper was offline while clipper was fine).

The web Desk talks only to the daemon in view and shows the hub in its bridge strip (`voice clipper`);
the shell has no machine dropdown anywhere (nothing on the Desk picks a machine either). Without a
hub configured (not the fleet's setup), a node with no bridge of its own still finds the first paired
node whose `/api/voice/config` says configured (probe 4 s, found peer trusted 60 s, miss 15 s) and
relays there, so nothing breaks on a node that missed the config.

## Browser microphone and HTTPS

Browsers only expose `getUserMedia` on secure origins, so the web Desk can place calls from
`http://localhost:4777` on the node itself but not from a plain-HTTP tailnet address. Run
`cyberdeck serve` and use `https://<node>.<tailnet>.ts.net`. The LiveKit `url` the hub hands out is
clipper's tailnet `ws://` address, so the caller must be on the tailnet. An https page cannot open a
plain `ws://` address at all (mixed content): the hub publishes LiveKit over TLS and
`POST /api/voice/livekit` adds `secureUrl` (the `wss://` twin, `secureCallUrl` in `api/voice.ts`,
computed on the hub and relayed as is), which an https Desk uses; without it the Desk fails with a
message naming the fix. On clipper:

    tailscale serve --bg --https=7443 http://127.0.0.1:7880   # LiveKit signaling -> wss://clipper.<tailnet>:7443

Media flows over WebRTC to the address LiveKit advertises (`rtc.node_ip`, clipper's tailnet IP), so
any tailnet device works, on the LAN or not; a device that is not on the tailnet (the buoy iPad until
Tailscale is installed there) cannot reach the hub at all.

## Phone home-screen button

The Desk is installable. On `#/desk` the page swaps in `/desk.webmanifest` (name "Desk", mic icon,
`start_url` `/#/desk`, standalone) and the matching `apple-touch-icon`/title (`ui/lib/pwa.ts`); every
other page advertises `/manifest.webmanifest` (Cyberdeck). The Home page's pairing card shows a
**Phone · Desk** QR beside the Casework one: it points at the `tailscale serve` origin when there is one
(`Tailscale.serveOrigin`, else the page's own https origin) and warns when the link would be plain http.
Scan it, sign in (on the tailnet the Tailscale identity is enough), then Share → Add to Home Screen.
There is no service worker on purpose: the UI must never be served stale after a fleet deploy.

## Fleet / Services / Agents glance

Under the TALK button the Desk shows the same overview the agent reads through its MCP tools
(`GET /api/control/overview`, allowed for the Casework pairing key; refreshed every 60 s), in three tabs
that mirror the iPad screen's Fleet and Agents tabs: hosts (down first), services that are down or unknown,
and live collab tasks plus recent runs. Each tab's chip counts what needs a look, rows open the full view,
and a "try asking" line suggests the question to put to the agent (`ui/lib/glance.ts`, tests
`tests/glance.test.ts`). A node without a fleet dir says so instead.

## Hands-free and push-to-talk

The TALK button has two modes, picked with the small switch under it and remembered per browser
(`cyberdeck-voice-mode` in localStorage; the planner is `ui/lib/talk.ts`, tests `tests/talk.test.ts`):

- **hands-free** (the default): tap TALK to call, the mic stays open, tap END to hang up; a mute chip
  closes the mic for a while.
- **push to talk**: tap TALK to place the call; the mic is published but muted, and the button reads HOLD.
  Hold it (or hold the space bar when a keyboard is attached, outside text fields) to open the mic, let go
  to close it again; the ring is dashed green while the mic is closed and breathes green while it is open.
  "end call" moves to a chip so the big button can be held. Switching modes mid-call takes effect at once.

The iPad Talk tab (`casework/cyberdeck.tsx`) has the same two modes over the app's native call actions
(`voice.start`, then `call.mute` on press-in / press-out), and its tab row doubles as the status bar: the
Talk tab reads "TALK · LISTENING / THINKING / SPEAKING / MUTED / CONNECTING" with a matching LED from
whatever tab is open, so a glance at the top of the screen says what the agent is doing.

### Stop listening, by voice

"Stop listening", "mute", "hold on", "that's all", "hang up" are things said to the agent, so the agent must
be able to act on them: the `listen` MCP tool (`action: mute | unmute | hangup`) writes a *control notice*
on the hub's bridge (`SeedBridge.control`, kept with the `announce` notices in seed.json, so the transcript
also shows "Microphone muted at your request" / "Call ended at your request"). While a call is up the web
Desk and the iPad Talk tab poll `GET /api/voice/control` every 3 s (relayed to the hub like the other voice
routes; the pairing key may read it): the first poll, without `since`, returns the server's `now` as the
baseline, every later poll passes it back and gets the control notices with `since < at <= now`, and the client
applies them (`toggleMute` / `stop` on the Desk, `call.mute` / `call.stop` on the iPad). The companion's fleet
persona tells it to say goodbye *before* `hangup`, because nothing after it is heard, and to stay silent after
`mute` until unmuted. Tests: `tests/voice.test.ts` "control: …", `tests/mcp.test.ts` "write tools say what
they did".

## The web Casework client is this Desk

Decided 2026-10-15: the browser version of the Casework Desk is Cyberdeck's `#/desk`, not a web build of
the Expo app. The Desk already does everything the iPad Talk tab does (LiveKit in the browser through
`livekit-client`, the agent state, the transcript from the real session, mute, modes, new session), plus the
Fleet / Services / Agents glance, installs as a PWA, and runs on any node of the fleet (a node without a
voice bridge proxies to one that has it). The iPad app itself shows the whole web deck in its Deck tab, so
both clients render the same UI from the same daemon; a second web client made of `.web.ts` shims in
`remote-control` would duplicate the voice stack (react-native-webrtc has no browser twin) and the pairing
flow for no new capability. The Expo app stays iOS only; `remote-control/README.md` points browsers here.

## Not done

- Announcements are written, not spoken: when a call is live the worker does not read a new notice aloud (that needs a Seed-side hook from the trigger into the room); the Desk shows it within 20 s.
- **Voice profile editing**: Cyberdeck applies the profile but has no UI or route to change it; the
  Casework host's `set_voice` tool (or editing `companion.json`) is still how it is chosen.
- **Voice on Seed main**: the hub runs the unmerged Seed voice branch at a pinned commit. When the
  voice PRs land, point the clipper worktree at main, merge the two databases' agents (or re-run
  setup) and drop the `agents-voice.sqlite` split.
- **Production agents server** is not wired: pointing `seed.agentsUrl` at a hosted server also needs
  the MCP URL to be reachable from there (docs/AGENTS.md, Reachability) and that server to run a
  voice pipeline.
- **Transcript** is the session's durable events, not the live call: the LiveKit transcription
  events arrive on the client (the Desk shows them live and reloads the durable tail when the call
  ends), not through this daemon.
- No web Desk UI section here: the UI half lives in `ui/` and talks to the same routes.

## The fleet persona

An agent Cyberdeck creates gets `fleetPrompt(name)` as its system prompt; an adopted companion keeps
whatever prompt it had until `cyberdeck seed prompt --apply` replaces it (never silently: the owner may
have tuned the agent on the server). The persona makes the agent speak for a voice channel (answer first,
one or two sentences, no markdown), work from the cyberdeck tools with `brief: true` instead of guessing,
say what it checked, ask before restarts and collab runs, and leave a trace with `handoff_note`, `note`
and `todo_add`. Apply, then `cyberdeck seed reset-session` so the next call starts on the new prompt.

Once `cyberdeck seed sync --voice` has adopted the companion, its prompt is **managed**: persona + the
knowledge section (fleet rules, Deck protocol, the memory pack's index), with the sync's hash in the agent's
`metadata.cyberdeck.promptHash`. `cyberdeck seed prompt` then compares by that hash (`managed: true`,
`desired` is the whole managed text) and `--apply` rewrites persona + pack together with a fresh hash, the
same write the sync does, so it is safe from any node, including through the hub relay (2026-10-27: before
this, the hub's companion read as "differs" forever and an `--apply` from yacht would have stripped clipper's
three pack sections).

## The screen: Afterglow by voice

"What is on the TV", "pause", "skip back thirty seconds", "search for Blade Runner", "play Heat": the `media` MCP
tool (docs/AGENTS.md) drives the fleet screen, the kiosk Chromium that `cyberdeck-kiosk.service` supervises on a
node with `kiosk.enabled` (enuc today). The daemon on that node attaches over the loopback CDP port it already uses
for the screen stream, finds Afterglow's iframe (`window.afterglowNavigation`) and its `<video>`, and does the one
thing asked: playback is a DOM call on the video, navigation is an Afterglow hash route, and `watch` matches the
spoken title against Afterglow's `/api/library` (the application URL in config) and opens `watch/<id>/<file>`.
With no Afterglow on screen the outer page is pointed at `#/applications?app=afterglow&route=…` first. Every other
node answers `POST /api/kiosk/media` with 409, so the hub's tool call walks this node and then each peer and uses
the first screen that answers (or `host` names it). The Casework pairing key may call the route too, so the iPad
remote can grow media buttons without a new scope. The native macOS Casework player on clipper is not reached
yet: it speaks `casework.input` over `/api/command`, a second screen type for the same tool.
