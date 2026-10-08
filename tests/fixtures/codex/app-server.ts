// Stub of `codex app-server` (JSON-RPC over stdio, one message per line) for tests.
// It answers the three calls Cyberdeck makes and records consumes in $CODEX_STUB_LOG.
import { appendFileSync } from "fs";

const credits = [
  { id: "RateLimitResetCredit_late", resetType: "codexRateLimits", status: "available", grantedAt: 1790708474, expiresAt: 1793300474, title: "Full reset", description: "late" },
  { id: "RateLimitResetCredit_soon", resetType: "codexRateLimits", status: "available", grantedAt: 1790109803, expiresAt: 1792701803, title: "Full reset", description: "soon" },
  { id: "RateLimitResetCredit_used", resetType: "codexRateLimits", status: "redeemed", grantedAt: 1780000000, expiresAt: 1790000000, title: "Full reset", description: null },
];
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
console.log("shell rc noise that is not JSON");

let buf = "";
for await (const chunk of process.stdin) {
  buf += new TextDecoder().decode(chunk as Uint8Array);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") out({ id: m.id, result: { userAgent: "stub" } });
    else if (m.method === "account/rateLimits/read") out({ id: m.id, result: { rateLimitResetCredits: { availableCount: 2, credits } } });
    else if (m.method === "account/rateLimitResetCredit/consume") {
      if (process.env.CODEX_STUB_LOG) appendFileSync(process.env.CODEX_STUB_LOG, JSON.stringify(m.params) + "\n");
      if (!m.params?.idempotencyKey) out({ id: m.id, error: { code: -32600, message: "idempotencyKey must not be empty" } });
      else out({ id: m.id, result: { outcome: m.params.creditId === "RateLimitResetCredit_used" ? "alreadyRedeemed" : "reset" } });
    } else if (m.id != null) out({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  }
}
