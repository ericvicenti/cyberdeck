// Pure helpers for the fleet-first views (shared by the UI and its tests): how rows that
// come from several machines are tagged, merged and deduplicated, and which machine a
// host-bound action runs on.
//
// Identity rules
// - A Deck project is fleet-wide: its slug is the identity, and the overview of ONE node is
//   the canonical list (never unioned, so a project is never listed twice because two hosts
//   both have the Deck checkout).
// - Anything that lives on a machine (a checkout, a live session, a cmux surface, a data
//   directory) is identified by `${node}:${key}`: the same path on two machines is two rows,
//   the same row answered twice by one machine is one.

export type NodeRef = { id: string; name: string };
export type Tagged<T> = T & { node: string; nodeName: string };
export type NodeAnswer<T> = { node: NodeRef; data: T | null; error: string | null };

export const compositeId = (node: string, key: string): string => `${node}:${key}`;

/** Tag every row with its node and drop duplicates by `${node}:${key(row)}` (first wins). */
export function unionByNode<T>(answers: NodeAnswer<T[]>[], key: (row: T) => string): Tagged<T>[] {
  const seen = new Set<string>();
  const out: Tagged<T>[] = [];
  for (const a of answers) {
    for (const row of a.data ?? []) {
      const id = compositeId(a.node.id, key(row));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...row, node: a.node.id, nodeName: a.node.name });
    }
  }
  return out;
}

/** Rows grouped by node, in the order the nodes answered. */
export function groupByNode<T extends { node: string; nodeName: string }>(rows: T[]): { node: string; nodeName: string; rows: T[] }[] {
  const groups = new Map<string, { node: string; nodeName: string; rows: T[] }>();
  for (const r of rows) {
    let g = groups.get(r.node);
    if (!g) { g = { node: r.node, nodeName: r.nodeName, rows: [] }; groups.set(r.node, g); }
    g.rows.push(r);
  }
  return [...groups.values()];
}

/** Repo glob (relative to ~/Code, `*` = one path segment) → does it cover this repo path? */
export function globMatches(glob: string, repoPath: string): boolean {
  const rel = repoPath.replace(/^.*\/Code\//, "");
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "(/|$)");
  return re.test(rel);
}

/** The checkouts (on any machine) a project's `repos:` globs claim. */
export function checkoutsFor<T extends { path: string }>(project: { repos: string[] }, repos: T[]): T[] {
  return repos.filter((r) => project.repos.some((g) => globMatches(g, r.path)));
}

/** Checkouts no project claims, newest commit first. */
export function unclaimed<T extends { path: string; last_commit_at: number | null }>(projects: { repos: string[] }[], repos: T[]): T[] {
  return repos.filter((r) => !projects.some((p) => p.repos.some((g) => globMatches(g, r.path)))).sort((a, b) => (b.last_commit_at ?? 0) - (a.last_commit_at ?? 0));
}

export type NodeHealth = { node: NodeRef; state: "ok" | "stale" | "error" | "offline" | "loading"; error: string | null };

/** One line per machine for a status strip: did it answer, is what we show from an earlier answer, or did it fail outright. */
export function nodeHealth<T>(answers: (NodeAnswer<T> & { online?: boolean; loading?: boolean })[]): NodeHealth[] {
  return answers.map((a) => ({
    node: a.node,
    state: a.online === false ? "offline" : a.error && a.data != null ? "stale" : a.error ? "error" : a.data == null && a.loading !== false ? "loading" : "ok",
    error: a.error,
  }));
}

/** Short label for a machine in a row ("" = this machine, shown by its own name). */
export const nodeLabel = (node: string, nodeName: string, selfName: string): string => (node ? nodeName : selfName || nodeName || "local");

/** Does the session the URL names (`session` + optional `node`) match this row? Node-less links are this machine. */
export const isSessionRef = (row: { id: string; node: string }, session: string, node: string): boolean => row.id === session && row.node === (node ?? "");

// ---- where a command for a fleet host runs ----
// Two identities are easy to confuse and must not be: the machine SERVING the page (node ""),
// and the machine the Deck data was READ from (`overview.status.host`, which is a peer when
// this node has no Deck checkout). Only the serving machine is "local".
export type HostRoute = { kind: "local" } | { kind: "node"; id: string; name: string } | { kind: "ssh"; alias: string } | { kind: "none"; reason: string };

/** `me` is the fleet.json name of the machine serving the page (see `servingHost`), never the Deck source's. */
export function resolveHost(t: { host: string; me: string; hosts: { name: string; ssh?: string | null }[]; nodes: { id: string; name: string; online: boolean; probe_device?: string | null }[] }): HostRoute {
  const h = t.host.toLowerCase();
  if (t.me && h === t.me.toLowerCase()) return { kind: "local" };
  const n = t.nodes.find((x) => x.name.toLowerCase() === h);
  if (n?.online) return { kind: "node", id: n.id, name: n.name };
  if (n?.probe_device) return { kind: "none", reason: `${t.host} is unreachable through Probe` };
  const alias = t.hosts.find((x) => x.name.toLowerCase() === h)?.ssh;
  if (alias) return { kind: "ssh", alias };
  return { kind: "none", reason: n ? `${t.host} is offline` : `${t.host} has no ssh alias and is not a paired node` };
}

/** The fleet.json host name of the machine serving the page. Deck's own `status.host` is that name only
 *  when the overview came from this node; when it came from a peer, it is the peer's name and must not be used. */
export function servingHost(statusHost: string | null | undefined, source: { node: string } | null, selfName: string | null | undefined): string {
  if (source && source.node !== "") return selfName ?? "";
  return statusHost || selfName || "";
}
