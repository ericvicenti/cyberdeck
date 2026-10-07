#!/usr/bin/env bun
// cyberdeck CLI — talks to the local daemon and manages the service.
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { CYBERDECK_HOME, loadConfig } from "../daemon/config";
import { tailscaleBin, Tailscale } from "../daemon/tailscale";

const cfg = loadConfig();
const BASE = `http://127.0.0.1:${cfg.port}`;
const SRC = join(CYBERDECK_HOME, "src");
const cmd = process.argv[2] ?? "help";

function token(): string {
  const p = join(CYBERDECK_HOME, "token");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
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
    const code = await sh([bin, "serve", "--bg", "--https=443", `http://127.0.0.1:${cfg.port}`]);
    if (code !== 0) process.exit(code);
    const self = await new Tailscale().self();
    console.log(self ? `serving https://${self.dnsName}` : "serving (run `tailscale status` for the hostname)");
    break;
  }
  case "mcp": {
    // Connection details for an MCP client (Seed Agents: Tools tab -> Add server).
    const self = await new Tailscale().self().catch(() => null);
    const urls = [`${BASE}/api/mcp`];
    if (self?.dnsName) urls.push(`https://${self.dnsName}/api/mcp (tailnet, needs \`cyberdeck serve\`)`);
    if (process.argv[3] === "--json") { console.log(JSON.stringify({ urls: [urls[0], ...(self?.dnsName ? [`https://${self.dnsName}/api/mcp`] : [])], headers: { Authorization: `Bearer ${token()}` }, transport: "http" })); break; }
    console.log(`Cyberdeck MCP server (Streamable HTTP, stateless)\n`);
    for (const u of urls) console.log(`  url:        ${u}`);
    console.log(`  header:     Authorization: Bearer ${token()}`);
    console.log(`  transport:  http\n\nIn Seed Agents: Tools tab -> MCP servers -> Add server, paste the url and the header; name it "cyberdeck".\nSee docs/AGENTS.md for reachability (a hosted agents server needs a public route to this node).`);
    break;
  }
  case "seed": {
    // Seed agents bridge (voice): all through the daemon's /api/voice/* routes (docs/VOICE.md).
    const sub = process.argv[3] ?? "status";
    const flags = process.argv.slice(4);
    const fail = (e: unknown) => { console.log(`seed ${sub} failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); };
    if (sub === "status") {
      const s = await api("/api/voice/status").catch(fail);
      console.log(`agents server: ${s.agentsUrl}  (${s.health?.ok ? `up${s.health.voice ? ", voice" : ", NO voice"}${s.health.version ? `, ${s.health.version}` : ""}` : `down: ${s.health?.error ?? "?"}`})`);
      console.log(`identity:      ${s.identity.name} ${s.identity.available ? `-> ${s.identity.principal}` : `(unavailable: ${s.identity.error ?? "?"})`}`);
      console.log(`agent:         ${s.agent ? `${s.agent.name ?? "?"} (${s.agent.id})` : "not set up"}`);
      console.log(`session:       ${s.sessionId ?? "none"}`);
      console.log(`mcp registered: ${when(s.mcpRegisteredAt)}   last call: ${when(s.lastCallAt)}`);
      if (s.dogfood) console.log(`dogfood:       ${s.dogfood.name} (${s.dogfood.triggerId}) ${s.dogfood.enabled ? "enabled" : "disabled"}, ${s.dogfood.nextSummary ?? ""}; last fired ${when(s.dogfood.lastFiredAt)}${s.dogfood.lastError ? `; last error: ${s.dogfood.lastError}` : ""}`);
      console.log(s.configured ? "voice: ready (provider livekit)" : `voice: not configured — ${s.reason}`);
      if (!s.configured) process.exit(1);
    } else if (sub === "setup") {
      const name = flags.includes("--name") ? flags[flags.indexOf("--name") + 1] : undefined;
      const r = await api("/api/voice/setup", { method: "POST", body: JSON.stringify({ new: flags.includes("--new"), adopt: !flags.includes("--no-adopt"), ...(name ? { name } : {}) }) }).catch(fail);
      console.log(`agent:   ${r.agent.name ?? "?"} (${r.agent.id}) — ${r.agent.origin}`);
      console.log(`session: ${r.sessionId}`);
      console.log(`mcp:     ${r.mcp.name} -> ${r.mcp.url} (${r.mcp.state ?? "unknown"}${typeof r.mcp.tools === "number" ? `, ${r.mcp.tools} tools` : ""}${r.mcp.error ? `: ${r.mcp.error}` : ""})`);
      for (const w of r.warnings ?? []) console.log(`warning: ${w}`);
    } else if (sub === "reset-session") {
      const r = await api("/api/voice/session/reset", { method: "POST" }).catch(fail);
      console.log(`new session: ${r.sessionId}${r.previous ? ` (was ${r.previous})` : ""}`);
    } else if (sub === "call") {
      // Smoke test: mint a LiveKit room without joining it (the token is withheld; the room times out on the worker).
      const r = await api("/api/voice/livekit", { method: "POST" }).catch(fail);
      const { token: _t, ...rest } = r;
      console.log(JSON.stringify({ ...rest, token: "<withheld>", expiresIn: `${Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000))}s` }, null, 2));
    } else if (sub === "dogfood") {
      // Daily fleet check-in trigger on the agent: --tz <IANA zone> --at HH:MM (defaults Europe/Madrid 07:00).
      const tz = flags.includes("--tz") ? flags[flags.indexOf("--tz") + 1] : undefined;
      const at = flags.includes("--at") ? flags[flags.indexOf("--at") + 1] : undefined;
      const r = await api("/api/voice/dogfood", { method: "POST", body: JSON.stringify({ ...(tz ? { timezone: tz } : {}), ...(at ? { timeOfDay: at } : {}) }) }).catch(fail);
      console.log(`${r.created ? "created" : "already present"}: ${r.name} (${r.triggerId}) ${r.enabled ? "enabled" : "disabled"}, ${r.nextSummary ?? ""}`);
      if (r.lastFiredAt) console.log(`last fired: ${when(r.lastFiredAt)}`);
      if (r.lastError) console.log(`last error: ${r.lastError}`);
    } else if (sub === "transcript") {
      const r = await api(`/api/voice/transcript?limit=${encodeURIComponent(flags[0] ?? "20")}`).catch(fail);
      for (const m of r.messages ?? []) console.log(`[${new Date(m.at).toLocaleTimeString()}] ${m.role}: ${m.text}`);
      if (!r.messages?.length) console.log("(no messages)");
    } else {
      console.log("usage: cyberdeck seed status | setup [--new] [--no-adopt] [--name <agent>] | reset-session | call | transcript [n] | dogfood [--tz <zone>] [--at HH:MM]");
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
  mcp        connection details for MCP clients such as Seed Agents (--json)
  seed       voice bridge to the Seed agents server: status | setup [--new] | reset-session | call | transcript | dogfood
  whoami     how the local daemon sees this caller`);
}
