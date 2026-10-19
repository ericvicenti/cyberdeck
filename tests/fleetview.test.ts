// Pure merge/dedupe rules behind the fleet-first views (src/shared/fleetview.ts) and the
// URL helpers that address a node explicitly (ui/lib/api.ts has no DOM dependency for these).
import { test, expect } from "bun:test";
import { unionByNode, groupByNode, checkoutsFor, unclaimed, nodeHealth, compositeId, isSessionRef, nodeLabel, globMatches, resolveHost, servingHost } from "../src/shared/fleetview";

const self = { id: "", name: "yacht" };
const peer = { id: "stw-two", name: "starlight" };

test("unionByNode keeps the same path on two machines as two rows, and a machine's duplicate as one", () => {
  const rows = unionByNode(
    [
      { node: self, data: [{ path: "/Users/e/Code/Cyberdeck" }, { path: "/Users/e/Code/Cyberdeck" }], error: null },
      { node: peer, data: [{ path: "/Users/e/Code/Cyberdeck" }, { path: "/Users/e/Code/Seed" }], error: null },
    ],
    (r) => r.path
  );
  expect(rows.map((r) => compositeId(r.node, r.path))).toEqual([":/Users/e/Code/Cyberdeck", "stw-two:/Users/e/Code/Cyberdeck", "stw-two:/Users/e/Code/Seed"]);
  expect(rows[1].nodeName).toBe("starlight");
});

test("a node that failed contributes nothing but does not hide the others (partial availability)", () => {
  const rows = unionByNode([{ node: self, data: [{ id: "a" }], error: null }, { node: peer, data: null, error: "proxy to starlight failed" }], (r) => r.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].node).toBe("");
  const health = nodeHealth([{ node: self, data: [{ id: "a" }], error: null }, { node: peer, data: null, error: "proxy to starlight failed" }]);
  expect(health.map((h) => h.state)).toEqual(["ok", "error"]);
});

test("nodeHealth: a failed refresh with an earlier answer is stale, an offline peer is offline, no answer yet is loading", () => {
  const health = nodeHealth([
    { node: self, data: [1], error: "timeout" },
    { node: peer, data: null, error: "starlight is offline", online: false },
    { node: { id: "x", name: "enuc" }, data: null, error: null, loading: true },
  ]);
  expect(health.map((h) => h.state)).toEqual(["stale", "offline", "loading"]);
});

test("project checkouts are matched per machine by the same repos globs; unclaimed repos are the rest, newest first", () => {
  const repos = unionByNode(
    [
      { node: self, data: [{ path: "/Users/e/Code/Cyberdeck", last_commit_at: 10 }, { path: "/Users/e/Code/Stray", last_commit_at: 5 }], error: null },
      { node: peer, data: [{ path: "/home/e/Code/Cyberdeck", last_commit_at: 20 }, { path: "/home/e/Code/Other", last_commit_at: 30 }], error: null },
    ],
    (r) => r.path
  );
  const project = { repos: ["Cyberdeck"] };
  const groups = groupByNode(checkoutsFor(project, repos));
  expect(groups.map((g) => [g.nodeName, g.rows.length])).toEqual([["yacht", 1], ["starlight", 1]]);
  const rest = unclaimed([project], repos);
  expect(rest.map((r) => `${r.nodeName}:${r.path.split("/").pop()}`)).toEqual(["starlight:Other", "yacht:Stray"]);
  expect(globMatches("Cyberdeck*", "/x/Code/Cyberdeck-wt-fleet-views")).toBe(true);
  expect(globMatches("Cyberdeck", "/x/Code/Cyberdeck-wt-fleet-views")).toBe(false);
});

test("a session link is only the row on the named node; a link without a node is this machine", () => {
  const local = { id: "s1", node: "" };
  const remote = { id: "s1", node: "stw-two" };
  expect(isSessionRef(local, "s1", "")).toBe(true);
  expect(isSessionRef(remote, "s1", "")).toBe(false);
  expect(isSessionRef(remote, "s1", "stw-two")).toBe(true);
  expect(nodeLabel("", "", "yacht")).toBe("yacht");
  expect(nodeLabel("stw-two", "starlight", "yacht")).toBe("starlight");
});

test("ui/lib/api: nodePath and routeNode address a node explicitly and never from stored state", async () => {
  // jsdom-free: these helpers only touch `location` inside navigate(), not here
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { nodePath, routeNode } = await import("../ui/lib/api");
  const { routeHash, rememberNodeNames, nodeName } = await import("../ui/lib/navigation");
  expect(nodePath("", "/api/fs/list")).toBe("/api/fs/list");
  expect(nodePath("stw-two", "/api/fs/list")).toBe("/api/nodes/stw-two/proxy/fs/list");
  expect(nodePath("stw-two", "/api/fleet/nodes")).toBe("/api/fleet/nodes");
  expect(nodePath("stw-two", "/api/nodes/x/proxy/status")).toBe("/api/nodes/x/proxy/status");
  expect(nodePath("a/b", "/api/status")).toBe("/api/nodes/a%2Fb/proxy/status");
  expect(routeHash("files", { path: "/tmp", node: "stw-two" })).toBe("#/files?node=stw-two&path=%2Ftmp");
  expect(routeNode(new URLSearchParams("path=%2Ftmp"))).toBe("");
  expect(routeNode(new URLSearchParams("path=%2Ftmp&node=stw-two"))).toBe("stw-two");
  // titles name machines, not ids, once the fleet list has been read
  expect(nodeName("stw-two")).toBe("stw-two");
  rememberNodeNames([{ id: "", name: "yacht" }, { id: "stw-two", name: "starlight" }]);
  expect(nodeName("stw-two")).toBe("starlight");
  expect(nodeName("")).toBe("yacht");
  expect(nodeName("self")).toBe("yacht");
});

