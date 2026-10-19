import { token } from "./api";
import type { StoredRom } from "./vault-storage";
export type NativeLibrary = { available: boolean; systems: { id: string; core: boolean }[]; games: { id: string; file: string; system: string }[]; running?: { id: string } | null };
/** Only the physical, locally authenticated kiosk may turn Play into a native window. */
export function canUseNativeN64(system: string, hostname: string, bridge: boolean) {
  return system === "N64" && bridge && ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}
export async function nativeRequest<T>(path: string, signal?: AbortSignal, body?: Blob | string): Promise<T> {
  const r = await fetch(`/api/games${path}`, { signal, headers: { authorization: `Bearer ${token()}` }, ...(body !== undefined ? { method: "POST", body } : {}) });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "The TV player couldn't start.");
  return result;
}
export async function prepareNativeRom(rom: StoredRom, library: NativeLibrary, signal: AbortSignal) {
  const ext = rom.name.split(".").pop()!.toLowerCase();
  if (!["z64", "n64", "v64", "zip"].includes(ext)) throw new Error("This archive format isn't supported by the TV player.");
  // Content-addressed names cannot silently replace another release or its saves.
  const name = `vault-${rom.digest}.${ext}`;
  const existing = library.games.find(g => g.system === "n64" && g.file === name);
  if (existing) return existing.id;
  const { game } = await nativeRequest<{ game: { id: string } }>(`/upload?name=${encodeURIComponent(name)}`, signal, rom.file);
  return game.id;
}
