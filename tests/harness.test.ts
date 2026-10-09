import { test, expect } from "bun:test";
import { planHarness, type PlanInput, type Caps } from "../src/shared/harness";

const full: Caps = { seed: true, cc: true, cx: true, tmux: true, cmux: false };
const base = (): PlanInput => ({
  prompt: "",
  context: { node: "", cwd: null, project: null },
  nodes: [
    { id: "", name: "starlight", online: true, caps: full },
    { id: "n-yacht", name: "yacht", online: true, caps: { seed: true, cc: true, cx: true, tmux: false, cmux: true } },
    { id: "n-iris", name: "iris", online: false, caps: null },
  ],
  projects: [
    { slug: "seed-hypermedia", name: "Seed Hypermedia", repos: ["Seed", "SeedHost", "SeedInfra"], hosts: [] },
    { slug: "botical", name: "Botical", repos: ["BoticalMedia"], hosts: ["yacht"] },
    { slug: "commander", name: "Commander", repos: ["Commander"], hosts: ["starlight"] },
  ],
});

test("default: Seed on a ready server without a shell command", () => {
  const p = planHarness({ ...base(), prompt: "tidy up the readme" });
  expect(p.tool).toBe("seed");
  expect(p.node).toBe("");
  expect(p.cwd).toBe("~/Code");
  expect(p.runner).toBe("agent");
  expect(p.cmd).toBe("");
  expect(p.prompt).toBe("tidy up the readme");
  expect(p.title.startsWith("seed tidy up")).toBe(true);
});

test("project mention picks the repo directory and its host", () => {
  const p = planHarness({ ...base(), prompt: "fix the HLS playback bug in Afterglow for botical" });
  expect(p.node).toBe("n-yacht");
  expect(p.cwd).toBe("~/Code/BoticalMedia");
  expect(p.runner).toBe("agent"); // Seed survives the client closing
  expect(p.reasons.join(" ")).toContain("lives on yacht");
});

test("repo name mention picks that repo's directory (case-insensitive, longest wins)", () => {
  const p = planHarness({ ...base(), prompt: "update the terraform in seedinfra" });
  expect(p.cwd).toBe("~/Code/SeedInfra");
  expect(p.reasons.join(" ")).toContain("SeedInfra (Seed Hypermedia)");
  // project name alone → the project's first repo
  expect(planHarness({ ...base(), prompt: "seed hypermedia docs pass" }).cwd).toBe("~/Code/Seed");
  // #repo tag also prefers that repo
  expect(planHarness({ ...base(), prompt: "lint #SeedHost" }).cwd).toBe("~/Code/SeedHost");
});

test("tool pinned to shell runs the text as the command", () => {
  const p = planHarness({ ...base(), prompt: "git status", overrides: { tool: "shell" } });
  expect(p.cmd).toBe("git status");
  expect(p.prompt).toBe("");
  expect(p.title).toBe("sh git status");
  expect(p.reasons.join(" ")).toContain("runs as a command");
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
  const p = planHarness({ ...base(), prompt: "cc: restart things on iris" });
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

test("Seed routes to a healthy server and preserves the work's machine context", () => {
  const nodes = base().nodes.map((n) => n.id === "" ? { ...n, caps: { ...full, seed: false } } : n);
  const p = planHarness({ ...base(), nodes, prompt: "hello", context: { node: "", cwd: "/Users/eric/Code/Deck" } });
  expect(p.tool).toBe("seed");
  expect(p.node).toBe("n-yacht");
  expect(p.contextNodeName).toBe("starlight");
  expect(p.cwd).toBe("/Users/eric/Code/Deck");
  expect(p.error).toBeUndefined();
  const pinned = planHarness({ ...base(), nodes, prompt: "hello", overrides: { node: "" } });
  expect(pinned.node).toBe("");
  expect(pinned.error).toContain("No ready Seed");
});

test("no ready server blocks Seed instead of silently starting a different agent", () => {
  const nodes = base().nodes.map((n) => ({ ...n, caps: { ...full, seed: false } }));
  const p = planHarness({ ...base(), nodes, prompt: "hello" });
  expect(p.tool).toBe("seed");
  expect(p.cmd).toBe("");
  expect(p.error).toContain("No ready Seed");
  expect(planHarness({ ...base(), prompt: "seed: hello @iris" }).error).toContain("iris");
  expect(planHarness({ ...base(), nodes, prompt: "cx: hello" }).error).toBeUndefined();
});

test("saved CLI preference and explicit Seed prefix remain available", () => {
  const cli = planHarness({ ...base(), prompt: "hello", defaultTool: "cx" });
  expect(cli.tool).toBe("cx");
  expect(cli.cmd).toBe("codex --yolo 'hello'");
  expect(planHarness({ ...base(), prompt: "seed: hello", defaultTool: "cx" }).tool).toBe("seed");
});

test("scanned repos: any indexed checkout is a destination, on whichever node has it", () => {
  const repos = [
    { node: "n-yacht", name: "LangKit", path: "/Users/eric/Code/LangKit" },
    { node: "", name: "Supe", path: "/Users/eric/Code/Supe" },
    { node: "n-yacht", name: "Supe", path: "/Users/eric/Code/Supe" },
    { node: "n-iris", name: "OnlyOnIris", path: "/home/eric/Code/OnlyOnIris" },
  ];
  const lk = planHarness({ ...base(), repos, prompt: "add a tokenizer test to LangKit" });
  expect(lk.node).toBe("n-yacht");
  expect(lk.cwd).toBe("/Users/eric/Code/LangKit");
  expect(lk.reasons.join(" ")).toContain("LangKit (checkout on yacht)");
  // present on both machines: stay on the current one
  const supe = planHarness({ ...base(), repos, prompt: "lint supe" });
  expect(supe.node).toBe("");
  expect(supe.cwd).toBe("/Users/eric/Code/Supe");
  // only on an offline node: no match, default directory
  expect(planHarness({ ...base(), repos, prompt: "fix OnlyOnIris" }).cwd).toBe("~/Code");
  // #tag works for checkouts too; Deck projects still win for their own names
  expect(planHarness({ ...base(), repos, prompt: "docs #langkit" }).cwd).toBe("/Users/eric/Code/LangKit");
  expect(planHarness({ ...base(), repos, prompt: "ship the botical player" }).cwd).toBe("~/Code/BoticalMedia");
});
