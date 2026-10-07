import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { linearizeChatgpt, normalizeClaude, toConversation, renderMarkdown, writeArchive, readIndex, detectNeedsLogin, safeId, type Conversation } from "../src/daemon/cloud";
import { validateInput, normalizeUrl } from "../src/daemon/browser";

const CHATGPT = {
  title: "Plan the week",
  create_time: 1759800000,
  update_time: 1759803600,
  default_model_slug: "gpt-5",
  current_node: "n3",
  mapping: {
    root: { id: "root", parent: null, children: ["n0"], message: null },
    n0: { id: "n0", parent: "root", children: ["n1"], message: { author: { role: "system" }, content: { content_type: "text", parts: [""] } } },
    n1: { id: "n1", parent: "n0", children: ["n2", "n2b"], message: { author: { role: "user" }, content: { content_type: "text", parts: ["What should I do Monday?"] } } },
    n2: { id: "n2", parent: "n1", children: ["n3"], message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Start with the hosting revamp.\n\n```sh\ndeck status\n```"] } } },
    n2b: { id: "n2b", parent: "n1", children: [], message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["(an abandoned branch)"] } } },
    n3: { id: "n3", parent: "n2", children: [], message: { author: { role: "user" }, content: { content_type: "multimodal_text", parts: ["Thanks", { asset_pointer: "x" }] } } },
  },
};

const CLAUDE = {
  uuid: "9d1c2d7e-6a1f-4c1b-9a1e-2f3b4c5d6e7f",
  name: "Hosting revamp notes",
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-02T11:30:00.000Z",
  model: "claude-opus-5-5",
  chat_messages: [
    { uuid: "m1", sender: "human", text: "Summarise SeedHost", content: [{ type: "text", text: "Summarise SeedHost" }] },
    { uuid: "m2", sender: "assistant", text: "", content: [{ type: "tool_use", name: "x" }, { type: "text", text: "SeedHost serves sites." }] },
    { uuid: "m3", sender: "system", text: "ignored" },
  ],
};

describe("chatgpt linearisation", () => {
  test("follows the current branch, drops system/empty/abandoned nodes", () => {
    const m = linearizeChatgpt(CHATGPT);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(m[1].text).toContain("```sh\ndeck status\n```");
    expect(m[2].text).toBe("Thanks");
    expect(m.some((x) => x.text.includes("abandoned"))).toBe(false);
  });
  test("falls back to a leaf when current_node is missing", () => {
    const { current_node, ...rest } = CHATGPT;
    expect(linearizeChatgpt(rest).length).toBeGreaterThan(0);
  });
});

describe("claude normalisation", () => {
  test("maps human→user, prefers content[] text, skips non-chat senders", () => {
    const m = normalizeClaude(CLAUDE);
    expect(m).toEqual([{ role: "user", text: "Summarise SeedHost" }, { role: "assistant", text: "SeedHost serves sites." }]);
  });
});

describe("conversation + markdown", () => {
  test("toConversation builds the archive record", () => {
    const c = toConversation("chatgpt", { id: "abc123def456" }, CHATGPT)!;
    expect(c.id).toBe("abc123def456");
    expect(c.url).toBe("https://chatgpt.com/c/abc123def456");
    expect(c.model).toBe("gpt-5");
    expect(c.created).toBe("2025-10-07T01:20:00.000Z"); // epoch seconds are promoted to ms
    const k = toConversation("claude", { uuid: CLAUDE.uuid }, CLAUDE)!;
    expect(k.url).toBe(`https://claude.ai/chat/${CLAUDE.uuid}`);
    expect(k.title).toBe("Hosting revamp notes");
    expect(toConversation("claude", { uuid: "../etc" }, CLAUDE)).toBeNull();
  });
  test("renderMarkdown writes the frontmatter contract and role sections", () => {
    const c = toConversation("claude", { uuid: CLAUDE.uuid }, CLAUDE)!;
    const md = renderMarkdown(c);
    expect(md.startsWith("---\nprovider: claude\nid: " + CLAUDE.uuid + "\ntitle: \"Hosting revamp notes\"\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-02T11:30:00.000Z\nurl: https://claude.ai/chat/" + CLAUDE.uuid + "\nmodel: \"claude-opus-5-5\"\nmessages: 2\n---\n")).toBe(true);
    expect(md).toContain("\n## user\n\nSummarise SeedHost\n");
    expect(md).toContain("\n## assistant\n\nSeedHost serves sites.\n");
  });
});

