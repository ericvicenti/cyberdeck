import { test, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMusicRoutes } from "../src/daemon/api/music";

test("music archive survives database reopen, isolates accounts, rejects stale updates, and deletes precisely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyberdeck-music-"));
  let db = new Database(join(dir, "music.db"));
  const make = () => {
    const app = new Hono();
    registerMusicRoutes(app, db);
    return app;
  };
  let app = make();
  const put = (account: string, at: number, data: unknown) =>
    app.request("/api/music/archive", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account,
        key: `${account}:listen:one`,
        kind: "listen",
        at,
        data,
      }),
    });
  try {
    expect((await put("alice", 100, { name: "First track" })).status).toBe(200);
    expect((await put("bob", 101, { name: "Other account" })).status).toBe(200);
    expect((await put("alice", 99, { name: "Stale update" })).status).toBe(200);
    db.close();
    db = new Database(join(dir, "music.db"));
    app = make();
    const page = await (
      await app.request("/api/music/archive?account=alice")
    ).json();
    expect(page.records).toHaveLength(1);
    expect(page.records[0].data.name).toBe("First track");
    expect(
      (
        await app.request("/api/music/archive?account=alice", {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await app.request("/api/music/archive?account=alice")).json())
        .records,
    ).toEqual([]);
    expect(
      (await (await app.request("/api/music/archive?account=bob")).json())
        .records,
    ).toHaveLength(1);
    expect(
      (await app.request("/api/music/archive", { method: "DELETE" })).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/music/archive", {
          method: "PUT",
          body: JSON.stringify({
            account: "alice",
            key: "bob:listen:1",
            kind: "listen",
            at: 1,
            data: {},
          }),
        })
      ).status,
    ).toBe(400);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive pagination preserves every entry and enforces the body limit", async () => {
  const db = new Database(":memory:");
  const app = new Hono();
  registerMusicRoutes(app, db);
  try {
    const insert = db.query("INSERT INTO music_archive VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < 270; i++)
      insert.run(
        "alice",
        `alice:listen:${String(i).padStart(4, "0")}`,
        "listen",
        i,
        "{}",
      );
    const first = await (
      await app.request("/api/music/archive?account=alice")
    ).json();
    const second = await (
      await app.request(
        `/api/music/archive?account=alice&after=${encodeURIComponent(
          first.next,
        )}`,
      )
    ).json();
    expect(first.records).toHaveLength(250);
    expect(second.records).toHaveLength(20);
    expect(second.next).toBeNull();
    expect(
      (
        await app.request("/api/music/archive", {
          method: "PUT",
          body: "x".repeat(2 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
  } finally {
    db.close();
  }
});

test("audio survives reopen, restores exact bytes, isolates accounts and clears with archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyberdeck-audio-"));
  let db = new Database(join(dir, "music.db"));
  const make = () => {
    const app = new Hono();
    registerMusicRoutes(app, db);
    return app;
  };
  let app = make();
  const id = crypto.randomUUID();
  const bytes = new Uint8Array([26, 69, 223, 163, 9, 8, 7]);
  const metadata = {
    id,
    account: "alice",
    at: 123,
    track: { uri: "spotify:track:test", name: "Song" },
    startMs: 5000,
    endMs: 7000,
    durationMs: 2000,
    bytes: bytes.length,
    mime: "audio/webm;codecs=opus",
    finalized: true,
  };
  const put = (value: unknown) => {
    const form = new FormData();
    form.append("metadata", JSON.stringify(value));
    form.append("audio", new Blob([bytes]), "recording.webm");
    return app.request("/api/music/recordings", { method: "PUT", body: form });
  };
  try {
    expect((await put(metadata)).status).toBe(200);
    expect((await put({ ...metadata, bytes: 999 })).status).toBe(400);
    expect((await put({ ...metadata, mime: "text/html" })).status).toBe(400);
    db.close();
    db = new Database(join(dir, "music.db"));
    app = make();
    const list = await (
      await app.request("/api/music/recordings?account=alice")
    ).json();
    expect(list.recordings).toHaveLength(1);
    expect(list.recordings[0].local).toBe(false);
    const response = await app.request(
      `/api/music/recordings/${id}?account=alice`,
    );
    expect(response.headers.get("content-type")).toBe(metadata.mime);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(
      (await app.request(`/api/music/recordings/${id}?account=bob`)).status,
    ).toBe(404);
    await app.request("/api/music/archive?account=alice", { method: "DELETE" });
    expect(
      (await app.request(`/api/music/recordings/${id}?account=alice`)).status,
    ).toBe(404);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
