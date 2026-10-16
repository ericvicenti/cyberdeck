// The Seed harness text: prompt and memory pack derived from a node's files (src/daemon/harness.ts).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { harnessPrompt, knowledgeSection, memoryPack, readHarnessSources, PACK_DIR } from "../src/daemon/harness";

const ctx = { nodeName: "yacht", hostname: "yacht.local", mcpName: "cyberdeck", nodeTools: true, packDir: PACK_DIR };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-root-"));
  writeFileSync(join(root, "CLAUDE.md"), "@./AGENTS.md\n");
  writeFileSync(join(root, "AGENTS.md"), "# ~/Code\n\nNever commit here.\n");
  const deck = mkdtempSync(join(tmpdir(), "harness-deck-"));
  writeFileSync(join(deck, "AGENTS.md"), "# Deck agent protocol\n\nRun `deck context` first.\n");
  const mem = mkdtempSync(join(tmpdir(), "harness-mem-"));
  writeFileSync(join(mem, "MEMORY.md"), "# index\n");
  writeFileSync(join(mem, "b-note.md"), "---\nname: b-note\ndescription: second fact\nmetadata:\n  type: project\n---\n\nB.\n");
  writeFileSync(join(mem, "a-note.md"), "---\nname: a-note\ndescription: first fact: with colon\n---\n\nA.\n");
  writeFileSync(join(mem, "empty.md"), "\n");
  writeFileSync(join(mem, "notes.txt"), "not markdown\n");
  mkdirSync(join(mem, "sub"));
  return { root, deck, mem };
}

describe("harness sources", () => {
  test("AGENTS.md wins over a CLAUDE.md that only includes it; notes come from the memory dirs, markdown only, index excluded", () => {
    const { root, deck, mem } = fixture();
    const src = readHarnessSources({ roots: [root], fleetDir: deck, memoryDirs: [mem, "/nonexistent/dir"] });
    expect(src.rules?.path).toBe(join(root, "AGENTS.md"));
    expect(src.deck?.text).toContain("Run `deck context` first.");
    expect(src.notes.map((n) => n.name)).toEqual(["a-note", "b-note"]);
  });
  test("missing files are simply absent", () => {
    const empty = mkdtempSync(join(tmpdir(), "harness-empty-"));
    const src = readHarnessSources({ roots: [empty], fleetDir: null, memoryDirs: [] });
    expect(src.rules).toBeUndefined(); expect(src.deck).toBeUndefined(); expect(src.notes).toEqual([]);
    expect(harnessPrompt(src, ctx)).toContain("You are Cyberdeck");
    expect(knowledgeSection(src, ctx)).toBe("");
  });
});

describe("harness prompt", () => {
  test("carries the persona, the tool guide with the server prefix, and both files verbatim under sourced headings", () => {
    const { root, deck, mem } = fixture();
    const src = readHarnessSources({ roots: [root], fleetDir: deck, memoryDirs: [mem] });
    const p = harnessPrompt(src, ctx);
    expect(p).toContain("fleet machine **yacht** (hostname yacht.local)");
    for (const t of ["deck_context", "shell", "read_file", "edit_file", "todo_add", "handoff_note"]) expect(p).toContain(`\`cyberdeck__${t}\``);
    expect(p).toContain(`## Fleet rules (${join(root, "AGENTS.md")} on yacht)`);
    expect(p).toContain("Never commit here.");
    expect(p).toContain(`## Deck agent protocol (${join(deck, "AGENTS.md")})`);
    expect(p).toContain("~/memory/fleet/README.md");
    expect(p).not.toContain("@./AGENTS.md");
  });
  test("without node tools the prompt says so instead of advertising a shell", () => {
    const src = readHarnessSources({ roots: [], fleetDir: null, memoryDirs: [] });
    const p = harnessPrompt(src, { ...ctx, nodeTools: false });
    expect(p).toContain("no shell or file tools");
    expect(p).not.toContain("`cyberdeck__shell`");
  });
  test("is deterministic for the same sources", () => {
    const { root, deck, mem } = fixture();
    const read = () => readHarnessSources({ roots: [root], fleetDir: deck, memoryDirs: [mem] });
    expect(harnessPrompt(read(), ctx)).toBe(harnessPrompt(read(), ctx));
  });
});

describe("memory pack", () => {
  test("one file per source plus an index with each note's description", () => {
    const { root, deck, mem } = fixture();
    const pack = memoryPack(readHarnessSources({ roots: [root], fleetDir: deck, memoryDirs: [mem] }), ctx);
    expect([...pack.keys()].sort()).toEqual(["fleet/README.md", "fleet/code-agents.md", "fleet/deck-protocol.md", "fleet/notes/a-note.md", "fleet/notes/b-note.md"]);
    const index = pack.get("fleet/README.md")!;
    expect(index).toContain("- `notes/a-note.md`: first fact: with colon");
    expect(index).toContain("- `notes/b-note.md`: second fact");
    expect(index).toContain("do not edit here");
    expect(pack.get("fleet/code-agents.md")).toBe("# ~/Code\n\nNever commit here.\n");
  });
});
