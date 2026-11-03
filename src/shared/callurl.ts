// Which address a browser should join a LiveKit call server at. The hub hands out `url` (its tailnet address),
// `secureUrl` (the wss:// twin an https page needs) and, since 2026-11-02, `lanUrl`: the same server on the hub's
// LAN address, for a caller on the same network that is not on the tailnet (yacht after Tailscale was removed).
// Shared by the Desk (ui/lib/voice.ts) and the tests; no DOM here.

/** The grant fields that name the call server (the rest of `POST /api/voice/livekit` is the token and the room). */
export type CallUrls = { url: string; secureUrl?: string; lanUrl?: string };

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
 */
export function callUrlCandidates(grant: CallUrls, protocol: string, remembered?: string | null, pageHost?: string): string[] {
  const https = protocol === "https:";
  const lanFirst = !!pageHost && isLocalPageHost(pageHost);
  const list = https ? [grant.secureUrl ?? grant.url] : lanFirst ? [grant.lanUrl, grant.url] : [grant.url, grant.lanUrl];
  const out: string[] = [];
  for (const u of list) if (u && !out.includes(u)) out.push(u);
  if (remembered && out.includes(remembered)) return [remembered, ...out.filter((u) => u !== remembered)];
  return out;
}

/** How long the first of several candidates gets to open its signalling socket (an unroutable tailnet address
 *  otherwise costs the SDK's 15 s before the LAN address is tried). */
export const FIRST_CANDIDATE_MS = 6_000;
