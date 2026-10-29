// Tailscale integration: who is on the other end of a connection, and who we are.
//
// Requests arriving from the tailnet (100.64.0.0/10 or fd7a:115c:a1e0::/48) are
// identified with `tailscale whois`; when the login matches the node owner the
// request is trusted without a bearer token. Everything shells out to the
// tailscale CLI, so the daemon needs no API keys.
import { existsSync } from "fs";

export type Identity = { login: string; node: string };
export type SelfInfo = { dnsName: string; login: string | null; ip4: string | null };
/** This node's own tailnet connection, from `tailscale status --json` `BackendState`: `Running` means on the tailnet;
 *  `Stopped` (`tailscale down`, or the menu switch off) and `NeedsLogin` (logged out, key expired) mean off it. */
export type TailnetState = {
  running: boolean;
  /** `Running` | `Stopped` | `NeedsLogin` | `NoState` | `Starting` | … (tailscale's own words). */
  state: string;
  /** Where a `NeedsLogin` node gets back on: shown only on the machine itself (the CLI), never over HTTP. */
  authUrl: string | null;
};
/** What `tailscale funnel` publishes to the public internet for 127.0.0.1:`port` (see `Tailscale.funnel`). */
export type FunnelInfo = {
  /** The public `https://<node>.<tailnet>:8443/api/mcp` url when only the MCP path is funneled, else null. */
  mcpUrl: string | null;
  /** The public origin when the node's whole UI (`/`) is funneled: a misconfiguration worth shouting about. */
  rootPublic: string | null;
};
/** The port `cyberdeck serve mcp` publishes on: 443 stays the tailnet-only UI, funnel ports are limited to 443/8443/10000. */
/** The voice hub's LiveKit signalling port and its TLS twin: `cyberdeck serve` on the hub maps
 *  `https://<hub>.<tailnet>:7443` -> `http://127.0.0.1:7880` so an https Desk can open `wss://` (docs/VOICE.md). */
export const LIVEKIT_PORT = 7880;
export const LIVEKIT_TLS_PORT = 7443;
/** The `tailscale serve` mapping the voice hub needs for its call server, from this node's own `/api/voice/status`:
 *  null when voice is relayed to another node (`via`), not configured here, or unknown (daemon down). */
export function livekitServeTarget(status: { configured?: boolean; via?: unknown } | null | undefined, port = LIVEKIT_PORT): { https: number; target: string } | null {
  if (!status?.configured || status.via) return null;
  const p = Number.isInteger(port) && port! > 0 && port! < 65536 ? port! : LIVEKIT_PORT;
  return { https: LIVEKIT_TLS_PORT, target: `http://127.0.0.1:${p}` };
}
export const MCP_FUNNEL_PORT = 8443;
export const MCP_PATH = "/api/mcp";
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
/** The backend state is asked only after a peer failed to answer, and then at most this often. */
const BACKEND_TTL = 10 * 1000;

/** Pure half of `Tailscale.backend`: `out` is the stdout of `tailscale status --json` (null when tailscale is absent). */
export function parseBackend(out: string | null): TailnetState | null {
  if (!out) return null;
  let j: any;
  try { j = JSON.parse(out); } catch { return null; }
  const state = String(j?.BackendState ?? "");
  if (!state) return null;
  const authUrl = typeof j?.AuthURL === "string" && j.AuthURL ? j.AuthURL : null;
  return { running: state === "Running", state, authUrl };
}

export class Tailscale {
  private whoisCache = new Map<string, { at: number; id: Identity | null }>();
  private selfCache: { at: number; info: SelfInfo | null } | null = null;
  private serveCache = new Map<number, { at: number; origin: string | null }>();
  private funnelCache = new Map<number, { at: number; info: FunnelInfo }>();
  private backendCache: { at: number; state: TailnetState | null } | null = null;
  constructor(private run: Runner = defaultRunner) {}

  /** Whether this node is on the tailnet right now (null when tailscale is absent). Cheap to ask repeatedly. */
  async backend(): Promise<TailnetState | null> {
    if (this.backendCache && Date.now() - this.backendCache.at < BACKEND_TTL) return this.backendCache.state;
    let state: TailnetState | null = null;
    try { state = parseBackend(await this.run(["status", "--json"])); } catch {}
    this.backendCache = { at: Date.now(), state };
    return state;
  }

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

  /**
   * Public (Funnel) exposure of 127.0.0.1:`port`, from `tailscale serve status --json` (`AllowFunnel` lists the
   * host:port pairs open to the internet; `Web[host:port].Handlers[path].Proxy` says where each path goes).
   * Funnel is per port, so the MCP route gets its own port with a single handler mounted at `/api/mcp` whose
   * proxy target carries the path too (`--set-path /api/mcp http://127.0.0.1:<port>/api/mcp`: serve strips the
   * mount prefix before proxying). `rootPublic` flags a port whose `/` handler leads to the node, i.e. the
   * entire UI and API published, which `cyberdeck serve` and `cyberdeck mcp` warn about.
   */
  async funnel(port: number): Promise<FunnelInfo> {
    const hit = this.funnelCache.get(port);
    if (hit && Date.now() - hit.at < SELF_TTL) return hit.info;
    const info = parseFunnel(await this.run(["serve", "status", "--json"]).catch(() => null), port);
    this.funnelCache.set(port, { at: Date.now(), info });
    return info;
  }
}

const toNode = (port: number, path = "") => new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}${path.replace(/\//g, "\\/")}/?$`);

/** Pure half of `Tailscale.funnel`: `out` is the stdout of `tailscale serve status --json` (null when tailscale is absent). */
export function parseFunnel(out: string | null, port: number): FunnelInfo {
  const info: FunnelInfo = { mcpUrl: null, rootPublic: null };
  if (!out) return info;
  let j: any;
  try { j = JSON.parse(out); } catch { return info; }
  const allow = j?.AllowFunnel ?? {};
  const web = j?.Web ?? {};
  for (const [hostPort, on] of Object.entries<any>(allow)) {
    if (!on) continue;
    const handlers = web?.[hostPort]?.Handlers ?? {};
    const origin = `https://${hostPort.replace(/:443$/, "")}`;
    const rootProxy = String(handlers?.["/"]?.Proxy ?? "");
    if (toNode(port).test(rootProxy)) { info.rootPublic ??= origin; continue; }
    const mcpProxy = String(handlers?.[MCP_PATH]?.Proxy ?? "");
    if (toNode(port, MCP_PATH).test(mcpProxy) && Object.keys(handlers).length === 1) info.mcpUrl ??= `${origin}${MCP_PATH}`;
  }
  return info;
}
