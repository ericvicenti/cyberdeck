import { probeSshArgs } from "./probe";
// Service control for the MCP tools `service_logs` and `services_restart`: read a fleet service's
// recent logs or restart it, on whichever host runs it. Only services the fleet manifest lists for
// that host (`deck hosts --json` → `services`) are reachable, with the fixed commands from
// src/shared/services.ts (names quoted, sudo never prompts). The command runs through `bash -s`
// here when the host is this machine, otherwise over `ssh -o BatchMode=yes <alias>` like `deck` does.
// Restarts are bounded (two attempts, state re-checked after each), rate-limited per service, and
// every one leaves a JSON line in ~/.cyberdeck/audit.log (CYBERDECK_AUDIT_LOG overrides).
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { CYBERDECK_HOME } from "./config";
import { serviceLogCmd, serviceRestartCmd, serviceStateCmd, stateOk } from "../shared/services";

export type ManifestHost = { name: string; ssh?: string | null; services?: { name: string; type: string }[] };
export type ServiceTarget = { host: string; service: string; type: string; local: boolean; ssh: string | null };
export type ExecResult = { code: number; out: string };

const OUTPUT_CAP = 16_000;
const RESTART_WINDOW_MS = 30 * 60_000;
const RESTARTS_PER_WINDOW = 3;
const restarts = new Map<string, number[]>();

/** `ssh` unless tests swap in a stub (CYBERDECK_SSH). */
const sshBin = () => process.env.CYBERDECK_SSH || "ssh";

/** Find a manifest service on a host. Host and service match case-insensitively; returns a reason when refused. */
export function resolveService(hosts: ManifestHost[], me: string, host: string, name: string): ServiceTarget | { error: string } {
  const h = hosts.find((x) => x.name.toLowerCase() === host.toLowerCase());
  if (!h) return { error: `No host "${host}" in the fleet manifest. Hosts: ${hosts.map((x) => x.name).join(", ") || "none"}.` };
  const svc = (h.services ?? []).find((s) => s.name.toLowerCase() === name.toLowerCase() && s.type !== "http") ?? (h.services ?? []).find((s) => s.name.toLowerCase() === name.toLowerCase());
  const listed = (h.services ?? []).filter((s) => s.type !== "http").map((s) => s.name);
  if (!svc) return { error: `${h.name} has no service "${name}" in the fleet manifest. Its services: ${listed.join(", ") || "none"}.` };
  if (!serviceStateCmd({ service: svc.name, type: svc.type })) return { error: `${svc.name} on ${h.name} is an ${svc.type} probe; it has no logs and cannot be restarted.` };
  const local = h.name.toLowerCase() === me.toLowerCase();
  if (!local && !h.ssh) return { error: `${h.name} has no ssh alias in the fleet manifest, so it cannot be reached from here.` };
  return { host: h.name, service: svc.name, type: svc.type, local, ssh: h.ssh ?? null };
}

/** Run a script on the target's host (stdin to `bash -s`), output capped from the end. */
export async function execOn(t: Pick<ServiceTarget, "local" | "ssh"> & { host?: string }, script: string, timeoutMs = 30_000): Promise<ExecResult> {
  const route = !t.local && !process.env.CYBERDECK_SSH ? probeSshArgs(t.host ?? t.ssh!) : null;
  const argv = t.local ? ["bash", "-s"] : [sshBin(), ...(route ?? ["-o", "ConnectTimeout=6", "-o", "BatchMode=yes", t.ssh!]), "bash", "-s"];
  const p = Bun.spawn(argv, { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  const all = (out + (err ? (out ? "\n" : "") + err : "")).trimEnd();
  return { code: await p.exited, out: all.length > OUTPUT_CAP ? "…" + all.slice(-OUTPUT_CAP) : all };
}

export async function serviceLogs(t: ServiceTarget, lines: number): Promise<{ host: string; service: string; type: string; lines: number; ok: boolean; output: string }> {
  const r = await execOn(t, serviceLogCmd(t, { lines })! + "\n");
  return { host: t.host, service: t.service, type: t.type, lines, ok: r.code === 0, output: r.out };
}

/** Restart attempts left for a service in the current window. */
export function restartBudget(t: Pick<ServiceTarget, "host" | "service">, now = Date.now()): number {
  const key = `${t.host}/${t.service}`.toLowerCase();
  const recent = (restarts.get(key) ?? []).filter((at) => now - at < RESTART_WINDOW_MS);
  restarts.set(key, recent);
  return RESTARTS_PER_WINDOW - recent.length;
}

export type RestartResult = { host: string; service: string; type: string; ok: boolean; state: string; attempts: number; before: string; output: string };

export async function restartService(t: ServiceTarget, by: string): Promise<RestartResult> {
  const key = `${t.host}/${t.service}`.toLowerCase();
  restarts.set(key, [...(restarts.get(key) ?? []), Date.now()]);
  const stateScript = serviceStateCmd(t)! + "\n";
  const before = (await execOn(t, stateScript, 20_000)).out.trim().split("\n").pop() ?? "unknown";
  let attempts = 0, state = before, output = "";
  while (attempts < 2) {
    attempts++;
    const r = await execOn(t, serviceRestartCmd(t)! + "\n", 60_000);
    output = r.out;
    await Bun.sleep(Number(process.env.CYBERDECK_SERVICECTL_SETTLE_MS ?? 3000));
    state = (await execOn(t, stateScript, 20_000)).out.trim().split("\n").pop() ?? "unknown";
    if (stateOk(state)) break;
  }
  const result = { host: t.host, service: t.service, type: t.type, ok: stateOk(state), state, attempts, before, output };
  audit({ at: new Date().toISOString(), action: "service-restart", by, host: t.host, service: t.service, type: t.type, before, state, attempts, ok: result.ok });
  return result;
}

export function audit(entry: Record<string, unknown>) {
  const line = JSON.stringify(entry);
  console.log(`audit: ${line}`);
  try {
    const path = process.env.CYBERDECK_AUDIT_LOG ?? join(CYBERDECK_HOME, "audit.log");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n");
  } catch (err) {
    console.error("audit log write failed:", err);
  }
}