describe("archive writer", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cloud-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes file + index line; idempotent; updates replace the index row", () => {
    const c = toConversation("claude", { uuid: CLAUDE.uuid }, CLAUDE)!;
    const { file, index } = writeArchive(dir, "yacht", c);
    expect(file).toBe(join(dir, "cloud", "claude", `${CLAUDE.uuid}.md`));
    expect(index).toBe(join(dir, "cloud", "index-claude.jsonl"));
    expect(existsSync(file)).toBe(true);
    writeArchive(dir, "yacht", c);
    let rows = readIndex(index);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: "yacht", tool: "claude-web", id: CLAUDE.uuid, title: "Hosting revamp notes", cwd: "", project: null, started: c.created, updated: c.updated, file, messages: 2, url: c.url });
    const later: Conversation = { ...c, updated: "2026-10-03T00:00:00.000Z", messages: [...c.messages, { role: "user", text: "more" }] };
    writeArchive(dir, "yacht", later);
    rows = readIndex(index);
    expect(rows).toHaveLength(1);
    expect(rows[0].messages).toBe(3);
    expect(readFileSync(file, "utf8")).toContain("## user\n\nmore");
  });
});

describe("needs_login detection", () => {
  test("401/403, login redirects and cloudflare challenges", () => {
    expect(detectNeedsLogin({ status: 401 })).toBe(true);
    expect(detectNeedsLogin({ status: 403 })).toBe(true);
    expect(detectNeedsLogin({ status: 200, url: "https://claude.ai/login?returnTo=/" })).toBe(true);
    expect(detectNeedsLogin({ status: 200, url: "https://chatgpt.com/auth/login" })).toBe(true);
    expect(detectNeedsLogin({ status: 200, contentType: "text/html", body: "<html><title>Just a moment...</title><script src=\"/cdn-cgi/challenge-platform/x\"></script>" })).toBe(true);
    expect(detectNeedsLogin({ status: 200, url: "https://chatgpt.com/backend-api/conversations", contentType: "application/json", body: "{\"items\":[]}" })).toBe(false);
    expect(detectNeedsLogin({ status: 200, url: "https://claude.ai/api/organizations", contentType: "application/json", body: "[]" })).toBe(false);
  });
  test("ids are strict", () => {
    expect(safeId("abc-123_X")).toBe("abc-123_X");
    expect(safeId("a/b")).toBeNull();
    expect(safeId("")).toBeNull();
  });
});

describe("remote browser input validation", () => {
  test("accepts well-formed messages", () => {
    expect(validateInput({ t: "mouse", type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 })).toMatchObject({ t: "mouse", x: 10, y: 20 });
    expect(validateInput({ t: "key", type: "keyDown", key: "a", code: "KeyA", text: "a", modifiers: 0 })).toMatchObject({ t: "key", key: "a" });
    expect(validateInput({ t: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 120 })).toMatchObject({ t: "wheel" });
    expect(validateInput({ t: "nav", url: "chatgpt.com" })).toEqual({ t: "nav", url: "https://chatgpt.com/" });
    expect(validateInput({ t: "resize", w: 1000.4, h: 650 })).toEqual({ t: "resize", w: 1000, h: 650 });
    expect(validateInput({ t: "back" })).toEqual({ t: "back" });
  });
  test("rejects malformed or dangerous messages", () => {
    expect(validateInput(null)).toBeNull();
    expect(validateInput({ t: "mouse", type: "click", x: 1, y: 1 })).toBeNull();
    expect(validateInput({ t: "mouse", type: "mousePressed", x: -1, y: 1 })).toBeNull();
    expect(validateInput({ t: "mouse", type: "mousePressed", x: 1, y: 1, button: "evil" })).toBeNull();
    expect(validateInput({ t: "key", type: "keyDown", key: "x".repeat(40) })).toBeNull();
    expect(validateInput({ t: "nav", url: "javascript:alert(1)" })).toBeNull();
    expect(validateInput({ t: "nav", url: "file:///etc/passwd" })).toBeNull();
    expect(validateInput({ t: "resize", w: 10, h: 10 })).toBeNull();
    expect(validateInput({ t: "exec", cmd: "rm" })).toBeNull();
    expect(normalizeUrl("ftp://x")).toBeNull();
  });
});
