import { probeSshArgs } from "../probe";
// Node tools of the MCP server: the reach a terminal agent (cc, cx) has on this machine, offered
// to a Seed agent through the same server as the deck tools. A shell (login shell, so the owner's
// PATH and tools are there; `host` runs it on another fleet machine over ssh), file read / write /
// edit / list / grep on this node, and `deck_context`, the briefing every coding agent runs first.
//
// Two constraints shape every tool here:
//   - the agents server cuts a tool result at about 8 KB before the model sees it, so output is
//     bounded (head or tail, with `offset`/`limit` for files) and long output is also saved to a
//     file under ~/.cyberdeck/tool-output the agent can page through with read_file;
//   - the calls change the machine, so writes and shell commands go to ~/.cyberdeck/audit.log.
// `config.mcp.nodeTools: false` leaves all of this off the server (docs/AGENTS.md).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir, hostname } from "os";
import { dirname, join, resolve } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CyberdeckConfig } from "../config";
import { CYBERDECK_HOME } from "../config";
import { shq } from "../../shared/harness";
import { audit, type ManifestHost } from "../servicectl";
import type { Control } from "./control";

/** What a result may carry as text; the agents server's own cap is 8 KiB on the whole JSON. */
export const RESULT_TEXT_MAX = 6000;
const SHELL_TIMEOUT_DEFAULT = 120;
const SHELL_TIMEOUT_MAX = 600;
const OUTPUT_KEEP_BYTES = 4 * 1024 * 1024;
const LIST_MAX = 400;
const GREP_MAX = 200;

type Text = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: true };
const text = (value: Record<string, unknown>): Text => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value });
const fail = (message: string): Text => ({ content: [{ type: "text", text: message }], isError: true });

/** Expand a leading `~` and make the path absolute (relative to the owner's home, never the daemon's cwd). */
export function expandPath(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return resolve(home, p);
}

/** Cut `s` to `max` characters from the head or the tail, saying how much went missing. */
export function bound(s: string, max: number, keep: "head" | "tail" = "tail"): { text: string; truncated: boolean; dropped: number } {
  if (s.length <= max) return { text: s, truncated: false, dropped: 0 };
  const dropped = s.length - max;
  return keep === "tail"
    ? { text: `[... ${dropped} characters dropped from the start ...]\n${s.slice(-max)}`, truncated: true, dropped }
    : { text: `${s.slice(0, max)}\n[... ${dropped} characters dropped from the end ...]`, truncated: true, dropped };
}

