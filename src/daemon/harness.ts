// The Seed harness: what makes a Seed agent on the agents server a peer of the terminal agents
// (cc = Claude Code, cx = Codex) instead of a voice toy. Three things, all derived from files on
// this node so every Cyberdeck instance configures its agent the same way:
//
//   prompt   the system prompt cc and cx effectively run with: a persona and working rules, then
//            the fleet rules (~/Code/AGENTS.md) and the Deck agent protocol (Deck/AGENTS.md) verbatim;
//   memory   a "fleet pack" synced into the agent's ~/memory/fleet/: those two files again (so a
//            session can re-read them), plus Claude Code's project memory notes;
//   tools    the cyberdeck MCP server, which besides the deck tools now carries shell / file /
//            deck_context tools (src/daemon/api/mcp-node.ts) so the agent reaches the machine.
//
// SeedBridge.syncHarness (seed.ts) applies prompt + memory to the agents; this module is pure
// text and file reading so tests can pin the output.
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";

export type HarnessSources = {
  /** The node's fleet rules (AGENTS.md at the first scan root, or CLAUDE.md) and where they came from. */
  rules?: { path: string; text: string };
  /** The Deck agent protocol (fleetDir/AGENTS.md). */
  deck?: { path: string; text: string };
  /** Markdown notes to carry into ~/memory/fleet/notes (name → text). */
  notes: { name: string; path: string; text: string }[];
};

export type HarnessContext = {
  nodeName: string;
  hostname: string;
  /** The MCP server name the agents server prefixes tools with (`cyberdeck` → `cyberdeck__shell`). */
  mcpName: string;
  /** Whether the node tools (shell, files, deck_context) are on this node's MCP server. */
  nodeTools: boolean;
  /** Where the memory pack lives in the agent's space. */
  packDir: string;
};

export const PACK_DIR = "fleet";
const NOTE_LIMIT = 200;
const NOTE_BYTES_MAX = 64 * 1024;
const RULES_BYTES_MAX = 128 * 1024;

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

function readText(path: string, max: number): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const text = readFileSync(path, "utf8");
    return text.length > max ? `${text.slice(0, max)}\n\n[truncated at ${max} bytes]\n` : text;
  } catch {
    return null;
  }
}

/** Read the prompt and memory sources from disk. Missing files are simply absent. */
export function readHarnessSources(opts: { roots: string[]; fleetDir?: string | null; memoryDirs: string[] }): HarnessSources {
  const out: HarnessSources = { notes: [] };
  const root = opts.roots[0];
  if (root) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(root, name);
      const text = readText(path, RULES_BYTES_MAX);
      // A CLAUDE.md that only includes AGENTS.md (`@./AGENTS.md`) is not the rules themselves.
      if (text && !/^\s*@\.?\/?AGENTS\.md\s*$/.test(text)) { out.rules = { path, text }; break; }
    }
  }
  if (opts.fleetDir) {
    const path = join(opts.fleetDir, "AGENTS.md");
    const text = readText(path, RULES_BYTES_MAX);
    if (text) out.deck = { path, text };
  }
  const seen = new Set<string>();
  for (const dir of opts.memoryDirs) {
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").sort(); } catch { continue; }
    for (const n of names) {
      if (out.notes.length >= NOTE_LIMIT) break;
      const name = basename(n, ".md");
      if (seen.has(name)) continue;
      const path = join(dir, n);
      const text = readText(path, NOTE_BYTES_MAX);
      if (!text?.trim()) continue;
      seen.add(name);
      out.notes.push({ name, path, text });
    }
  }
  return out;
}

const stripFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "");
/** The `description:` line of a note's frontmatter, for the pack index. */
function noteSummary(text: string): string {
  const m = text.match(/^---\n[\s\S]*?^description:\s*(.+)$[\s\S]*?\n---/m);
  const s = (m?.[1] ?? stripFrontmatter(text).split("\n").find((l) => l.trim()) ?? "").trim();
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/**
 * The fleet knowledge both agents carry: the node's rules and the Deck protocol, verbatim, under
 * headings that say where each came from. Shared by the harness prompt and the voice persona.
 */
export function knowledgeSection(src: HarnessSources, ctx: Pick<HarnessContext, "nodeName">): string {
  const parts: string[] = [];
  if (src.rules) parts.push(`## Fleet rules (${src.rules.path} on ${ctx.nodeName})\n\nThese are the instructions every coding agent on this machine reads first. They apply to you in full; where they name a terminal command, you run it with the shell tool.\n\n${stripFrontmatter(src.rules.text).trim()}`);
  if (src.deck) parts.push(`## Deck agent protocol (${src.deck.path})\n\n${stripFrontmatter(src.deck.text).trim()}`);
  return parts.join("\n\n");
}

/**
 * The system prompt of the harness agent (the one behind the prompt bar and the Seed view). The
 * voice companion keeps its own spoken persona (seed.ts fleetPrompt) and gets only the knowledge
 * section appended.
 */
export function harnessPrompt(src: HarnessSources, ctx: HarnessContext): string {
  const t = (name: string) => `\`${ctx.mcpName}__${name}\``;
  const tools = ctx.nodeTools
    ? `- **Machine access.** ${t("shell")} runs a command on ${ctx.nodeName} (login shell, so the owner's PATH, mise, bun, go, seed-cli, deck, gh, claude and codex are all there); pass \`host\` to run it on another fleet machine over ssh. ${t("read_file")}, ${t("write_file")}, ${t("edit_file")}, ${t("list_dir")} and ${t("grep")} work on ${ctx.nodeName}'s filesystem directly. Prefer these over \`execute\`: your sandbox is not the machine, and the repos, keys and tools live on the machine. Paths are absolute; \`~\` is the owner's home. The tools are the same reach cc and cx have, so use them with the same care.
- **Bounded results.** Every tool result is cut at about 8 KB before it reaches you. Read files in pieces (\`offset\`/\`limit\`), ask for the tail or head of long output, and when a result says it was saved to an \`outputFile\`, page through that with ${t("read_file")} instead of re-running the command. Never re-run a command only because its output was truncated.`
    : `- **Machine access.** This node's MCP server has no shell or file tools (its owner turned them off); \`execute\` is your only sandbox, and it is not the machine. Say so when a task needs the machine.`;
  return `You are Cyberdeck, Eric's Seed agent on the fleet machine **${ctx.nodeName}** (hostname ${ctx.hostname}). You have the same standing as his terminal coding agents, cc (Claude Code) and cx (Codex): you work in his repos and on his machines, you keep the shared Deck context, and you write organizational work to Seed Hypermedia. People reach you from Cyberdeck's web prompt bar and Seed view, so answers are written: lead with the outcome, keep them short, use markdown where it helps, and link what you cite (hm:// URLs, PRs, paths).

## How you work

- **Orient first.** Start a task with ${t("deck_context")} (the briefing cc and cx run first: host, project for the working directory, handoff entries, inbox, collab tasks). Then ${t("todo")}, ${t("handoff")} and ${t("sessions_search")} when the work may already be in flight. Work from what the tools return, never from memory of how a machine or repo "usually" looks.
- **Turn context.** Each message from the prompt bar arrives with context lines: the fleet machine the user chose, the working directory, its project and git branch. Treat that directory as the cwd of the task${ctx.nodeTools ? ` (pass it as \`cwd\` to ${t("shell")}); it is on ${ctx.nodeName} unless the machine line says otherwise, in which case use \`host\`` : ""}.
${tools}
- **Fleet knowledge.** ${t("status")}, ${t("fleet_status")}, ${t("hosts")}, ${t("services")}, ${t("service_logs")}, ${t("repos")} and ${t("repos_detail")} describe the machines; ${t("collab_add")} / ${t("collab_run")} / ${t("run_log")} hand long work to cc or cx on a laptop and read the result. The fleet rules below say which host owns which project.
- **Memory.** Your \`~/memory/${ctx.packDir}/\` holds the fleet pack Cyberdeck keeps in sync: \`README.md\` (index), \`code-agents.md\` and \`deck-protocol.md\` (the same texts as below, for re-reading mid-session) and \`notes/\` (Claude Code's project memory on this machine: incidents, gotchas, recipes). Read \`~/memory/${ctx.packDir}/README.md\` when a task touches a project you have not looked at this session, then the notes it points at. Do not edit the pack (the sync overwrites it); keep what you learn in \`~/memory/notes/<slug>.md\`, one fact per file with a one-line summary at the top, and update a note rather than adding a near-duplicate.
- **Finish the job.** Do the whole task, verify it (run the tests, load the page, read the log) and report what you actually saw, failures included. Make routine judgment calls yourself; ask only when readings of the request would lead to materially different work. Before anything hard to reverse or outward-facing (force pushes, deletes, deploys, messages to other people, publishing) say what you are about to do and wait for a yes, unless the rules below already authorize it.
- **Leave a trace.** When you pick up, finish or discover work: ${t("todo_add")} / ${t("todo_done")} on the handoff list, ${t("handoff_note")} for ${ctx.nodeName} (or the host you worked on), ${t("note")} for something Eric should see, ${ctx.nodeTools ? `and \`deck sync\` through ${t("shell")} at the end of a piece of work` : "and ask the owner to run `deck sync` when you are done"}. Organizational write-ups (notes, plans, reports, decisions) are Seed documents written with \`seed-cli\` as the rules below describe, linked by their hm:// URL.
- **When a tool fails**, say which and what it returned, retry once if it looks transient, and offer the next step. Say plainly when you do not know.

${knowledgeSection(src, ctx)}`;
}

/** The files of the memory pack (path under ~/memory → content), deterministic for a given source set. */
export function memoryPack(src: HarnessSources, ctx: Pick<HarnessContext, "nodeName" | "packDir">): Map<string, string> {
  const files = new Map<string, string>();
  const index: string[] = [
    `# Fleet pack (${ctx.nodeName})`,
    "",
    `Synced by Cyberdeck on ${ctx.nodeName} from files on that machine; do not edit here (the next sync overwrites it). Keep your own notes in \`~/memory/notes/\`.`,
    "",
  ];
  if (src.rules) { files.set(`${ctx.packDir}/code-agents.md`, src.rules.text); index.push(`- \`code-agents.md\`: the fleet rules every coding agent on ${ctx.nodeName} reads first (from ${src.rules.path}).`); }
  if (src.deck) { files.set(`${ctx.packDir}/deck-protocol.md`, src.deck.text); index.push(`- \`deck-protocol.md\`: the Deck agent protocol (from ${src.deck.path}): session start, handoff, conventions.`); }
  if (src.notes.length) {
    index.push("", `## Notes (${src.notes.length}; Claude Code's project memory on ${ctx.nodeName}, newest facts win)`, "");
    for (const n of src.notes) {
      files.set(`${ctx.packDir}/notes/${n.name}.md`, n.text);
      index.push(`- \`notes/${n.name}.md\`: ${noteSummary(n.text)}`);
    }
  }
  files.set(`${ctx.packDir}/README.md`, index.join("\n") + "\n");
  return files;
}
