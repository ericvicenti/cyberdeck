// Host side of Seed's agents UI (@seed-hypermedia/agents-ui): which account signs, and how. The key
// never reaches the browser: the daemon signs agent-action envelopes for its own Seed identity
// (POST /api/seed-agents/sign), and every request to the agents server goes through the daemon's
// same-origin proxy, opened by the cookie GET /api/seed-agents/session sets. See src/daemon/api/seed-agents.ts.
// The node whose Seed identity is used is always explicit (`node`, "" = the daemon serving the page).
import { useEffect, useState } from "react";
import type { SeedAgentsHost, SeedAgentsRoute } from "@seed-hypermedia/agents-ui";
import { api, navigate } from "./api";
import { routeHash } from "./navigation";

export type SeedAgentsSession = {
  available: boolean;
  accountUid: string | null;
  identity: string;
  agentsUrl: string;
  error?: string;
  reachable: boolean;
  serverPath: string;
  hmPath: string;
};

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The agents UI host for a fixed local or paired node; keys stay on the signing daemon. */
export function useSeedAgentsHost(node = ""): { host: SeedAgentsHost | null; session: SeedAgentsSession | null; error: string | null; retry: () => void } {
  const [session, setSession] = useState<SeedAgentsSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [host, setHost] = useState<SeedAgentsHost | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    setHost(null);
    // These routes are the serving daemon's own (it proxies and signs for a paired node by id).
    const prefix = node ? `/api/seed-agents/nodes/${encodeURIComponent(node)}` : "/api/seed-agents";
    api<SeedAgentsSession>(`${prefix}/session`)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        const origin = location.origin;
        setHost({
          serverUrl: origin + s.serverPath,
          hmApiUrl: origin + s.hmPath,
          gatewayUrl: "https://hyper.media",
          signer: s.available && s.accountUid
            ? {
                accountUid: s.accountUid,
                sign: async (data) => fromBase64((await api<{ sig: string }>(`${prefix}/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: toBase64(data) }) })).sig),
              }
            : null,
        });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [attempt, node]);
  return { host, session, error, retry: () => setAttempt((n) => n + 1) };
}

/** The Seed view's hash URL for a route: `#/seed?r=<path>[&node=<id>]`, where path is Seed's own `/hm/agents/<path>`. */
export function seedHash(path: string, node = ""): string {
  return routeHash("seed", { ...(path ? { r: path } : {}), ...(node ? { node } : {}) });
}

export function openSeedRoute(path: string, node = ""): void {
  navigate("seed", { ...(path ? { r: path } : {}), ...(node ? { node } : {}) });
}

export type { SeedAgentsRoute };
