import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

const recordSchema = z.object({
  key: z.string().min(1).max(2048),
  account: z.string().min(1).max(128),
  kind: z.enum(["response", "listen"]),
  at: z.number().int().nonnegative(),
  data: z.unknown(),
});
const recordingSchema = z.object({
  id: z.string().uuid(),
  account: z.string().min(1).max(128),
  at: z.number().nonnegative(),
  track: z
    .object({
      uri: z.string().startsWith("spotify:track:"),
      name: z.string().max(1024),
    })
    .passthrough(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative().max(660000),
  bytes: z.number().int().nonnegative(),
  mime: z.string().regex(/^audio\/(webm|mp4)(;.*)?$/),
  finalized: z.literal(true),
});

/** Owner-authenticated, durable music archive in the node's backed-up SQLite database. */
export function registerMusicRoutes(app: Hono, db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS music_archive (
    account TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
    at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (account, key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS music_recordings (
    account TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
    metadata TEXT NOT NULL, audio BLOB NOT NULL, PRIMARY KEY (account,id)
  )`);
  app.put(
    "/api/music/recordings",
    bodyLimit({ maxSize: 32 * 1024 * 1024 }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      if (!form) return c.json({ error: "Invalid audio recording" }, 400);
      let metadata: unknown;
      try {
        metadata = JSON.parse(String(form.get("metadata") || "null"));
      } catch {
        return c.json({ error: "Invalid recording metadata" }, 400);
      }
      const parsed = recordingSchema.safeParse(metadata);
      const audio = form.get("audio");
      if (
        !parsed.success ||
        !(audio instanceof File) ||
        audio.size !== parsed.data.bytes ||
        !audio.size
      )
        return c.json({ error: "Invalid audio recording" }, 400);
      const recording = parsed.data;
      db.query(
        `INSERT INTO music_recordings (account,id,at,metadata,audio) VALUES (?,?,?,?,?)
      ON CONFLICT(account,id) DO UPDATE SET at=excluded.at,metadata=excluded.metadata,audio=excluded.audio`,
      ).run(
        recording.account,
        recording.id,
        recording.at,
        JSON.stringify(recording),
        new Uint8Array(await audio.arrayBuffer()),
      );
      return c.json({ saved: true });
    },
  );
  app.get("/api/music/recordings", (c) => {
    const account = c.req.query("account");
    if (!account || account.length > 128)
      return c.json({ error: "Account required" }, 400);
    const rows = db
      .query(
        "SELECT metadata FROM music_recordings WHERE account=? ORDER BY at DESC",
      )
      .all(account) as { metadata: string }[];
    return c.json({
      recordings: rows.map((row) => ({
        ...JSON.parse(row.metadata),
        synced: true,
        local: false,
      })),
    });
  });
  app.get("/api/music/recordings/:id", (c) => {
    const account = c.req.query("account");
    if (!account || account.length > 128)
      return c.json({ error: "Account required" }, 400);
    const row = db
      .query(
        "SELECT metadata,audio FROM music_recordings WHERE account=? AND id=?",
      )
      .get(account, c.req.param("id")) as {
      metadata: string;
      audio: Uint8Array;
    } | null;
    if (!row) return c.json({ error: "Recording not found" }, 404);
    return new Response(new Uint8Array(row.audio), {
      headers: {
        "content-type": JSON.parse(row.metadata).mime,
        "cache-control": "private, no-store",
      },
    });
  });
  app.put(
    "/api/music/archive",
    bodyLimit({ maxSize: 2 * 1024 * 1024 }),
    async (c) => {
      const parsed = recordSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json({ error: "Invalid music metadata record" }, 400);
      const record = parsed.data;
      if (
        !record.key.startsWith(`${record.account}:${record.kind}:`) ||
        record.data === undefined
      )
        return c.json({ error: "Invalid archive key" }, 400);
      db.query(
        `INSERT INTO music_archive (account, key, kind, at, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account, key) DO UPDATE SET kind=excluded.kind, at=excluded.at, data=excluded.data
      WHERE excluded.at >= music_archive.at`,
      ).run(
        record.account,
        record.key,
        record.kind,
        record.at,
        JSON.stringify(record.data),
      );
      return c.json({ saved: true });
    },
  );
  app.get("/api/music/archive", (c) => {
    const account = c.req.query("account");
    if (!account || account.length > 128)
      return c.json({ error: "Account required" }, 400);
    const after = c.req.query("after") || "";
    const rows = db
      .query(
        "SELECT key, account, kind, at, data FROM music_archive WHERE account = ? AND key > ? ORDER BY key LIMIT 251",
      )
      .all(account, after) as {
      key: string;
      account: string;
      kind: string;
      at: number;
      data: string;
    }[];
    const records = rows
      .slice(0, 250)
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
    return c.json({
      records,
      next: rows.length > 250 ? records[records.length - 1]!.key : null,
    });
  });
  app.delete("/api/music/archive", (c) => {
    const account = c.req.query("account");
    if (!account || account.length > 128)
      return c.json({ error: "Account required" }, 400);
    db.query("DELETE FROM music_archive WHERE account = ?").run(account);
    db.query("DELETE FROM music_recordings WHERE account = ?").run(account);
    return c.json({ deleted: true });
  });
}