const outputDir = () => process.env.CYBERDECK_TOOL_OUTPUT_DIR ?? join(CYBERDECK_HOME, "tool-output");
/** Keep full output on disk so the agent can page through it; returns the file, or null when it failed. */
function keepOutput(name: string, body: string): string | null {
  try {
    const dir = outputDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(file, body.length > OUTPUT_KEEP_BYTES ? body.slice(-OUTPUT_KEEP_BYTES) : body, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

export type ShellTarget = { host: string; local: boolean; ssh: string | null };

/** Pick where a command runs: this node (host omitted or ours) or a manifest host with an ssh alias. */
export function resolveShellHost(hosts: ManifestHost[], me: string, host: string | undefined): ShellTarget | { error: string } {
  if (!host || host.toLowerCase() === me.toLowerCase() || host.toLowerCase() === hostname().toLowerCase()) return { host: me, local: true, ssh: null };
  const h = hosts.find((x) => x.name.toLowerCase() === host.toLowerCase());
  if (!h) return { error: `No fleet host named "${host}". Known: ${hosts.map((x) => x.name).join(", ") || "none (this node has no Deck checkout)"}.` };
  if (!h.ssh) return { error: `${h.name} has no ssh alias in the fleet manifest, so commands cannot run there from here.` };
  return { host: h.name, local: false, ssh: h.ssh };
}

export type ShellResult = { host: string; cwd: string; code: number | null; timedOut: boolean; durationMs: number; stdout: string; stderr: string };

/**
 * Run `command` through the owner's login shell (so PATH, mise, aliases-free functions are set up
 * like a terminal's), in `cwd`, locally or over ssh. Output is captured whole, then bounded by the caller.
 */
export async function runShell(t: ShellTarget, command: string, cwd: string, timeoutSec: number, env: NodeJS.ProcessEnv = process.env): Promise<ShellResult> {
  const sshBin = () => env.CYBERDECK_SSH ?? "ssh";
  // The login shell is the remote user's; `cd` first so a missing directory fails loudly instead of running in $HOME.
  const script = `cd ${shq(cwd)} || exit 97\nexec "\${SHELL:-/bin/sh}" -lc ${shq(command)}\n`;
  // Locally the command runs in its own process group (perl's setpgid; every macOS and Linux box has
  // perl) so a timeout kills the whole tree, not just the shell, and the output pipes close.
  const perl = t.local ? Bun.which("perl", { PATH: `${env.PATH ?? ""}:/usr/bin:/bin` }) : null;
  const route = !t.local && !env.CYBERDECK_SSH ? probeSshArgs(t.host) : null;
  const argv = t.local
    ? perl ? [perl, "-e", "use POSIX; POSIX::setpgid(0, 0); exec @ARGV or die $!", "--", "/bin/sh", "-s"] : ["/bin/sh", "-s"]
    : [sshBin(), ...(route ?? ["-o", "ConnectTimeout=8", "-o", "BatchMode=yes", t.ssh!]), "sh", "-s"];
  const started = Date.now();
  const p = Bun.spawn(argv, { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe", env: { ...env, CYBERDECK_MCP: "1" }, cwd: t.local && existsSync(cwd) ? cwd : undefined });
  let timedOut = false;
  const killTree = () => { try { if (perl) process.kill(-p.pid, "SIGKILL"); else p.kill("SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
  const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutSec * 1000);
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
    return Buffer.concat(chunks).toString("utf8");
  };
  const both = Promise.all([read(p.stdout), read(p.stderr)]);
  // A surviving grandchild (over ssh, say) can hold the pipe open after the kill; give up on it after a moment.
  const [stdout, stderr] = await Promise.race([both, new Promise<[string, string]>((res) => setTimeout(() => res(["", ""]), (timeoutSec + 3) * 1000))]);
  clearTimeout(timer);
  const code = await Promise.race([p.exited, new Promise<number>((res) => setTimeout(() => { killTree(); res(-1); }, 2000))]);
  return { host: t.host, cwd, code: timedOut ? null : code, timedOut, durationMs: Date.now() - started, stdout, stderr };
}

export type NodeToolDeps = {
  /** Manifest hosts (from the Deck repo); empty when this node has none. */
  hosts: () => Promise<ManifestHost[]>;
  /** `deck context [dir]` text, or null when this node has no Deck checkout. */
  deckContext: (dir?: string) => Promise<{ code: number; out: string; err: string } | null>;
  env?: NodeJS.ProcessEnv;
};

const BRIEF = z.boolean().default(false).describe("Voice mode: one spoken sentence instead of the data");
const spoken = (brief: boolean, sentence: string, value: Record<string, unknown>) => (brief ? text({ brief: sentence }) : text({ brief: sentence, ...value }));

export function registerNodeTools(server: McpServer, cfg: CyberdeckConfig, control: Pick<Control, "fleetDir">, deps: NodeToolDeps): string[] {
  const me = cfg.nodeName;
  const env = deps.env ?? process.env;

  server.tool(
    "shell",
    `Run a shell command on ${me} (or on another fleet host over ssh with \`host\`) through the owner's login shell, in \`cwd\`. Returns exit code, stdout and stderr, bounded to about ${RESULT_TEXT_MAX} characters (the full output is saved to \`outputFile\`; page through it with read_file instead of re-running). No TTY: nothing interactive. Every call is audited.`,
    {
      command: z.string().min(1).max(20_000).describe("The command line, as you would type it in a terminal"),
      cwd: z.string().max(1024).default("~").describe("Working directory (absolute or ~/…); default the owner's home"),
      host: z.string().max(64).optional().describe("Fleet host name to run on instead of this node (needs an ssh alias in the manifest)"),
      timeoutSec: z.number().int().min(1).max(SHELL_TIMEOUT_MAX).default(SHELL_TIMEOUT_DEFAULT).describe(`Kill after this many seconds (max ${SHELL_TIMEOUT_MAX})`),
      keep: z.enum(["tail", "head"]).default("tail").describe("Which end of long output to return"),
      brief: BRIEF,
    },
    async ({ command, cwd, host, timeoutSec, keep, brief }) => {
      const t = resolveShellHost(await deps.hosts(), me, host);
      if ("error" in t) return fail(t.error);
      const dir = t.local ? expandPath(cwd) : cwd;
      audit({ at: new Date().toISOString(), by: "mcp", tool: "shell", host: t.host, cwd: dir, command: command.slice(0, 2000) });
      const r = await runShell(t, command, dir, timeoutSec, env);
      const all = r.stdout + (r.stderr ? (r.stdout && !r.stdout.endsWith("\n") ? "\n" : "") + r.stderr : "");
      const out = bound(r.stdout, RESULT_TEXT_MAX, keep);
      const err = bound(r.stderr, Math.max(600, RESULT_TEXT_MAX - out.text.length), keep);
      const outputFile = out.truncated || err.truncated ? keepOutput("shell", all) : null;
      const status = r.timedOut ? `timed out after ${timeoutSec}s` : r.code === 97 ? `could not cd to ${dir}` : `exit ${r.code}`;
      const sentence = `${command.length > 60 ? `${command.slice(0, 57)}...` : command} on ${t.host}: ${status} in ${(r.durationMs / 1000).toFixed(1)}s${out.truncated ? ", output truncated" : ""}.`;
      return spoken(brief, sentence, { host: t.host, cwd: dir, command, code: r.code, timedOut: r.timedOut, durationMs: r.durationMs, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated, ...(outputFile ? { outputFile } : {}) });
    }
  );

  server.tool(
    "read_file",
    `Read a text file on ${me}, numbered lines like \`cat -n\`, from \`offset\` (1-based line) for up to \`limit\` lines; the result says where to continue. Use it for source files, logs and the outputFile of a long shell result.`,
    {
      path: z.string().min(1).max(2048).describe("Absolute path or ~/…"),
      offset: z.number().int().min(1).default(1).describe("First line to return (1-based)"),
      limit: z.number().int().min(1).max(2000).default(200).describe("Lines to return"),
      brief: BRIEF,
    },
    async ({ path, offset, limit, brief }) => {
      const file = expandPath(path);
      let st;
      try { st = statSync(file); } catch { return fail(`No such file: ${file}`); }
      if (st.isDirectory()) return fail(`${file} is a directory; use list_dir`);
      if (st.size > 64 * 1024 * 1024) return fail(`${file} is ${st.size} bytes; read it with shell (sed -n) instead`);
      const raw = readFileSync(file);
      if (raw.subarray(0, 8000).includes(0)) return fail(`${file} looks binary (${st.size} bytes)`);
      const lines = raw.toString("utf8").split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      let body = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
      let cut = false;
      if (body.length > RESULT_TEXT_MAX) {
        // Keep whole lines under the cap so the next offset is exact.
        let n = 0, len = 0;
        for (const l of slice) { const add = l.length + 8; if (len + add > RESULT_TEXT_MAX) break; len += add; n++; }
        body = slice.slice(0, Math.max(1, n)).map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
        slice.length = Math.max(1, n);
        cut = true;
      }
      const next = offset + slice.length;
      const more = next <= lines.length;
      return spoken(brief, `${file}: lines ${offset}-${next - 1} of ${lines.length}${more ? `, continue at ${next}` : ""}.`, { path: file, totalLines: lines.length, offset, returned: slice.length, ...(more ? { nextOffset: next } : {}), ...(cut ? { truncated: true } : {}), content: body });
    }
  );

  server.tool(
    "write_file",
    `Create or overwrite a text file on ${me} with \`content\` (parent directories are created). Audited. For a small change inside an existing file use edit_file.`,
    { path: z.string().min(1).max(2048).describe("Absolute path or ~/…"), content: z.string().max(4 * 1024 * 1024), brief: BRIEF },
    async ({ path, content, brief }) => {
      const file = expandPath(path);
      const existed = existsSync(file);
      try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); } catch (e) { return fail(`write failed: ${e instanceof Error ? e.message : e}`); }
      audit({ at: new Date().toISOString(), by: "mcp", tool: "write_file", path: file, bytes: content.length, existed });
      return spoken(brief, `${existed ? "Overwrote" : "Created"} ${file} (${content.length} characters).`, { path: file, bytes: content.length, existed });
    }
  );

  server.tool(
    "edit_file",
    `Replace one exact occurrence of \`old\` in a text file on ${me} with \`new\` (\`replaceAll\` for every occurrence). Refuses when \`old\` is missing or matches more than once, so include enough surrounding lines to be unique. Audited.`,
    {
      path: z.string().min(1).max(2048).describe("Absolute path or ~/…"),
      old: z.string().min(1).max(200_000).describe("Exact text to find, whitespace included"),
      new: z.string().max(200_000).describe("Replacement text"),
      replaceAll: z.boolean().default(false),
      brief: BRIEF,
    },
    async ({ path, old, new: next, replaceAll, brief }) => {
      const file = expandPath(path);
      let src: string;
      try { src = readFileSync(file, "utf8"); } catch { return fail(`No such file: ${file}`); }
      if (old === next) return fail("old and new are identical");
      const count = src.split(old).length - 1;
      if (count === 0) return fail(`old text not found in ${file}; read the file and copy the exact text (whitespace included)`);
      if (count > 1 && !replaceAll) return fail(`old text occurs ${count} times in ${file}; add surrounding lines to make it unique, or pass replaceAll`);
      const out = replaceAll ? src.split(old).join(next) : src.replace(old, () => next);
      try { writeFileSync(file, out); } catch (e) { return fail(`write failed: ${e instanceof Error ? e.message : e}`); }
      audit({ at: new Date().toISOString(), by: "mcp", tool: "edit_file", path: file, replaced: replaceAll ? count : 1 });
      const line = src.slice(0, src.indexOf(old)).split("\n").length;
      return spoken(brief, `Edited ${file}: ${replaceAll ? `${count} occurrences` : `1 occurrence at line ${line}`} replaced.`, { path: file, replaced: replaceAll ? count : 1, line });
    }
  );

  server.tool(
    "list_dir",
    `List a directory on ${me}: entries with type and size, sorted, directories first; \`depth\` 2 or 3 walks into subdirectories (junk dirs such as node_modules and .git are skipped). At most ${LIST_MAX} entries.`,
    { path: z.string().min(1).max(2048).default("~"), depth: z.number().int().min(1).max(3).default(1), brief: BRIEF },
    async ({ path, depth, brief }) => {
      const root = expandPath(path);
      let st;
      try { st = statSync(root); } catch { return fail(`No such directory: ${root}`); }
      if (!st.isDirectory()) return fail(`${root} is a file; use read_file`);
      const skip = new Set([...cfg.junkDirs, ...cfg.skipDirs]);
      const entries: { path: string; type: "dir" | "file" | "link" | "other"; size?: number }[] = [];
      let truncated = false;
      const walk = (dir: string, rel: string, level: number) => {
        let names: import("fs").Dirent[];
        try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const d of names) {
          if (entries.length >= LIST_MAX) { truncated = true; return; }
          const p = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) {
            entries.push({ path: `${p}/`, type: "dir" });
            if (level < depth && !skip.has(d.name)) walk(join(dir, d.name), p, level + 1);
          } else if (d.isSymbolicLink()) entries.push({ path: p, type: "link" });
          else if (d.isFile()) { let size: number | undefined; try { size = statSync(join(dir, d.name)).size; } catch {} entries.push({ path: p, type: "file", size }); }
          else entries.push({ path: p, type: "other" });
        }
      };
      walk(root, "", 1);
      const dirs = entries.filter((e) => e.type === "dir").length;
      return spoken(brief, `${root}: ${entries.length} entries (${dirs} directories)${truncated ? ", more not shown" : ""}.`, { path: root, depth, count: entries.length, truncated, entries });
    }
  );

  server.tool(
    "grep",
    `Search file contents on ${me} for a regular expression (ripgrep when installed, else grep -rn), under \`path\`, optionally only files matching \`glob\` (e.g. *.ts). Returns file:line:text matches, at most \`limit\`; junk dirs are skipped.`,
    {
      pattern: z.string().min(1).max(2000).describe("Regular expression (ripgrep / grep -E syntax)"),
      path: z.string().min(1).max(2048).default("~/Code").describe("Directory or file to search"),
      glob: z.string().max(200).optional().describe("Only files whose name matches this glob"),
      ignoreCase: z.boolean().default(false),
      limit: z.number().int().min(1).max(GREP_MAX).default(60),
      brief: BRIEF,
    },
    async ({ pattern, path, glob, ignoreCase, limit, brief }) => {
      const root = expandPath(path);
      if (!existsSync(root)) return fail(`No such path: ${root}`);
      const skip = [...new Set([...cfg.junkDirs, ...cfg.skipDirs])];
      const rg = Bun.which("rg", { PATH: `${env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` });
      const argv = rg
        ? [rg, "-n", "--no-heading", "--color", "never", "-m", String(limit + 1), ...(ignoreCase ? ["-i"] : []), ...(glob ? ["-g", glob] : []), ...skip.flatMap((d) => ["-g", `!${d}`]), "-e", pattern, root]
        : ["grep", "-rnE", ...(ignoreCase ? ["-i"] : []), ...(glob ? [`--include=${glob}`] : []), ...skip.map((d) => `--exclude-dir=${d}`), "-e", pattern, root];
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env });
      const timer = setTimeout(() => p.kill(), 30_000);
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      clearTimeout(timer);
      const code = await p.exited;
      if (code > 1) return fail(`search failed (${rg ? "rg" : "grep"} exit ${code}): ${err.trim().slice(0, 500)}`);
      const lines = out.split("\n").filter(Boolean);
      const matches = lines.slice(0, limit).map((l) => (l.startsWith(`${root}/`) ? l.slice(root.length + 1) : l));
      const body = bound(matches.join("\n"), RESULT_TEXT_MAX, "head");
      const files = new Set(matches.map((l) => l.split(":")[0])).size;
      return spoken(brief, `${matches.length}${lines.length > limit ? "+" : ""} matches in ${files} files under ${root}.`, { path: root, pattern, tool: rg ? "rg" : "grep", matches: matches.length, truncated: lines.length > limit || body.truncated, results: body.text });
    }
  );

  server.tool(
    "deck_context",
    `The briefing every coding agent on this fleet runs first (\`deck context\`): this host, the project owning \`dir\`, handoff entries mentioning it, the inbox, and the collab tasks. Call it at the start of a task.`,
    { dir: z.string().max(1024).optional().describe("Working directory to brief for (absolute or ~/…); default the owner's Code root"), brief: BRIEF },
    async ({ dir, brief }) => {
      const r = await deps.deckContext(dir ? expandPath(dir) : undefined);
      if (!r) return fail("This node has no Deck checkout (config fleetDir), so there is no deck context here. Ask a laptop node, or read ~/Code/AGENTS.md with read_file.");
      if (r.code !== 0 && !r.out.trim()) return fail(`deck context failed: ${r.err.trim().slice(0, 500) || "no output"}`);
      const body = bound(r.out, RESULT_TEXT_MAX, "head");
      const file = body.truncated ? keepOutput("deck-context", r.out) : null;
      const first = r.out.split("\n").find((l) => l.trim()) ?? "";
      return spoken(brief, first ? `Deck context: ${first.trim()}` : "Deck context is empty.", { dir: dir ? expandPath(dir) : null, context: body.text, truncated: body.truncated, ...(file ? { outputFile: file } : {}) });
    }
  );

  return ["shell", "read_file", "write_file", "edit_file", "list_dir", "grep", "deck_context"];
}
