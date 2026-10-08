// One-shot calls into the official Codex app-server (`codex app-server`, JSON-RPC over
// stdio, one message per line). Cyberdeck uses it for the things that should go through
// Codex's own client rather than a raw HTTP call: reading the rate-limit reset credits
// and consuming one. The process is started per call set and killed when the last
// answer arrives; it signs in with whatever `codex` on this node is signed in with.
import { loginShell } from "./sessions";

export type CodexResetCredit = { id: string; title: string; description: string | null; status: string; grantedAt: number | null; expiresAt: number | null };
export type CodexResets = { available: number; credits: CodexResetCredit[] };
export type CodexResetOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" | "unknown";

/** argv for the app-server. CYBERDECK_CODEX_APP_SERVER (a JSON array) replaces it in tests. */
function appServerArgv(): string[] {
  const override = process.env.CYBERDECK_CODEX_APP_SERVER;
  if (override) {
    try { const a = JSON.parse(override); if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string")) return a; } catch {}
  }
  // through the login shell so `codex` resolves the same way it does for sessions
  return [loginShell(), "-ilc", "exec codex app-server"];
}

/** Run `initialize`, then one request; resolve with its result or reject with its error. */
export async function codexRequest<T = any>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
  const proc = Bun.spawn(appServerArgv(), { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env } });
  const send = (o: unknown) => { proc.stdin.write(JSON.stringify(o) + "\n"); proc.stdin.flush(); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      const fail = (e: any) => reject(new Error(typeof e?.message === "string" ? e.message : `codex ${method} failed`));
      (async () => {
        const dec = new TextDecoder();
        let buf = "";
        const reader = proc.stdout.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("{")) continue; // shell rc noise
            let msg: any;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id === 1) {
              if (msg.error) return fail(msg.error);
              send({ method: "initialized" });
              send(params === undefined ? { id: 2, method } : { id: 2, method, params });
            } else if (msg.id === 2) {
              return msg.error ? fail(msg.error) : resolve(msg.result as T);
            }
          }
        }
        reject(new Error("codex app-server exited before answering (is codex installed and signed in on this node?)"));
      })().catch(reject);
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "cyberdeck", title: "Cyberdeck", version: "1" } } });
    });
  } finally {
    clearTimeout(timer);
    try { proc.kill(); } catch {}
  }
}

/** `account/rateLimits/read` -> the reset credits this account holds. */
export function normalizeCodexResets(result: any): CodexResets {
  const rc = result?.rateLimitResetCredits ?? null;
  const credits: CodexResetCredit[] = (Array.isArray(rc?.credits) ? rc.credits : [])
    .filter((c: any) => c && typeof c.id === "string")
    .map((c: any) => ({
      id: c.id,
      title: typeof c.title === "string" && c.title ? c.title : "Rate limit reset",
      description: typeof c.description === "string" ? c.description : null,
      status: String(c.status ?? "unknown"),
      grantedAt: Number.isFinite(c.grantedAt) ? c.grantedAt * 1000 : null,
      expiresAt: Number.isFinite(c.expiresAt) ? c.expiresAt * 1000 : null,
    }))
    // soonest to expire first: that is the one worth spending
    .sort((a: CodexResetCredit, b: CodexResetCredit) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  const usable = credits.filter((c) => c.status === "available");
  return { available: Number.isFinite(rc?.availableCount) ? rc.availableCount : usable.length, credits: usable };
}

export const readCodexResets = async (): Promise<CodexResets> => normalizeCodexResets(await codexRequest("account/rateLimits/read"));

/** Spend one reset credit. `idempotencyKey` makes a retry of the same click safe. */
export async function consumeCodexReset(idempotencyKey: string, creditId?: string): Promise<CodexResetOutcome> {
  const r = await codexRequest<{ outcome?: string }>("account/rateLimitResetCredit/consume", creditId ? { idempotencyKey, creditId } : { idempotencyKey }, 45_000);
  const o = String(r?.outcome ?? "");
  return o === "reset" || o === "nothingToReset" || o === "noCredit" || o === "alreadyRedeemed" ? o : "unknown";
}
