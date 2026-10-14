// The Desk's Fleet / Services / Agents glance (ui/lib/glance.ts): one overview boiled down.
import { describe, expect, test } from "bun:test";
import { glance, glanceAsk, glanceBadge } from "../ui/lib/glance";
import type { HostStatus, Overview, Task } from "../ui/lib/control";

const host = (name: string, online: boolean | null): HostStatus => ({ name, kind: "server", os: "linux", roles: [], online, cyberdeck: null });
const task = (id: string, status: string): Task => ({ id, title: `task ${id}`, project: "demo", host: "yacht", worker: "cx", reviewer: "cc", status, created: "2026-10-14", body: "" });
const overview = (over: Partial<Overview> = {}): Overview => ({
  fleetDir: "/fleet",
  status: { host: "yacht", time: "", hosts: [host("yacht", true), host("starlight", false), host("botical", null), host("enuc", true)], repo: { branch: "main", dirty: 0, ahead: 0, behind: 0 }, handoffOpen: 3, sessionsIndexed: 0 },
  projects: [],
  todo: { sections: [] },
  handoff: [],
  collab: { tasks: [task("T-1", "done"), task("T-2", "open"), task("T-3", "review"), task("T-4", "running")], runs: [], auto: true },
  services: { probedAt: "2026-10-14T03:00:00Z", rows: [
    { host: "yacht", service: "cyberdeck", type: "http", state: "200", ok: true },
    { host: "botical", service: "afterglow", type: "systemd", state: "failed", ok: false },
    { host: "starlight", service: "x", type: "launchd", state: "unreachable", ok: null },
  ] },
  ...over,
});

describe("glance", () => {
  test("hosts: down first, then unknown, then up; counts", () => {
    const g = glance(overview());
    expect(g.hosts).toMatchObject({ up: 2, down: 1, unknown: 1 });
    expect(g.hosts.rows.map((h) => h.name)).toEqual(["starlight", "botical", "enuc", "yacht"]);
    expect(g.handoffOpen).toBe(3);
  });

  test("paired nodes settle hosts the manifest leaves unknown, never override it", () => {
    const g = glance(overview(), [{ name: "Botical", online: true }, { name: "starlight", online: true }]);
    expect(g.hosts).toMatchObject({ up: 3, down: 1, unknown: 0 });
    expect(g.hosts.rows.find((h) => h.name === "starlight")?.online).toBe(false);
  });

  test("without a manifest status the paired nodes are the host list", () => {
    const g = glance(overview({ status: null }), [{ name: "Yacht", online: true }, { name: "iris", online: false }]);
    expect(g.hosts.rows.map((h) => [h.name, h.online])).toEqual([["iris", false], ["Yacht", true]]);
    expect(glanceAsk(g, "fleet")).toBe("Why is iris down?");
  });

  test("services: down and unknown rows split out, up counted", () => {
    const s = glance(overview()).services!;
    expect(s.up).toBe(1);
    expect(s.total).toBe(3);
    expect(s.down.map((r) => r.service)).toEqual(["afterglow"]);
    expect(s.unknown.map((r) => r.host)).toEqual(["starlight"]);
    expect(glance(overview({ services: null })).services).toBeNull();
  });

  test("agents: live tasks, running before review before open; done dropped", () => {
    const a = glance(overview()).agents;
    expect(a.active.map((t) => t.id)).toEqual(["T-4", "T-3", "T-2"]);
    expect(a.open).toBe(1);
    expect(a.auto).toBe(true);
  });

  test("badges count what needs a look", () => {
    const g = glance(overview());
    expect(glanceBadge(g, "fleet")).toEqual({ n: 1, tone: "bad" });
    expect(glanceBadge(g, "services")).toEqual({ n: 1, tone: "bad" });
    expect(glanceBadge(g, "agents")).toEqual({ n: 2, tone: "warn" });
    const calm = glance(overview({ status: null, services: { probedAt: null, rows: [] }, collab: { tasks: [task("T-9", "open")], runs: [], auto: false } }));
    expect(glanceBadge(calm, "fleet")).toEqual({ n: 0, tone: "ok" });
    expect(glanceBadge(calm, "services")).toEqual({ n: 0, tone: "ok" });
    expect(glanceBadge(calm, "agents")).toEqual({ n: 1, tone: "ok" });
  });

  test("the suggested question names what is wrong", () => {
    const g = glance(overview());
    expect(glanceAsk(g, "fleet")).toBe("Why is starlight down?");
    expect(glanceAsk(g, "services")).toBe("What is wrong with afterglow on botical?");
    expect(glanceAsk(g, "agents")).toBe("What is the status of T-4, task T-4?");
    const calm = glance(overview({ status: null, services: null, collab: { tasks: [], runs: [], auto: false } }));
    expect(glanceAsk(calm, "fleet")).toBe("How is the fleet doing?");
    expect(glanceAsk(calm, "services")).toBe("Are all the services healthy?");
    expect(glanceAsk(calm, "agents")).toBe("What are the agents working on?");
  });
});
