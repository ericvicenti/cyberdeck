import { useEffect, useMemo, useRef, useState } from "react";
import { seedAgentsRouteToPath, type SeedAgentsHost, type SeedAgentsRoute } from "@seed-hypermedia/agents-ui";

const serverKey = (value: string) => value.replace(/\/+$/, "");

/** Observe the Seed view's existing content read. Metadata alone cannot establish
 * that a file's contents are readable. The versioned dependency patch supplies
 * this optional callback; it neither signs nor fetches an extra request. */
export function useSeedReadOutcome(host: SeedAgentsHost | null, route: SeedAgentsRoute) {
  const path = seedAgentsRouteToPath(route);
  const current = useRef({ host, route, path });
  const mounted = useRef(true);
  current.current = { host, route, path };
  const [result, setResult] = useState<{ host: SeedAgentsHost; path: string; title?: string }>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const observed = useMemo(() => host && ({
    ...host,
    onReadOutcome: outcome => {
      const owner = current.current;
      if (!mounted.current || owner.host !== host || owner.route.key !== "agent" ||
        owner.route.agentId !== outcome.agentId || owner.route.memoryPath !== outcome.path ||
        host.signer?.accountUid !== outcome.accountUid ||
        serverKey(owner.route.serverUrl || host.serverUrl) !== serverKey(outcome.serverUrl)) return;
      const status = (outcome.error as { status?: number })?.status;
      const title = outcome.error
        ? `Memory file ${status === 401 || status === 403 ? "access denied" : status === 404 ? "not found" : "unavailable"} · Seed`
        : undefined;
      setResult(previous => previous?.host === host && previous.path === owner.path && previous.title === title
        ? previous : { host, path: owner.path, title });
    },
  } satisfies SeedAgentsHost), [host]);
  return { host: observed, title: result?.host === host && result.path === path ? result.title : undefined };
}
