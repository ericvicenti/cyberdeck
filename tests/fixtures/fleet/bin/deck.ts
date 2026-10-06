// Stub fleet CLI for Cyberdeck's control-module tests: prints fixed JSON per subcommand.
const [cmd, sub] = process.argv.slice(2);
const out: Record<string, unknown> = {
  status: { host: "test-node", time: "2026-10-07T00:00:00Z", hosts: [{ name: "test-node", kind: "laptop", os: "macos", roles: ["agents"], online: true, cyberdeck: null }], repo: { branch: "main", dirty: 0, ahead: 0, behind: 0 }, handoffOpen: 2, sessionsIndexed: 1 },
  projects: [{ slug: "demo", name: "Demo", status: "active", depth: 0, parent: null, repos: ["demo"], hosts: ["test-node"], links: [], body: "A demo project.", file: "projects/demo/index.md" }],
  todo: { sections: [{ title: "Open", entries: [{ date: "2026-10-07", text: "**Demo** thing" }] }] },
  handoff: [{ file: "test-node-cc.md", host: "test-node", agent: "cc", text: "hi" }],
  sessions: [{ host: "test-node", tool: "cc", id: "abc", title: "t", cwd: "/tmp", started: "2026-10-07T00:00:00Z", updated: "2026-10-07T00:00:00Z", file: "/tmp/abc.jsonl" }],
  "collab list": [{ id: "t1", title: "Task", project: "demo", host: "test-node", worker: "cx", reviewer: "cc", status: "open", created: "2026-10-07", body: "" }],
  "collab runs": [],
  services: { probedAt: "2026-10-07T00:00:00Z", rows: [{ host: "test-node", service: "x", type: "launchd", state: "active", ok: true }] },
};
const key = cmd === "collab" ? `collab ${sub}` : cmd;
if (cmd === "collab" && sub === "add") { console.log("t2"); process.exit(0); }
console.log(JSON.stringify(out[key] ?? null));
