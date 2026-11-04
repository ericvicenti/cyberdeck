// Which address a browser should join a LiveKit call server at. The hub hands out `url` (its tailnet address),
// `secureUrl` (the wss:// twin an https page needs) and, since 2026-11-02, `lanUrl`: the same server on the hub's
// LAN address, for a caller on the same network that is not on the tailnet (yacht after Tailscale was removed).
// Shared by the Desk (ui/lib/voice.ts) and the tests; no DOM here.

/** The grant fields that name the call server (the rest of `POST /api/voice/livekit` is the token and the room). */
export type CallUrls = { url: string; secureUrl?: string; lanUrl?: string; tailnetUrl?: string };

/** `ws://` or `wss://` on a private IPv4 (RFC 1918), i.e. a LAN address and not the tailnet's 100.64/10. */
export function isLanAddress(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A page host that says "this browser is on a LAN with the fleet": this machine (localhost, 127/8, ::1) or a
 *  private LAN address. Such a page reaches the hub's LAN address directly, and may not be on the tailnet at all. */
export function isLocalPageHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h) || isLanAddress(h);
}

/**
 * The addresses the Desk should try, in order. An https page can only use wss:// (or ws:// to localhost), so it
 * gets `secureUrl` alone when there is one. A plain http page tries `url` then `lanUrl`, or `lanUrl` first when
 * the page itself is served from this machine or a LAN address (`pageHost`; 2026-11-03: yacht's own Desk at
 * 127.0.0.1 has no tailnet, so its first TALK spent 6 s on the tailnet address before joining over the LAN). The
 * address that last worked on this device (`remembered`) goes first so only the first call pays for a dead address.
 * `tailnetUrl` (the address `url` held before `grantForCaller` swapped the LAN one in) is the last resort.
 */
export function callUrlCandidates(grant: CallUrls, protocol: string, remembered?: string | null, pageHost?: string): string[] {
  const https = protocol === "https:";
  const lanFirst = !!pageHost && isLocalPageHost(pageHost);
  const list = https ? [grant.secureUrl ?? grant.url] : lanFirst ? [grant.lanUrl, grant.url, grant.tailnetUrl] : [grant.url, grant.lanUrl, grant.tailnetUrl];
  const out: string[] = [];
  for (const u of list) if (u && !out.includes(u)) out.push(u);
  if (remembered && out.includes(remembered)) return [remembered, ...out.filter((u) => u !== remembered)];
  return out;
}

/** How long the first of several candidates gets to open its signalling socket (an unroutable tailnet address
 *  otherwise costs the SDK's 15 s before the LAN address is tried). */
export const FIRST_CANDIDATE_MS = 6_000;

/** Both IPv4 addresses are on the same /24: the one LAN a home router hands out, without guessing the netmask. */
export function sameSubnet(a: string, b: string): boolean {
  const pa = a.split("."), pb = b.split(".");
  return pa.length === 4 && pb.length === 4 && pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}

/**
 * The grant as a caller on the hub's own LAN should read it: `url` becomes `lanUrl` and the tailnet address moves to
 * `tailnetUrl`. The Desk already tries every candidate, but the Casework iPad app (and any client that reads `url`
 * alone) joins `url` or nothing, and until 2026-11-04 `url` was always the hub's tailnet address, so an iPad paired on
 * home Wi-Fi without Tailscale got no media. Only a caller whose address is on the same /24 as `lanUrl` is swapped
 * (`clientIp` is the daemon's view of the connection: the iPad itself, or 127.0.0.1 for a Desk on this machine, which
 * is left alone and keeps its own LAN-first order); a tailnet or loopback caller gets the grant unchanged.
 */
export function grantForCaller<T extends CallUrls>(grant: T, clientIp: string | null | undefined): T {
  if (!grant.lanUrl || !clientIp || grant.lanUrl === grant.url || !isLanAddress(clientIp)) return grant;
  let host: string;
  try { host = new URL(grant.lanUrl).hostname; } catch { return grant; }
  if (!sameSubnet(host, clientIp)) return grant;
  return { ...grant, url: grant.lanUrl, tailnetUrl: grant.url };
}
