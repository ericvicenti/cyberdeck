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
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

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
  whoami     how the local daemon sees this caller`);
}
