// Tailscale integration: who is on the other end of a connection, and who we are.
//
// Requests arriving from the tailnet (100.64.0.0/10 or fd7a:115c:a1e0::/48) are
// identified with `tailscale whois`; when the login matches the node owner the
// request is trusted without a bearer token. Everything shells out to the
// tailscale CLI, so the daemon needs no API keys.
import { existsSync } from "fs";

export type Identity = { login: string; node: string };
export type SelfInfo = { dnsName: string; login: string | null; ip4: string | null };
/** Runs the tailscale CLI; resolves to stdout, or null when the binary is missing or the command fails. */
export type Runner = (args: string[]) => Promise<string | null>;

const CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

export function tailscaleBin(): string | null {
  return Bun.which("tailscale") ?? CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const stripMapped = (ip: string) => ip.replace(/^::ffff:/i, "");

export function isLoopback(ip: string): boolean {
  const a = stripMapped(ip);
  return a === "::1" || a.startsWith("127.");
}

/** Tailscale CGNAT range 100.64.0.0/10 and the tailnet ULA fd7a:115c:a1e0::/48. */
export function isTailscaleIp(ip: string): boolean {
  const a = stripMapped(ip).toLowerCase();
  const v4 = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return a.startsWith("fd7a:115c:a1e0:");
}

export const defaultRunner: Runner = async (args) => {
  const bin = tailscaleBin();
  if (!bin) return null;
  try {
    const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const t = setTimeout(() => p.kill(), 5000);
    const out = await new Response(p.stdout).text();
    clearTimeout(t);
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
};

const WHOIS_TTL = 5 * 60 * 1000;
const WHOIS_NEGATIVE_TTL = 30 * 1000;
const SELF_TTL = 60 * 1000;

export class Tailscale {
  private whoisCache = new Map<string, { at: number; id: Identity | null }>();
  private selfCache: { at: number; info: SelfInfo | null } | null = null;
  private serveCache = new Map<number, { at: number; origin: string | null }>();
  constructor(private run: Runner = defaultRunner) {}

  /** Identity of the tailnet peer at `ip`, or null if unknown / not a tailnet address. */
  async whois(ip: string): Promise<Identity | null> {
    const key = stripMapped(ip);
    if (!isTailscaleIp(key)) return null;
    const hit = this.whoisCache.get(key);
    if (hit && Date.now() - hit.at < (hit.id ? WHOIS_TTL : WHOIS_NEGATIVE_TTL)) return hit.id;
    let id: Identity | null = null;
    try {
      const out = await this.run(["whois", "--json", key]);
      const j = out ? JSON.parse(out) : null;
      const login = j?.UserProfile?.LoginName;
      if (typeof login === "string" && login) id = { login, node: String(j?.Node?.Name ?? "").replace(/\.$/, "") };
    } catch {}
    this.whoisCache.set(key, { at: Date.now(), id });
    return id;
  }

  /** This node's MagicDNS name, owner login, and tailnet IPv4 (null when tailscale is absent or down). */
  async self(): Promise<SelfInfo | null> {
    if (this.selfCache && Date.now() - this.selfCache.at < SELF_TTL) return this.selfCache.info;
    let info: SelfInfo | null = null;
    try {
      const out = await this.run(["status", "--json"]);
      const j = out ? JSON.parse(out) : null;
      const dnsName = String(j?.Self?.DNSName ?? "").replace(/\.$/, "");
      if (dnsName) {
        const login = j?.User?.[String(j?.Self?.UserID)]?.LoginName ?? j?.CurrentTailnet?.Name ?? null;
        const ip4 = (j?.Self?.TailscaleIPs as string[] | undefined)?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? null;
        info = { dnsName, login: typeof login === "string" ? login : null, ip4 };
      }
    } catch {}
    this.selfCache = { at: Date.now(), info };
    return info;
  }

  /** The https origin `tailscale serve` (`cyberdeck serve`) publishes for 127.0.0.1:`port` at its root, or null. */
  async serveOrigin(port: number): Promise<string | null> {
    const hit = this.serveCache.get(port);
    if (hit && Date.now() - hit.at < SELF_TTL) return hit.origin;
    let origin: string | null = null;
    try {
      const out = await this.run(["serve", "status", "--json"]);
      const web = (out ? JSON.parse(out) : null)?.Web ?? {};
      for (const [hostPort, cfg] of Object.entries<any>(web)) {
        const proxy = String(cfg?.Handlers?.["/"]?.Proxy ?? "");
        if (!new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy)) continue;
        origin = `https://${hostPort.replace(/:443$/, "")}`;
        break;
      }
    } catch {}
    this.serveCache.set(port, { at: Date.now(), origin });
    return origin;
  }
}
