import { token } from "./api";
import { MAX_ROM_BYTES, romError } from "../../src/shared/vault-player";
import type { VaultGame } from "../../src/shared/vimm";

export async function downloadGame(game: VaultGame, signal: AbortSignal, progress: (bytes: number, total: number) => void) {
  const params = new URLSearchParams({ system: game.system, title: game.title, region: game.regions.join(",") });
  const response = await fetch(`/api/vimm/download/${game.id}?${params}`, {
    method: "POST", signal, headers: { authorization: `Bearer ${token()}` },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Download failed (HTTP ${response.status}).`);
  }
  const name = decodeURIComponent(response.headers.get("x-vault-filename") ?? "");
  const total = Number(response.headers.get("content-length")) || 0;
  const problem = romError(game.system, name, total || 1);
  if (problem || !response.body) {
    await response.body?.cancel();
    throw new Error(problem || "The download was empty.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      signal.throwIfAborted();
      bytes += value.length;
      if (bytes > MAX_ROM_BYTES) throw new Error("This game exceeds the 128 MiB inline-player limit.");
      chunks.push(new Uint8Array(value));
      progress(bytes, total);
    }
    signal.throwIfAborted();
    if (!bytes || (total && bytes !== total)) throw new Error("The download was incomplete. Please retry.");
    return { file: new Blob(chunks, { type: "application/octet-stream" }), name, source: response.headers.get("x-vault-source") ?? undefined };
  } finally { await reader.cancel().catch(() => {}); }
}
