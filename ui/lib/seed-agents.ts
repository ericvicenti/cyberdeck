// Host side of Seed's agents UI (@seed-hypermedia/agents-ui): which account signs, and how. The key
// never reaches the browser: the daemon signs agent-action envelopes for its own Seed identity
// (POST /api/seed-agents/sign), and every request to the agents server goes through the daemon's
// same-origin proxy, opened by the cookie GET /api/seed-agents/session sets. See src/daemon/api/seed-agents.ts.
import { useEffect, useState } from "react";
import type { SeedAgentsHost, SeedAgentsRoute } from "@seed-hypermedia/agents-ui";
import { api, navigate, post } from "./api";

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

/** The agents UI host for this node, or why there is none. Always the local daemon: the proxy and key live there. */
export function useSeedAgentsHost(): { host: SeedAgentsHost | null; session: SeedAgentsSession | null; error: string | null; retry: () => void } {
  const [session, setSession] = useState<SeedAgentsSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [host, setHost] = useState<SeedAgentsHost | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    api<SeedAgentsSession>("/api/seed-agents/session", { local: true })
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
                sign: async (data) => fromBase64((await post<{ sig: string }>("/api/seed-agents/sign", { data: toBase64(data) })).sig),
              }
            : null,
        });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [attempt]);
  return { host, session, error, retry: () => setAttempt((n) => n + 1) };
}

/** The Seed view's hash URL for a route: `#/seed?r=<path>`, where path is Seed's own `/hm/agents/<path>`. */
export function seedHash(path: string): string {
  return `#/seed${path ? `?r=${encodeURIComponent(path)}` : ""}`;
}

export function openSeedRoute(path: string): void {
  navigate("seed", path ? { r: path } : {});
}

export type { SeedAgentsRoute };
