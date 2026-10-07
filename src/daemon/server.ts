import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { serveStatic } from "hono/bun";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { saveConfigPatch, type CyberdeckConfig } from "./config";
import { getConnInfo } from "hono/bun";
import { Tailscale, isLoopback, isTailscaleIp } from "./tailscale";
import { bus } from "./events";
import { runScan, isScanRunning } from "./indexer/scan";
import { runDataScan, isDataScanRunning } from "./indexer/data";
import type { RepoRow } from "./db";
import { registerFsRoutes } from "./api/fs";
import { createTermHandlers } from "./api/term";
import { registerFleetRoutes } from "./api/fleet";
import { registerMediaRoutes, cleanupHlsCache } from "./api/media";
import { registerControlRoutes } from "./api/control";
import { registerCmuxRoutes } from "./api/cmux";
import { registerMcpRoutes } from "./api/mcp";
import { nodeStatus } from "./status";
import { registerSessionRoutes } from "./api/sessions";
import { registerDashboardRoutes } from "./api/dashboard";
import { registerBrowserRoutes } from "./api/browser";
import { registerCloudRoutes } from "./api/cloud";
import { browsers } from "./browser";
import { CloudArchive } from "./cloud";
import { CYBERDECK_HOME } from "./config";
import { SessionManager } from "./sessions";
import { currentCommit, checkForUpdate, applyUpdate, setUpdateGuard } from "./updater";

const UI_DIST = join(import.meta.dir, "../../dist/ui");
export const VERSION = "0.4.0";

export type AuthInfo = { method: "token" | "tailscale"; login?: string; node?: string };
export type ServerOptions = {
  /** Override peer-address lookup (tests inject tailnet/LAN addresses). Default: Bun's server.requestIP. */
  requestIp?: (c: { req: { raw: Request } }) => string | null;
  tailscale?: Tailscale;
  /** Write a detected owner into config.json (default true; tests turn it off). */
  persistOwner?: boolean;
  /** Start the periodic Cloud AI archive sync (default true; tests turn it off). */
  cloudSync?: boolean;
};

