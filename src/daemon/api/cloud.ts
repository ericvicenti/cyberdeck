// Cloud AI routes: provider status, on-demand sync, and the archived conversations.
import type { Hono } from "hono";
import { CloudArchive, PROVIDERS, type Provider } from "../cloud";

const isProvider = (p: string): p is Provider => (PROVIDERS as string[]).includes(p);

export function registerCloudRoutes(app: Hono, cloud: CloudArchive) {
  app.get("/api/cloud", (c) => c.json(cloud.summary()));

  app.post("/api/cloud/:provider/sync", (c) => {
    const p = c.req.param("provider");
    if (!isProvider(p)) return c.json({ error: "unknown provider" }, 404);
    cloud.sync(p).catch((e) => console.warn(`cloud ${p}: ${e}`)); // runs in the background; the UI polls /api/cloud
    return c.json({ started: true });
  });

  app.get("/api/cloud/:provider/conversations", (c) => {
    const p = c.req.param("provider");
    if (!isProvider(p)) return c.json({ error: "unknown provider" }, 404);
    return c.json(cloud.list(p, c.req.query("q") ?? ""));
  });

  app.get("/api/cloud/:provider/conversations/:id", (c) => {
    const p = c.req.param("provider");
    if (!isProvider(p)) return c.json({ error: "unknown provider" }, 404);
    const doc = cloud.read(p, c.req.param("id"));
    return doc ? c.json(doc) : c.json({ error: "not archived" }, 404);
  });
}