// ---- serving machine vs Deck source (the "wrong machine" trap) ----
test("servingHost: Deck's status.host is 'here' only when the overview came from this node", () => {
  // overview read locally: Deck's own host name wins (it is this machine's fleet.json name)
  expect(servingHost("yacht", { node: "" }, "yacht")).toBe("yacht");
  expect(servingHost("yacht", null, "yacht")).toBe("yacht");
  expect(servingHost(null, { node: "" }, "enuc")).toBe("enuc");
  // overview read from a peer: status.host is the PEER's name and must not become "here"
  expect(servingHost("yacht", { node: "stw-yacht" }, "enuc")).toBe("enuc");
  // ...and when this node's own name is not known yet, nothing is local
  expect(servingHost("yacht", { node: "stw-yacht" }, undefined)).toBe("");
});

test("resolveHost: viewing from enuc with Deck read from yacht, yacht's actions go to the yacht node, never local", () => {
  const hosts = [{ name: "yacht", ssh: "yacht" }, { name: "enuc", ssh: "enuc" }, { name: "botical", ssh: "botical" }];
  const nodes = [{ id: "stw-yacht", name: "yacht", online: true }, { id: "stw-iris", name: "iris", online: false }];
  const me = servingHost("yacht", { node: "stw-yacht" }, "enuc");
  expect(resolveHost({ host: "yacht", me, hosts, nodes })).toEqual({ kind: "node", id: "stw-yacht", name: "yacht" });
  expect(resolveHost({ host: "Yacht", me, hosts, nodes })).toEqual({ kind: "node", id: "stw-yacht", name: "yacht" });
  expect(resolveHost({ host: "enuc", me, hosts, nodes })).toEqual({ kind: "local" });
  expect(resolveHost({ host: "botical", me, hosts, nodes })).toEqual({ kind: "ssh", alias: "botical" });
  expect(resolveHost({ host: "iris", me, hosts, nodes }).kind).toBe("none");
  // the old bug: `me` taken from the peer's status.host made the peer's rows local
  expect(resolveHost({ host: "yacht", me: "yacht", hosts, nodes })).toEqual({ kind: "local" });
  // an empty `me` never resolves anything as local
  expect(resolveHost({ host: "enuc", me: "", hosts, nodes })).toEqual({ kind: "ssh", alias: "enuc" });
});

test("projects are never unioned: two machines with the Deck checkout still give one list, with every machine's checkouts under it", () => {
  // the overview of ONE node is the canonical project list (the slug is the identity)...
  const overviewA = { projects: [{ slug: "cyberdeck", repos: ["Cyberdeck*"] }, { slug: "deck", repos: ["Deck"] }] };
  const overviewB = { projects: [{ slug: "cyberdeck", repos: ["Cyberdeck*"] }, { slug: "deck", repos: ["Deck"] }] };
  const projects = overviewA.projects; // never [...A, ...B]
  expect(projects.map((p) => p.slug)).toEqual(["cyberdeck", "deck"]);
  expect(overviewB.projects.map((p) => p.slug)).toEqual(projects.map((p) => p.slug));
  // ...while checkouts are host-bound: the same path on two machines is two rows, grouped by machine
  const repos = unionByNode(
    [
      { node: { id: "", name: "yacht" }, data: [{ path: "/u/e/Code/Cyberdeck" }, { path: "/u/e/Code/Cyberdeck-wt-fleet-views" }, { path: "/u/e/Code/Deck" }], error: null },
      { node: { id: "stw-enuc", name: "enuc" }, data: [{ path: "/home/e/Code/Cyberdeck" }, { path: "/home/e/Code/Deck" }], error: null },
      // a dead peer that answered earlier keeps its (stale) rows; nothing is doubled
      { node: { id: "stw-enuc", name: "enuc" }, data: [{ path: "/home/e/Code/Cyberdeck" }], error: "timeout" },
    ],
    (r) => r.path,
  );
  const groups = groupByNode(checkoutsFor(projects[0], repos));
  expect(groups.map((g) => `${g.nodeName}:${g.rows.length}`)).toEqual(["yacht:2", "enuc:1"]);
  expect(groupByNode(checkoutsFor(projects[1], repos)).map((g) => `${g.nodeName}:${g.rows.map((r) => r.path).join("|")}`)).toEqual(["yacht:/u/e/Code/Deck", "enuc:/home/e/Code/Deck"]);
});
