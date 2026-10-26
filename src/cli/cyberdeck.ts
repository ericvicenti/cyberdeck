#!/usr/bin/env bun
// cyberdeck CLI — talks to the local daemon and manages the service.
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { CYBERDECK_HOME, loadConfig } from "../daemon/config";
import { tailscaleBin, Tailscale, MCP_FUNNEL_PORT, MCP_PATH } from "../daemon/tailscale";

const cfg = loadConfig();
const BASE = `http://127.0.0.1:${cfg.port}`;
const SRC = join(CYBERDECK_HOME, "src");
const cmd = process.argv[2] ?? "help";

function token(): string {
  const p = join(CYBERDECK_HOME, "token");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

async function api(path: string, init?: RequestInit & { text?: boolean }): Promise<any> {
  const { text, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: { authorization: `Bearer ${token()}`, ...(rest.body ? { "content-type": "application/json" } : {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return text ? res.text() : res.json();
}
const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : "never");

async function sh(command: string[]): Promise<number> {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

const isMac = process.platform === "darwin";
const PLIST = join(homedir(), "Library/LaunchAgents/sh.cyberdeck.daemon.plist");
const uid = process.getuid?.() ?? 501;

async function serviceRestart() {
  if (isMac) await sh(["launchctl", "kickstart", "-k", `gui/${uid}/sh.cyberdeck.daemon`]);
  else await sh(["systemctl", "--user", "restart", "cyberdeck.service"]);
}

switch (cmd) {
  case "status": {
    try {
      const s = await api("/api/status");
      console.log(`cyberdeck ${s.version} — node "${s.nodeName}"`);
      console.log(`roots: ${s.roots.join(", ")}`);
      console.log(
        `repos: ${s.repos ?? 0}  at-risk: ${s.atRisk ?? 0}  attention: ${s.attention ?? 0}  safe: ${s.safe ?? 0}`
      );
      console.log(`reclaimable junk: ${((s.junkBytes ?? 0) / 1e9).toFixed(1)} GB`);
      console.log(s.scanning ? "scan in progress…" : `last scan: ${s.lastScanAt ? new Date(s.lastScanAt).toLocaleString() : "never"}`);
    } catch {
      console.log("daemon not reachable — try: cyberdeck restart");
      process.exit(1);
    }
    break;
  }
  case "open": {
    const url = `${BASE}/#t=${token()}`;
    await sh([isMac ? "open" : "xdg-open", url]);
    break;
  }
  case "scan":
    await api("/api/scan", { method: "POST" });
    console.log("scan started");
    break;
  case "restart":
    await serviceRestart();
    console.log("restarted");
    break;
  case "stop":
    if (isMac) await sh(["launchctl", "bootout", `gui/${uid}`, PLIST]);
    else await sh(["systemctl", "--user", "stop", "cyberdeck.service"]);
    break;
  case "start":
    if (isMac) await sh(["launchctl", "bootstrap", `gui/${uid}`, PLIST]);
    else await sh(["systemctl", "--user", "start", "cyberdeck.service"]);
    break;
  case "logs":
    await sh(["tail", "-f", join(CYBERDECK_HOME, "logs/daemon.log"), join(CYBERDECK_HOME, "logs/daemon.err.log")]);
    break;
  case "update": {
    // Cyberdeck manages its own source: pull, rebuild, restart.
    console.log("updating source…");
    if ((await sh(["git", "-C", SRC, "pull", "--ff-only"])) !== 0) process.exit(1);
    for (const step of [["bun", "install"], ["bun", "run", "build"]]) {
      const proc = Bun.spawn(step, { cwd: SRC, stdout: "inherit", stderr: "inherit" });
      if ((await proc.exited) !== 0) process.exit(1);
    }
    await serviceRestart();
    console.log("updated and restarted");
    break;
  }
  case "serve": {
    // HTTPS on the tailnet via `tailscale serve`: valid certs for <node>.<tailnet>, reachable only from the tailnet.
    const bin = tailscaleBin();
    if (!bin) { console.log("tailscale CLI not found"); process.exit(1); }
    if (process.argv[3] === "off") {
      process.exit(await sh([bin, "serve", "--https=443", "off"]));
    }
    if (process.argv[3] === "mcp") {
      // Public MCP route for a hosted agents server (agent.hm) via Tailscale Funnel. Funnel is per port, so the
      // tailnet-only UI on 443 stays tailnet-only and the MCP endpoint gets its own port with a single path
      // handler: anything but /api/mcp answers 404 at the edge, /api/mcp still needs the bearer token
      // (serve overwrites the Tailscale-User-* identity headers, so a public caller cannot pose as the owner).
      // docs/AGENTS.md "Reachability".
      const target = `http://127.0.0.1:${cfg.port}${MCP_PATH}`;
      if (process.argv[4] === "off") {
        process.exit(await sh([bin, "funnel", "--bg", `--https=${MCP_FUNNEL_PORT}`, `--set-path=${MCP_PATH}`, "off"]));
      }
      const code = await sh([bin, "funnel", "--bg", `--https=${MCP_FUNNEL_PORT}`, `--set-path=${MCP_PATH}`, target]);
      if (code !== 0) process.exit(code);
      const f = await new Tailscale().funnel(cfg.port);
      console.log(f.mcpUrl ? `public MCP route: ${f.mcpUrl} (bearer-gated; \`cyberdeck mcp\` prints the header, \`cyberdeck serve mcp off\` stops it)` : "funnel set, but `tailscale serve status --json` does not show it yet; run `cyberdeck mcp` in a moment");
      if (f.rootPublic) console.log(`WARNING: ${f.rootPublic} publishes this node's whole UI to the internet; run: tailscale funnel --https=${new URL(f.rootPublic).port || 443} off`);
      break;
    }
    const code = await sh([bin, "serve", "--bg", "--https=443", `http://127.0.0.1:${cfg.port}`]);
    if (code !== 0) process.exit(code);
    const self = await new Tailscale().self();
    console.log(self ? `serving https://${self.dnsName}` : "serving (run `tailscale status` for the hostname)");
    const f = await new Tailscale().funnel(cfg.port);
    if (f.rootPublic) console.log(`WARNING: ${f.rootPublic} is funneled to the public internet (the whole UI); run: tailscale funnel --https=${new URL(f.rootPublic).port || 443} off`);
    break;
  }
  case "mcp": {
    // Connection details for an MCP client (Seed Agents: Tools tab -> Add server).
    const ts = new Tailscale();
    const self = await ts.self().catch(() => null);
    const funnel = await ts.funnel(cfg.port).catch(() => ({ mcpUrl: null, rootPublic: null }));
    const urls = [`${BASE}/api/mcp`];
    if (self?.dnsName) urls.push(`https://${self.dnsName}/api/mcp (tailnet, needs \`cyberdeck serve\`)`);
    if (funnel.mcpUrl) urls.push(`${funnel.mcpUrl} (public internet via Tailscale Funnel, \`cyberdeck serve mcp\`)`);
    if (process.argv[3] === "--json") { console.log(JSON.stringify({ urls: [urls[0], ...(self?.dnsName ? [`https://${self.dnsName}/api/mcp`] : []), ...(funnel.mcpUrl ? [funnel.mcpUrl] : [])], public: funnel.mcpUrl, headers: { Authorization: `Bearer ${token()}` }, transport: "http" })); break; }
    console.log(`Cyberdeck MCP server (Streamable HTTP, stateless)\n`);
    for (const u of urls) console.log(`  url:        ${u}`);
    console.log(`  header:     Authorization: Bearer ${token()}`);
    console.log(`  transport:  http\n\nIn Seed Agents: Tools tab -> MCP servers -> Add server, paste the url and the header; name it "cyberdeck".\nSee docs/AGENTS.md for reachability (a hosted agents server needs the public route: \`cyberdeck serve mcp\`).`);
    if (funnel.rootPublic) console.log(`\nWARNING: ${funnel.rootPublic} is funneled to the public internet (the whole UI, not just MCP); run: tailscale funnel --https=${new URL(funnel.rootPublic).port || 443} off`);
    break;
  }
  case "seed": {
    // Seed agents bridge (voice): all through the daemon's /api/voice/* routes (docs/VOICE.md).
    // `--profile <name>` (anywhere after `seed`) addresses a `seed.profiles` bridge, another agents server this node signs into.
    const argv = process.argv.slice(3);
    const pi = argv.findIndex((f) => f === "--profile" || f === "-p");
    const profile = pi >= 0 ? argv[pi + 1] : undefined;
    if (pi >= 0) { if (!profile) { console.log("usage: cyberdeck seed --profile <name> <command>"); process.exit(2); } argv.splice(pi, 2); }
    const q = profile ? `?profile=${encodeURIComponent(profile)}` : "";
    const sub = argv[0] ?? "status";
    const flags = argv.slice(1);
    const fail = (e: unknown) => { console.log(`seed ${sub} failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); };
    if (sub === "profiles") {
      // Every bridge of this node: the default, then each seed.profiles entry.
      const r = await api("/api/voice/profiles").catch(fail);
      for (const p of r.profiles) {
        console.log(`${p.name ?? "(default)"}: ${p.agentsUrl} (${p.health?.ok ? `up${p.health.voice ? ", voice" : ", no voice"}` : `down: ${p.health?.error ?? "?"}`}); mcp ${p.mcpUrl}; ${p.agent ? `agent ${p.agent.name ?? "?"} (${p.agent.id})` : "not set up"}${p.configured ? "; voice ready" : p.reason ? `; ${p.reason}` : ""}`);
      }
      if (r.profiles.length === 1) console.log("no seed.profiles in config.json (docs/VOICE.md, \"Profiles\")");
    } else if (sub === "status") {
      const s = await api(`/api/voice/status${q}`).catch(fail);
      if (s.seedProfile) console.log(`profile:       ${s.seedProfile} (state ${s.seedProfile ? `seed-${s.seedProfile}.json` : "seed.json"})`);
      console.log(`agents server: ${s.agentsUrl}  (${s.health?.ok ? `up${s.health.voice ? ", voice" : ", NO voice"}${s.health.version ? `, ${s.health.version}` : ""}` : `down: ${s.health?.error ?? "?"}`})`);
      if (s.mcpUrl && !/^http:\/\/127\.0\.0\.1:/.test(s.mcpUrl)) console.log(`mcp url:       ${s.mcpUrl}`);
      console.log(`identity:      ${s.identity.source === "file" ? "node key file" : s.identity.source === "env" ? "env key" : s.identity.name} ${s.identity.available ? `-> ${s.identity.principal}` : `(unavailable: ${s.identity.error ?? "?"})`}`);
      console.log(`agent:         ${s.agent ? `${s.agent.name ?? "?"} (${s.agent.id})` : "not set up"}`);
      console.log(`session:       ${s.sessionId ?? "none"}`);
      console.log(`mcp registered: ${when(s.mcpRegisteredAt)}   last call: ${when(s.lastCallAt)}`);
      if (s.via) console.log(`voice hub:     ${s.via.name} (${s.via.node}) answers every voice route of this node`);
      if (s.dogfood) console.log(`dogfood:       ${s.dogfood.name} (${s.dogfood.triggerId}) ${s.dogfood.enabled ? "enabled" : "disabled"}, ${s.dogfood.nextSummary ?? ""}; last fired ${when(s.dogfood.lastFiredAt)}${s.dogfood.lastError ? `; last error: ${s.dogfood.lastError}` : ""}${s.dogfood.lastNoteDate ? `; last inbox line ${s.dogfood.lastNoteDate}` : ""}${s.dogfood.missedNote ? " (MISSED: the last firing left no inbox line; `cyberdeck seed dogfood` re-applies the current prompt)" : ""}`);
      if (s.runWatch) console.log(`run watch:     ${s.runWatch.name} (${s.runWatch.triggerId}) ${s.runWatch.enabled ? "enabled" : "disabled"}, ${s.runWatch.nextSummary ?? ""}; last fired ${when(s.runWatch.lastFiredAt)}${s.runWatch.lastError ? `; last error: ${s.runWatch.lastError}` : ""}`);
      if (s.digest) console.log(`digest:        ${s.digest.name} (${s.digest.triggerId}) ${s.digest.enabled ? "enabled" : "disabled"}, ${s.digest.nextSummary ?? ""}; last fired ${when(s.digest.lastFiredAt)}${s.digest.lastError ? `; last error: ${s.digest.lastError}` : ""}${s.digest.url ? `; documents at ${s.digest.url}` : ""}`);
      if (s.profile) console.log(`voice profile: ${s.profile.voice} x${s.profile.speed} (${s.profile.runtimeToken ? "runtime token on hand" : "NO runtime token: calls keep the worker's default voice"})`);
      console.log(s.configured ? "voice: ready (provider livekit)" : `voice: not configured — ${s.reason}`);
      const h = profile ? null : await api("/api/voice/harness").catch(() => null);
      if (h) {
        console.log(`harness:       ${h.queryAgent ? `${h.queryAgent.name ?? "?"} (${h.queryAgent.id}) ${h.queryAgent.model ?? "?"}${h.queryAgent.reasoningLevel ? `@${h.queryAgent.reasoningLevel}` : ""}, prompt ${h.queryAgent.promptCurrent ? "current" : "STALE (run cyberdeck seed sync)"}, ${h.queryAgent.memoryFiles} pack files` : "no harness agent yet (first prompt-bar query creates it, or cyberdeck seed sync)"}`);
        if (h.voiceAgent) console.log(`voice agent:   ${h.voiceAgent.name ?? "?"} prompt ${h.voiceAgent.managed ? (h.voiceAgent.promptCurrent ? "managed, current" : "managed, STALE") : "not managed (cyberdeck seed sync --voice adopts it)"}, ${h.voiceAgent.memoryFiles} pack files`);
        console.log(`sources:       rules ${h.sources.rules ?? "none"}; deck ${h.sources.deck ?? "none"}; ${h.sources.notes} notes from ${h.sources.memoryDirs.join(", ") || "no memory dir"}; node tools ${h.nodeTools ? "on" : "off"}`);
      }
      if (!s.configured && !h?.queryAgent) process.exit(1);
    } else if (sub === "setup") {
      const name = flags.includes("--name") ? flags[flags.indexOf("--name") + 1] : undefined;
      const r = await api(`/api/voice/setup${q}`, { method: "POST", body: JSON.stringify({ new: flags.includes("--new"), adopt: !flags.includes("--no-adopt"), ...(name ? { name } : {}) }) }).catch(fail);
      console.log(`agent:   ${r.agent.name ?? "?"} (${r.agent.id}) — ${r.agent.origin}`);
      console.log(`session: ${r.sessionId}`);
      console.log(`mcp:     ${r.mcp.name} -> ${r.mcp.url} (${r.mcp.state ?? "unknown"}${typeof r.mcp.tools === "number" ? `, ${r.mcp.tools} tools` : ""}${r.mcp.error ? `: ${r.mcp.error}` : ""})`);
      for (const w of r.warnings ?? []) console.log(`warning: ${w}`);
    } else if (sub === "sync") {
      // Prompt, memory pack and definition of the agents, from this node's files; --voice adopts the companion's prompt too.
      const r = await api("/api/voice/harness/sync", { method: "POST", body: JSON.stringify({ voice: flags.includes("--voice"), force: flags.includes("--force") }) }).catch(fail);
      console.log(`sources: rules ${r.sources.rules ?? "none"}; deck ${r.sources.deck ?? "none"}; ${r.sources.notes} notes; prompt ${r.promptBytes} chars`);
      for (const a of r.agents) console.log(`${a.role.padEnd(8)} ${a.name ?? "?"} (${a.agentId}): ${a.created ? "created" : a.definition.length ? `updated ${a.definition.join(", ")}` : a.skipped ? `skipped (${a.skipped})` : "definition unchanged"}; memory ${a.memory.written} written, ${a.memory.deleted} deleted, ${a.memory.unchanged} unchanged of ${a.memory.files}${a.memory.error ? ` (error: ${a.memory.error})` : ""}`);
      for (const w of r.warnings ?? []) console.log(`warning: ${w}`);
    } else if (sub === "prompt-text") {
      console.log(await api("/api/voice/harness/prompt", { text: true }).catch(fail));
    } else if (sub === "keygen") {
      // A node identity for machines without a Seed vault (~/.cyberdeck/seed-key).
      const r = await api("/api/voice/keygen", { method: "POST", body: JSON.stringify({ force: flags.includes("--force") }) }).catch(fail);
      console.log(`${r.created ? "created" : "kept existing"} ${r.keyFile}`);
      console.log(`identity: ${r.available ? `${r.principal} (${r.source === "file" ? "node key file" : r.source === "env" ? "CYBERDECK_SEED_KEY_SEED still wins over the file" : "the vault account still wins; the file is unused"})` : `unavailable: ${r.error}`}`);
    } else if (sub === "providers") {
      const r = await api(`/api/voice/providers${q}`).catch(fail);
      for (const p of r.providers) console.log(`${p.name}: ${p.type}${p.authMode ? ` (${p.authMode})` : ""}${p.authStatus ? ` ${p.authStatus}` : ""}`);
      if (!r.providers.length) console.log("no model providers on this identity: run `cyberdeck seed login`");
    } else if (sub === "login") {
      // "Sign in with ChatGPT" for the agents server identity: open the URL, paste the redirect URL (or code) back.
      if (flags.includes("--code")) {
        const r = await api(`/api/voice/login${q}`, { method: "POST", body: JSON.stringify({ code: flags[flags.indexOf("--code") + 1] }) }).catch(fail);
        console.log(`login ${r.status}${r.provider ? `; provider ${r.provider} saved` : ""}${r.error ? `: ${r.error}` : ""}`);
      } else if (flags.includes("--status")) {
        const r = await api(`/api/voice/login${q}`, { method: "POST", body: JSON.stringify({ status: true }) }).catch(fail);
        console.log(`login ${r.status}${r.provider ? `; provider ${r.provider} saved` : ""}${r.error ? `: ${r.error}` : ""}`);
      } else {
        const r = await api(`/api/voice/login${q}`, { method: "POST", body: JSON.stringify({}) }).catch(fail);
        console.log(`Open this URL in a browser signed in to ChatGPT, approve, then paste the URL it redirects to (localhost:1455/...) here:\n\n${r.authUrl}\n`);
        process.stdout.write("redirect URL or code: ");
        const code = (await new Promise<string>((res) => { let buf = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => { buf += d; if (buf.includes("\n")) res(buf); }); process.stdin.on("end", () => res(buf)); })).trim();
        if (!code) { console.log("no code entered; run `cyberdeck seed login --code <url>` later (the login stays pending a while)"); process.exit(1); }
        const done = await api(`/api/voice/login${q}`, { method: "POST", body: JSON.stringify({ code, loginId: r.loginId }) }).catch(fail);
        console.log(`login ${done.status}${done.provider ? `; provider ${done.provider} saved` : ""}${done.error ? `: ${done.error}` : ""}`);
        process.exit(done.status === "completed" ? 0 : 1);
      }
    } else if (sub === "reset-session") {
      const r = await api(`/api/voice/session/reset${q}`, { method: "POST" }).catch(fail);
      console.log(`new session: ${r.sessionId}${r.previous ? ` (was ${r.previous})` : ""}`);
    } else if (sub === "call") {
      // Smoke test: mint a LiveKit room without joining it (the token is withheld; the room times out on the worker).
      const r = await api(`/api/voice/livekit${q}`, { method: "POST" }).catch(fail);
      const { token: _t, ...rest } = r;
      console.log(JSON.stringify({ ...rest, token: "<withheld>", expiresIn: `${Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000))}s` }, null, 2));
    } else if (sub === "dogfood") {
      // Daily fleet check-in trigger on the agent: --tz <IANA zone> --at HH:MM (defaults Europe/Madrid 07:00).
      const tz = flags.includes("--tz") ? flags[flags.indexOf("--tz") + 1] : undefined;
      const at = flags.includes("--at") ? flags[flags.indexOf("--at") + 1] : undefined;
      const r = await api("/api/voice/dogfood", { method: "POST", body: JSON.stringify({ ...(tz ? { timezone: tz } : {}), ...(at ? { timeOfDay: at } : {}) }) }).catch(fail);
      console.log(`${r.created ? "created" : r.updated ? "prompt updated" : "already present"}: ${r.name} (${r.triggerId}) ${r.enabled ? "enabled" : "disabled"}, ${r.nextSummary ?? ""}`);
      if (r.via) console.log(`on the voice hub ${r.via.name} (${r.via.node}); this node's own agents server was not touched`);
      if (r.via) console.log(`on the voice hub ${r.via.name} (${r.via.node}); this node's own agents server was not touched`);
      if (r.lastFiredAt) console.log(`last fired: ${when(r.lastFiredAt)}`);
      if (r.lastError) console.log(`last error: ${r.lastError}`);
    } else if (sub === "digest") {
      // Weekly fleet digest document: signing identity + publish grant + schedule trigger. --tz <zone> --at HH:MM --day 0-6 (Sunday = 0; default Monday 08:00 Europe/Madrid).
      const tz = flags.includes("--tz") ? flags[flags.indexOf("--tz") + 1] : undefined;
      const at = flags.includes("--at") ? flags[flags.indexOf("--at") + 1] : undefined;
      const day = flags.includes("--day") ? Number(flags[flags.indexOf("--day") + 1]) : undefined;
      const r = await api("/api/voice/digest", { method: "POST", body: JSON.stringify({ ...(tz ? { timezone: tz } : {}), ...(at ? { timeOfDay: at } : {}), ...(day !== undefined ? { dayOfWeek: day } : {}) }) }).catch(fail);
      console.log(`${r.created ? "created" : r.updated ? "prompt updated" : "already present"}: ${r.name} (${r.triggerId}) ${r.enabled ? "enabled" : "disabled"}, ${r.nextSummary ?? ""}`);
      console.log(`publishes as: ${r.account ?? "?"} (${r.identityCreated ? "new signing identity" : "existing signing identity"} ${r.signer ?? "?"}, ${r.granted ? "granted to the agent now" : "already granted"}); documents at ${r.url ?? "?"}`);
      if (r.lastFiredAt) console.log(`last fired: ${when(r.lastFiredAt)}`);
      if (r.lastError) console.log(`last error: ${r.lastError}`);
    } else if (sub === "runwatch") {
      // Run-completed trigger: the voice agent announces finished harness runs on the Desk transcript.
      const r = await api("/api/voice/runwatch", { method: "POST" }).catch(fail);
      console.log(`${r.created ? "created" : r.updated ? "updated" : "already present"}: ${r.name} (${r.triggerId}) ${r.enabled ? "enabled" : "disabled"}, ${r.nextSummary ?? ""} (${r.headless ? "headless announce call" : "thread from the prompt"})`);
      if (r.via) console.log(`on the voice hub ${r.via.name} (${r.via.node}); this node's own agents server was not touched`);
      if (r.lastFiredAt) console.log(`last fired: ${when(r.lastFiredAt)}`);
      if (r.lastError) console.log(`last error: ${r.lastError}`);
    } else if (sub === "prompt") {
      // The agent's system prompt vs the fleet persona Cyberdeck ships; --apply writes the persona.
      const r = await api("/api/voice/prompt", flags.includes("--apply") ? { method: "POST" } : {}).catch(fail);
      console.log(`agent: ${r.name ?? "?"} (${r.agentId})`);
      if (r.via) console.log(`on the voice hub ${r.via.name} (${r.via.node})`);
      if (r.applied) console.log("prompt: fleet persona applied (the next session uses it; `cyberdeck seed reset-session` starts one)");
      else if (!r.changed) console.log("prompt: already the fleet persona");
      else { console.log("prompt: differs from the fleet persona; run `cyberdeck seed prompt --apply` to replace it. Current:"); console.log(r.current.trim() ? r.current : "(empty)"); }
    } else if (sub === "transcript") {
      const r = await api(`/api/voice/transcript?limit=${encodeURIComponent(flags[0] ?? "20")}`).catch(fail);
      for (const m of r.messages ?? []) console.log(`[${new Date(m.at).toLocaleTimeString()}] ${m.role}: ${m.text}`);
      if (!r.messages?.length) console.log("(no messages)");
      for (const x of r.notices ?? []) console.log(`[${new Date(x.at).toLocaleTimeString()}] notice: ${x.text}`);
    } else {
      console.log("usage: cyberdeck seed [--profile <name>] profiles | status | setup [--new] [--no-adopt] [--name <agent>] | sync [--voice] [--force] | prompt-text | keygen [--force] | login [--code <url>|--status] | providers | reset-session | call | transcript [n] | dogfood [--tz <zone>] [--at HH:MM] | digest [--tz <zone>] [--at HH:MM] [--day 0-6] | runwatch | prompt [--apply]");
      process.exit(1);
    }
    break;
  }
  case "whoami": {
    const res = await fetch(`${BASE}/api/auth/whoami`, { headers: { authorization: `Bearer ${token()}` } });
    console.log(JSON.stringify(await res.json()));
    break;
  }
  default:
    console.log(`cyberdeck — fleet-and-data guardian

usage: cyberdeck <command>

  status     daemon health and data summary
  open       open the web UI (authenticated)
  scan       trigger a rescan now
  restart    restart the daemon service
  stop/start manage the daemon service
  logs       tail daemon logs
  update     pull own source, rebuild, restart
  serve      expose the UI as https://<node>.<tailnet> via tailscale serve (serve off: stop)
  serve mcp  publish only /api/mcp to the internet on :8443 via tailscale funnel, for agent.hm (serve mcp off: stop)
  mcp        connection details for MCP clients such as Seed Agents (--json)
  seed       Seed agents bridge [--profile <name>]: profiles | status | setup | sync [--voice] | keygen | login | providers | reset-session | call | transcript | dogfood | runwatch | prompt [--apply]
  whoami     how the local daemon sees this caller`);
}
