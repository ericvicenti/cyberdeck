import { test, expect } from "bun:test";
import { planHarness, type PlanInput, type Caps } from "../src/shared/harness";

const full: Caps = { cc: true, cx: true, tmux: true, cmux: false };
const base = (): PlanInput => ({
  prompt: "",
  context: { node: "", cwd: null, project: null },
  nodes: [
    { id: "", name: "starlight", online: true, caps: full },
    { id: "n-yacht", name: "yacht", online: true, caps: { cc: true, cx: true, tmux: false, cmux: true } },
    { id: "n-iris", name: "iris", online: false, caps: null },
  ],
  projects: [
    { slug: "seed-hypermedia", name: "Seed Hypermedia", repos: ["Seed", "SeedHost", "SeedInfra"], hosts: [] },
    { slug: "botical", name: "Botical", repos: ["BoticalMedia"], hosts: ["yacht"] },
    { slug: "commander", name: "Commander", repos: ["Commander"], hosts: ["starlight"] },
  ],
});

test("default: cc on the current node in ~/Code, tmux when available", () => {
  const p = planHarness({ ...base(), prompt: "tidy up the readme" });
  expect(p.tool).toBe("cc");
  expect(p.node).toBe("");
  expect(p.cwd).toBe("~/Code");
  expect(p.runner).toBe("tmux");
  expect(p.cmd).toBe("claude --dangerously-skip-permissions 'tidy up the readme'");
  expect(p.prompt).toBe("tidy up the readme");
  expect(p.title.startsWith("cc tidy up")).toBe(true);
});

test("project mention picks the repo directory and its host", () => {
  const p = planHarness({ ...base(), prompt: "fix the HLS playback bug in Afterglow for botical" });
  expect(p.node).toBe("n-yacht");
  expect(p.cwd).toBe("~/Code/BoticalMedia");
  expect(p.runner).toBe("pty"); // yacht has no tmux
  expect(p.reasons.join(" ")).toContain("lives on yacht");
});

test("repo name mention (case-insensitive, longest wins)", () => {
  const p = planHarness({ ...base(), prompt: "update the terraform in seedinfra" });
  expect(p.cwd).toBe("~/Code/Seed"); // project resolved; first non-glob repo is the project dir
  expect(p.reasons.join(" ")).toContain("Seed Hypermedia");
});

test("explicit tokens: $ shell, cx: prefix, @node, #project", () => {
  const sh = planHarness({ ...base(), prompt: "$ git status" });
  expect(sh.tool).toBe("shell");
  expect(sh.cmd).toBe("git status");
  expect(sh.prompt).toBe("");

  const cx = planHarness({ ...base(), prompt: "cx: review the last commit @yacht #seed" });
  expect(cx.tool).toBe("cx");
  expect(cx.node).toBe("n-yacht");
  expect(cx.cwd).toBe("~/Code/Seed");
  expect(cx.prompt).toBe("review the last commit");
  expect(cx.cmd).toBe("codex --yolo 'review the last commit'");
});

test("natural mentions of codex/claude choose the tool; prefix wins over mention", () => {
  expect(planHarness({ ...base(), prompt: "ask codex to check this" }).tool).toBe("cx");
  expect(planHarness({ ...base(), prompt: "have claude look, not codex" }).tool).toBe("cc");
  expect(planHarness({ ...base(), prompt: "cc: use codex style" }).tool).toBe("cc");
});

test("offline node falls back to local with a reason", () => {
  const p = planHarness({ ...base(), prompt: "restart things on iris" });
  expect(p.node).toBe("");
  expect(p.reasons.join(" ")).toContain("iris is offline");
});

test("context: current project and directory are used when nothing is mentioned", () => {
  const byProject = planHarness({ ...base(), prompt: "add tests", context: { node: "", project: "commander" } });
  expect(byProject.cwd).toBe("~/Code/Commander");
  const byCwd = planHarness({ ...base(), prompt: "add tests", context: { node: "", cwd: "/Users/eric/Code/Supe" } });
  expect(byCwd.cwd).toBe("/Users/eric/Code/Supe");
  // a project that lives elsewhere overrides the current host; the cwd of the old host is then not reused
  const moved = planHarness({ ...base(), prompt: "ship the botical player", context: { node: "", cwd: "/Users/eric/Code/Supe" } });
  expect(moved.node).toBe("n-yacht");
  expect(moved.cwd).toBe("~/Code/BoticalMedia");
});

test("overrides pin fields and are reported", () => {
  const p = planHarness({ ...base(), prompt: "do it on yacht with codex", overrides: { node: "", tool: "cc", cwd: "~/Code/Deck", runner: "pty" } });
  expect(p.node).toBe("");
  expect(p.tool).toBe("cc");
  expect(p.cwd).toBe("~/Code/Deck");
  expect(p.runner).toBe("pty");
  expect(p.pinned.sort()).toEqual(["cwd", "node", "runner", "tool"]);
});

test("missing tool on the target swaps to the other agent and warns if neither exists", () => {
  const nodes = base().nodes.map((n) => (n.id === "" ? { ...n, caps: { cc: false, cx: true, tmux: false, cmux: false } } : n));
  const p = planHarness({ ...base(), nodes, prompt: "hello" });
  expect(p.tool).toBe("cx");
  expect(p.reasons.join(" ")).toContain("cc is not installed");
  const none = base().nodes.map((n) => (n.id === "" ? { ...n, caps: { cc: false, cx: false, tmux: false, cmux: false } } : n));
  expect(planHarness({ ...base(), nodes: none, prompt: "hello" }).reasons.join(" ")).toContain("warning: cc not found");
});