export function createServer(db: Database, cfg: CyberdeckConfig, token: string, nodeId = "stw-dev", opts: ServerOptions = {}) {
  cleanupHlsCache();
  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const app = new Hono();
  const ts = opts.tailscale ?? new Tailscale();

  // Node owner (tailscale login). Detected once when unset and persisted so a
  // later tailscale outage cannot widen access.
  let owner: string | null = cfg.tailscaleOwner ?? null;
  if (!owner) {
    ts.self().then((self) => {
      if (self?.login) {
        owner = cfg.tailscaleOwner = self.login;
        if (opts.persistOwner !== false) try { saveConfigPatch({ tailscaleOwner: owner }); } catch {}
        console.log(`tailscale owner: ${owner}`);
      }
    });
  }

  const peerIp = (c: { req: { raw: Request } }): string | null => {
    if (opts.requestIp) return opts.requestIp(c);
    try { return getConnInfo(c as any).remote.address ?? null; } catch { return null; }
  };
  const tokenOk = (c: { req: { header: (h: string) => string | undefined; query: (k: string) => string | undefined } }) =>
    c.req.header("authorization") === `Bearer ${token}` || c.req.query("token") === token;

  // Who authenticated a given request; filled by the /api/* middleware and read
  // by WebSocket upgrade handlers and the pairing route.
  const authByReq = new WeakMap<Request, AuthInfo>();
  const seenIdentities = new Set<string>();
  const authenticate = async (c: any): Promise<AuthInfo | null> => {
    if (tokenOk(c)) return { method: "token" };
    const ip = peerIp(c);
    if (!ip || !owner) return null;
    // `tailscale serve` (HTTPS front door) proxies from loopback and stamps the
    // verified tailnet identity on the request. Only honored from loopback,
    // where any process could already read the bearer token anyway.
    if (isLoopback(ip)) {
      const login = c.req.header("tailscale-user-login");
      if (!login || login !== owner) return null;
      const node = c.req.header("tailscale-user-name") ?? "";
      const key = `serve:${login}`;
      if (!seenIdentities.has(key)) { seenIdentities.add(key); console.log(`tailscale: trusting ${login} via tailscale serve`); }
      return { method: "tailscale", login, node };
    }
    if (!isTailscaleIp(ip)) return null;
    const id = await ts.whois(ip);
    if (!id || id.login !== owner) return null;
    const key = `${id.login}@${id.node}`;
    if (!seenIdentities.has(key)) { seenIdentities.add(key); console.log(`tailscale: trusting ${id.login} from ${id.node || ip}`); }
    return { method: "tailscale", login: id.login, node: id.node };
  };
  const authedViaTailscale = (c: { req: { raw: Request } }) => authByReq.get(c.req.raw)?.method === "tailscale";

  // Source-address gate: with bind "tailscale" only loopback and tailnet
  // addresses get anything at all, UI included.
  app.use("*", async (c, next) => {
    if (cfg.bind === "tailscale") {
      const ip = peerIp(c);
      if (ip && !isLoopback(ip) && !isTailscaleIp(ip)) return c.json({ error: "forbidden: not on the tailnet" }, 403);
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const auth = await authenticate(c);
    if (auth) authByReq.set(c.req.raw, auth);
    // whoami reports the outcome instead of enforcing it (the UI decides whether to show the token gate).
    if (c.req.path === "/api/auth/whoami") return next();
    // Pairing completion is called by a not-yet-trusted peer: gated by the
    // one-time code, or by the peer being the owner on the tailnet.
    if (c.req.path === "/api/fleet/pairing/complete") return next();
    // HLS segment requests come from <video> without headers; their ids are
    // unguessable (derived from the serving daemon's token). Also allow them
    // through the fleet proxy for remote playback.
    if (c.req.method === "GET" && /^\/api\/(nodes\/[^/]+\/proxy\/)?media\/hls\//.test(c.req.path)) return next();
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/api/auth/whoami", (c) => {
    const a = authByReq.get(c.req.raw);
    return c.json(a ? { method: a.method, ...(a.login ? { login: a.login } : {}), ...(a.node ? { node: a.node } : {}) } : { method: "none" });
  });

  let commitCache = "";
  currentCommit().then((c) => (commitCache = c));

  const status = () => nodeStatus(db, cfg, { version: VERSION, commit: commitCache });
  app.get("/api/status", (c) => c.json(status()));

  // Self-update: ?check=1 reports drift from origin; otherwise pull, rebuild,
  // and restart (the supervisor relaunches us on the new code). Fleet peers
  // call this to keep each other current.
  app.post("/api/system/update", async (c) => {
    if (c.req.query("check")) return c.json(await checkForUpdate());
    if (!cfg.autoUpdate) return c.json({ error: "autoUpdate is disabled on this node" }, 403);
    const check = await checkForUpdate();
    if (check.error) return c.json({ ok: false, detail: check.error }, 502);
    if (check.behind === 0) return c.json({ ok: true, detail: "already up to date", commit: check.commit });
    return c.json(await applyUpdate());
  });

  app.get("/api/data", (c) => {
    const rows = db
      .query("SELECT * FROM data_dirs ORDER BY size_bytes DESC")
      .all() as Record<string, unknown>[];
    return c.json({ roots: cfg.dataRoots, dirs: rows });
  });

  app.get("/api/repos", (c) => {
    const rows = db.query("SELECT * FROM repos ORDER BY path").all() as RepoRow[];
    return c.json(
      rows.map((r) => ({
        ...r,
        remotes: JSON.parse(r.remotes),
        risk_reasons: JSON.parse(r.risk_reasons),
      }))
    );
  });

  app.post("/api/scan", (c) => {
    if (!isScanRunning()) {
      runScan(db, cfg).catch((err) => console.error("scan error:", err));
    }
    if (!isDataScanRunning()) {
      runDataScan(db, cfg).catch((err) => console.error("data scan error:", err));
    }
    return c.json({ started: true });
  });

  registerFsRoutes(app);
  registerMediaRoutes(app, token);
  registerFleetRoutes(app, db, cfg, nodeId, token, upgradeWebSocket, { tailscale: ts, authedViaTailscale });
  const control = registerControlRoutes(app, cfg);
  registerCmuxRoutes(app);
  registerDashboardRoutes(app, db, cfg);
  registerMcpRoutes(app, db, cfg, control, { status, version: VERSION });

  // Live sessions (daemon-owned PTYs). tmux-backed ones survive restarts; a
  // self-update is deferred while plain pty sessions are still running.
  const sessions = new SessionManager(db);
  sessions.recover().catch((err) => console.error("session recovery failed:", err));
  setUpdateGuard(() => { const n = sessions.fragileCount(); return n ? `${n} live session(s) would be killed` : null; });
  registerSessionRoutes(app, sessions, upgradeWebSocket, (c) => Boolean(authByReq.get(c.req.raw)));

  // Remote browser (persistent headless Chromium per profile) + the Cloud AI archive that drives it.
  registerBrowserRoutes(app, browsers, upgradeWebSocket, (c) => Boolean(authByReq.get(c.req.raw)));
  const cloud = new CloudArchive(browsers, cfg.fleetDir ?? join(CYBERDECK_HOME, "cloud-archive"));
  if (opts.cloudSync !== false) cloud.start();
  registerCloudRoutes(app, cloud);

  app.get(
    "/api/term",
    upgradeWebSocket((c) => {
      if (!authByReq.get(c.req.raw)) return {};
      return createTermHandlers(c.req.query("cwd")) as any;
    })
  );

  app.get(
    "/api/events",
    upgradeWebSocket((c) => {
      if (!authByReq.get(c.req.raw)) return {}; // no handlers; socket opens but receives nothing
      let unsub = () => {};
      return {
        onOpen(_ev, ws) {
          unsub = bus.subscribe((event) => ws.send(JSON.stringify(event)));
        },
        onClose() {
          unsub();
        },
      };
    })
  );

  // Hashed assets are immutable; HTML must revalidate so deploys (which
  // replace the asset hashes) never strand a stale index.html in a browser.
  app.use("/*", async (c, next) => {
    await next();
    if (c.req.path.startsWith("/assets/")) {
      c.header("cache-control", "public, max-age=31536000, immutable");
    } else if ((c.res.headers.get("content-type") ?? "").includes("text/html")) {
      c.header("cache-control", "no-cache");
    }
  });
  app.use("/*", serveStatic({ root: UI_DIST }));
  app.get("*", serveStatic({ path: join(UI_DIST, "index.html") }));

  return { fetch: app.fetch, websocket, sessions };
}
