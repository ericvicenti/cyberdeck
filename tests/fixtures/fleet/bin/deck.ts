// Stub fleet CLI for Cyberdeck's control-module tests: prints fixed JSON per subcommand.
const [cmd, sub] = process.argv.slice(2);
const out: Record<string, unknown> = {
  status: { host: "test-node", time: "2026-10-07T00:00:00Z", hosts: [{ name: "test-node", kind: "laptop", os: "macos", ssh: "test-node", roles: ["agents"], online: true, cyberdeck: null }, { name: "other", kind: "server", os: "linux", ssh: "other-alias", roles: [], online: true, cyberdeck: null }], repo: { branch: "main", dirty: 0, ahead: 0, behind: 0 }, handoffOpen: 2, sessionsIndexed: 1 },
  projects: [{ slug: "demo", name: "Demo", status: "active", depth: 0, parent: null, repos: ["demo"], hosts: ["test-node"], services: ["test-node/x", "other/web-*"], links: ["ssh other-alias"], body: "A demo project.", file: "projects/demo/index.md" }],
  hosts: [
    { name: "test-node", kind: "laptop", os: "macos", ssh: "test-node", ts: null, roles: ["agents"], services: [{ name: "x", type: "launchd" }, { name: "sh.cyberdeck.daemon", type: "launchd" }, { name: "cyberdeck", type: "http" }], online: null },
    { name: "other", kind: "server", os: "linux", ssh: "other-alias", ts: null, roles: [], services: [{ name: "web-api", type: "systemd" }, { name: "db", type: "docker" }], online: null },
    { name: "phone", kind: "phone", os: "ios", ssh: null, ts: null, roles: [], services: [{ name: "app", type: "launchd" }], online: null },
  ],
  todo: { sections: [{ title: "Open", entries: [{ date: "2026-10-07", text: "**Demo** thing" }] }, { title: "Later", entries: [{ date: "2026-09-15", text: "Old [thing](x) nobody did" }] }] },
  handoff: [{ file: "test-node-cc.md", host: "test-node", agent: "cc", text: "hi" }],
  sessions: [{ host: "test-node", tool: "cc", id: "abc", title: "t", cwd: "/tmp", started: "2026-10-07T00:00:00Z", updated: "2026-10-07T00:00:00Z", file: "/tmp/abc.jsonl" }],
  "collab list": [{ id: "t1", title: "Task", project: "demo", host: "test-node", worker: "cx", reviewer: "cc", status: "open", created: "2026-10-07", body: "" }],
  "collab runs": [],
  services: { probedAt: "2026-10-07T00:00:00Z", rows: [{ host: "test-node", service: "x", type: "launchd", state: "active", ok: true }, { host: "other", service: "web-api", type: "systemd", state: "inactive", ok: false }, { host: "other", service: "db", type: "docker", state: "running", ok: true }] },
};
if (cmd === "context") { console.log(`host: test-node   cwd: ${sub ?? "~/Code"}   project: demo (Demo)\n\nhandoff (1 entry):\n- 2026-10-07 **Demo** thing\n\ninbox: empty`); process.exit(0); }
if (cmd === "projects" && sub === "--for") { console.log(JSON.stringify(process.argv[4]?.includes("demo") ? (out.projects as unknown[])[0] : null)); process.exit(0); }
const key = cmd === "collab" ? `collab ${sub}` : cmd;
if (cmd === "collab" && sub === "add") { console.log("t2"); process.exit(0); }
if (cmd === "todo" && (sub === "add" || sub === "done") || cmd === "handoff" && sub === "note") {
  const rest = process.argv.slice(4).filter((a) => a !== "--json");
  if (process.env.DECK_STUB_LOG) require("fs").appendFileSync(process.env.DECK_STUB_LOG, JSON.stringify([cmd, sub, ...rest]) + "\n");
  if (sub === "done" && !rest.join(" ").includes("Demo")) { console.log(JSON.stringify({ ok: false, error: `no entry contains "${rest.join(" ")}"`, candidates: [] })); process.exit(1); }
  if (sub === "note" && rest[0] !== "test-node" && rest[0] !== "other") { console.error("usage: deck handoff note <host> <cc|cx|seed> <text>"); process.exit(1); }
  console.log(JSON.stringify({ ok: true, ...(sub === "done" ? { removed: "- 2026-10-07 **Demo** thing" } : sub === "note" ? { file: `handoff/${rest[0]}-seed.md` } : { section: "Open", entry: `- 2026-10-07 ${rest.at(-1)}` }) }));
  process.exit(0);
}
console.log(JSON.stringify(out[key] ?? null));
