import type { VaultGame } from "../../src/shared/vimm";
export type StoredRom = {
  id: string;
  game: VaultGame;
  name: string;
  source?: string;
  digest: string;
  file: Blob;
  addedAt: number;
};
export type SavedState = { id: string; data: Uint8Array; updatedAt: number };
const DB = "cyberdeck-vault-player-v1";
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("roms", { keyPath: "id" });
      request.result.createObjectStore("states", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(
          "Browser storage is unavailable. Allow site storage to keep games and saves.",
        ),
      );
    request.onblocked = () =>
      reject(new Error("Close other Vault tabs and try again."));
  });
}
async function transact<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let request: IDBRequest<T>;
    try {
      request = action(tx.objectStore(store));
    } catch (error) {
      tx.abort();
      db.close();
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Couldn't save to browser storage."));
    };
  });
}
export const getRom = (id: string) =>
  transact<StoredRom | undefined>("roms", "readonly", (s) => s.get(id));
export const listRoms = () =>
  transact<StoredRom[]>("roms", "readonly", (s) => s.getAll());
export const getState = (id: string) =>
  transact<SavedState | undefined>("states", "readonly", (s) => s.get(id));
export const saveState = (state: SavedState) =>
  transact("states", "readwrite", (s) => s.put(state));
export async function storeRom(
  game: VaultGame,
  file: Blob,
  name: string,
  source?: string,
): Promise<StoredRom> {
  if (!crypto.subtle)
    throw new Error(
      "Inline play needs localhost or HTTPS. Open Cyberdeck through its secure Tailscale address.",
    );
  const bytes = await file.arrayBuffer();
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rom: StoredRom = {
    id: game.id,
    game,
    file,
    name,
    ...(source ? { source } : {}),
    digest,
    addedAt: Date.now(),
  };
  await transact("roms", "readwrite", (s) => s.put(rom));
  return rom;
}
