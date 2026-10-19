import { api, token } from "./api";
import type { SpotifyTrack } from "./spotify";

/** A recorded interval of a song; its audio blob is stored separately from metadata. */
export type MusicRecording = {
  id: string;
  account: string;
  at: number;
  track: SpotifyTrack;
  startMs: number;
  endMs: number;
  durationMs: number;
  bytes: number;
  mime: string;
  finalized: boolean;
  local: boolean;
  synced?: boolean;
};

/** Browser-local Spotify metadata record; OAuth credentials are stored separately. */
export type SpotifyArchiveRecord = {
  key: string;
  account: string;
  kind: "response" | "listen";
  at: number;
  data: unknown;
  synced?: boolean;
};
let database: Promise<IDBDatabase> | undefined;
function openArchive(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("cyberdeck-spotify", 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("records"))
          db.createObjectStore("records", { keyPath: "key" });
        if (!db.objectStoreNames.contains("recordings"))
          db.createObjectStore("recordings", { keyPath: "id" });
        if (!db.objectStoreNames.contains("audio"))
          db.createObjectStore("audio");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
  return database;
}

/** Checkpoint a playable audio recording in the browser before reporting it saved. */
export async function saveMusicRecording(
  record: MusicRecording,
  audio: Blob,
): Promise<void> {
  const db = await openArchive();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["recordings", "audio"], "readwrite");
    tx.objectStore("recordings").put(record);
    tx.objectStore("audio").put(audio, record.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Audio save aborted"));
  });
}

/** Copy finalized audio to this node for durable backup; credentials are never uploaded. */
export async function syncMusicRecording(
  record: MusicRecording,
  audio: Blob,
): Promise<void> {
  const form = new FormData();
  form.append("metadata", JSON.stringify(record));
  form.append("audio", audio, "recording.webm");
  await api("/api/music/recordings", {
    local: true,
    method: "PUT",
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const db = await openArchive();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("recordings", "readwrite");
    tx.objectStore("recordings").put({ ...record, synced: true });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** List recorded intervals for an account without loading their audio into memory. */
export async function readMusicRecordings(
  account: string,
): Promise<MusicRecording[]> {
  const db = await openArchive();
  return new Promise((resolve, reject) => {
    const req = db.transaction("recordings").objectStore("recordings").getAll();
    req.onsuccess = () =>
      resolve(
        (req.result as MusicRecording[])
          .filter((r) => r.account === account)
          .sort((a, b) => b.at - a.at),
      );
    req.onerror = () => reject(req.error);
  });
}

/** Read a previously checkpointed audio file without any network request. */
export async function readMusicAudio(id: string): Promise<Blob | undefined> {
  const db = await openArchive();
  return new Promise((resolve, reject) => {
    const req = db.transaction("audio").objectStore("audio").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Merge node backups into the local index and retry finalized browser-only recordings. */
export async function refreshMusicRecordings(
  account: string,
  { sync = true }: { sync?: boolean } = {},
): Promise<MusicRecording[]> {
  const local = await readMusicRecordings(account);
  const remote = await api<{ recordings: MusicRecording[] }>(
    `/api/music/recordings?${new URLSearchParams({ account })}`,
    { local: true, signal: AbortSignal.timeout(10000) },
  );
  const recordings = new Map(remote.recordings.map((r) => [r.id, r]));
  for (const record of local) recordings.set(record.id, record);
  const db = await openArchive();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("recordings", "readwrite");
    for (const record of recordings.values())
      tx.objectStore("recordings").put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  for (const record of local.filter((r) => sync && r.finalized && !r.synced)) {
    const audio = await readMusicAudio(record.id);
    if (audio) await syncMusicRecording(record, audio);
  }
  return readMusicRecordings(account);
}

/** Return local audio first; restore a node backup when it is not cached in this browser yet. */
export async function getMusicRecordingAudio(
  record: MusicRecording,
): Promise<Blob> {
  const local = await readMusicAudio(record.id);
  if (local) return local;
  const response = await fetch(
    `/api/music/recordings/${encodeURIComponent(record.id)}?${new URLSearchParams({ account: record.account })}`,
    {
      headers: { authorization: `Bearer ${token()}` },
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok)
    throw new Error(
      "This recording is on the Cyberdeck node. Reconnect to it to save a browser copy.",
    );
  const audio = await response.blob();
  await saveMusicRecording({ ...record, local: true, synced: true }, audio);
  return audio;
}
/** Commit metadata before reporting it saved. No automatic expiry or size-based pruning. */
export async function saveSpotifyRecord(
  record: SpotifyArchiveRecord,
): Promise<void> {
  const db = await openArchive();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    tx.objectStore("records").put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Archive write aborted"));
  });
  await api("/api/music/archive", {
    local: true,
    signal: AbortSignal.timeout(10000),
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    tx.objectStore("records").put({ ...record, synced: true });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
/** Read only the connected account's records for history and a portable backup. */
export async function readSpotifyArchive(
  account: string,
  localOnly = false,
): Promise<SpotifyArchiveRecord[]> {
  const db = await openArchive();
  const local = await new Promise<SpotifyArchiveRecord[]>((resolve, reject) => {
    const req = db
      .transaction("records")
      .objectStore("records")
      .getAll(IDBKeyRange.bound(account + ":", account + ":\uffff"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (localOnly) return local;
  const records = new Map(local.map((r) => [r.key, r]));
  let after = "";
  do {
    const page = await api<{
      records: SpotifyArchiveRecord[];
      next: string | null;
    }>(`/api/music/archive?${new URLSearchParams({ account, after })}`, {
      local: true,
      signal: AbortSignal.timeout(10000),
    });
    for (const record of page.records)
      if (!records.has(record.key) || records.get(record.key)!.at < record.at)
        records.set(record.key, record);
    after = page.next || "";
  } while (after);
  // Retry locally saved writes that did not reach the node, without echoing node-only records.
  for (const record of local)
    if (!record.synced) await saveSpotifyRecord(record);
  return [...records.values()];
}
/** Forget personal metadata when this account disconnects. */
export async function clearSpotifyArchive(account: string): Promise<void> {
  await api(`/api/music/archive?${new URLSearchParams({ account })}`, {
    local: true,
    signal: AbortSignal.timeout(10000),
    method: "DELETE",
  });
  const db = await openArchive();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["records", "recordings", "audio"], "readwrite");
    tx.objectStore("records").delete(
      IDBKeyRange.bound(account + ":", account + ":\uffff"),
    );
    const cursor = tx.objectStore("recordings").openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (row.value.account === account) {
        tx.objectStore("audio").delete(row.value.id);
        row.delete();
      }
      row.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
