// Auto harness selector: turns a free-text prompt plus UI context into a concrete
// launch plan (which machine, which agent, which directory, which runner) with
// human-readable reasons for every choice. Pure and dependency-free so the UI and
// the daemon share it and tests can pin the rules.
//
// Prompt syntax understood (all optional, all stripped from the prompt):
//   $ ls -la            plain shell command (no agent)
//   cc: …  /  cx: …     force Claude Code / Codex
//   @yacht              run on that node (by name)
//   #seed               run in that project's or repo's directory
// Plain words also count: "codex", "claude", a host name, a project or repo name.

export type Tool = "seed" | "cc" | "cx" | "shell";
export type Runner = "agent" | "tmux" | "pty";
export type Caps = { seed?: boolean; seedUrl?: string; cc: boolean; cx: boolean; tmux: boolean; cmux: boolean };

export type PlanNode = { id: string; name: string; online: boolean; caps?: Caps | null };
export type PlanProject = { slug: string; name: string; repos: string[]; hosts: string[] };
/** A git checkout the daemon on `node` has indexed (every repo, not only ones a Deck project claims). */
export type PlanRepo = { node: string; name: string; path: string };
export type PlanContext = { node: string; cwd?: string | null; project?: string | null };
export type PlanOverrides = { node?: string; tool?: Tool; cwd?: string; runner?: Runner };

export type PlanInput = {
  prompt: string;
  context: PlanContext;
  /** All nodes including self; self has id "" (the UI's "local"). */
  nodes: PlanNode[];
  projects: PlanProject[];
  repos?: PlanRepo[];
  overrides?: PlanOverrides;
  /** Default agent when nothing else decides (user preference). */
  defaultTool?: "seed" | "cc" | "cx";
};

export type Plan = {
  node: string;
  nodeName: string;
  contextNodeName: string;
  tool: Tool;
  cwd: string;
  runner: Runner;
  /** The prompt with routing tokens removed (what the agent receives). */
  prompt: string;
  /** Shell command typed into the new session; empty for a bare shell. */
  cmd: string;
  title: string;
  reasons: string[];
  /** Which fields were fixed by the user rather than inferred. */
  pinned: (keyof PlanOverrides)[];
  error?: string;
};

export const AGENT_CMDS: Record<"cc" | "cx", string> = {
  cc: "claude --dangerously-skip-permissions",
  cx: "codex --yolo",
};

/** POSIX single-quote shell quoting. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const launchCmd = (tool: "cc" | "cx", prompt?: string) => (prompt ? `${AGENT_CMDS[tool]} ${shq(prompt)}` : AGENT_CMDS[tool]);
export const resumeCmd = (tool: "cc" | "cx", id: string) => (tool === "cc" ? `${AGENT_CMDS.cc} --resume ${shq(id)}` : `${AGENT_CMDS.cx} resume ${shq(id)}`);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string) => new RegExp(`(^|[^\\w/-])${esc(w)}(?=$|[^\\w/-])`, "i");
const repoName = (glob: string) => glob.replace(/[/*].*$/, "");

export function shortCwd(cwd: string): string {
  return (cwd || "~").replace(/^\/(Users|home)\/[^/]+/, "~");
}

export function planHarness(input: PlanInput): Plan {
  const reasons: string[] = [];
  const pinned: (keyof PlanOverrides)[] = [];
  const ov = input.overrides ?? {};
  const nodes = input.nodes;
  const self = nodes.find((n) => n.id === "") ?? { id: "", name: "local", online: true };
  const findNode = (name: string) => nodes.find((n) => n.name.toLowerCase() === name.toLowerCase());

  let text = input.prompt.trim();
  let tool: Tool | null = null;
  let shellCmd: string | null = null;
  let node: PlanNode | null = null;
  let project: PlanProject | null = null;
  let repo: string | null = null; // a specific repo named in the prompt
  let scanned: PlanRepo | null = null; // an indexed checkout named in the prompt
  let cwd: string | null = null;
  const repos = input.repos ?? [];
  const nodeOk = (id: string) => { const n = nodes.find((x) => x.id === id); return !!n && (n.id === "" || n.online); };
  /** Prefer a checkout on the current node, then any online node. */
  const pickRepo = (cands: PlanRepo[]): PlanRepo | null => cands.find((r) => r.node === input.context.node) ?? cands.find((r) => nodeOk(r.node)) ?? null;

  // ---- explicit syntax ----
  const shell = text.match(/^[$!]\s+(.+)$/s);
  if (shell) { shellCmd = shell[1].trim(); tool = "shell"; text = ""; reasons.push("`$` prefix: plain shell command, no agent"); }
  const prefix = text.match(/^(seed|cc|cx|claude|codex)\s*:\s*/i);
  if (prefix && !tool) { tool = prefix[1].toLowerCase() === "seed" ? "seed" : /^c(c|laude)/i.test(prefix[1]) ? "cc" : "cx"; text = text.slice(prefix[0].length); reasons.push(`${prefix[1]}: prefix`); }
  text = text.replace(/(^|\s)@([\w.-]+)/g, (m, sp, name) => {
    const n = findNode(name);
    if (!n) return m;
    node = n; reasons.push(`@${name}: run on ${n.name}`);
    return sp;
  });
  text = text.replace(/(^|\s)#([\w.-]+)/g, (m, sp, tag) => {
    const p = input.projects.find((x) => x.slug.toLowerCase() === tag.toLowerCase() || x.name.toLowerCase() === tag.toLowerCase() || x.repos.some((r) => repoName(r).toLowerCase() === tag.toLowerCase()));
    if (p) {
      project = p; reasons.push(`#${tag}: project ${p.name}`);
      repo = p.repos.map(repoName).find((r) => r.toLowerCase() === tag.toLowerCase()) ?? null;
      return sp;
    }
    const r = pickRepo(repos.filter((x) => x.name.toLowerCase() === tag.toLowerCase()));
    if (!r) return m;
    scanned = r; reasons.push(`#${tag}: checkout ${shortCwd(r.path)}`);
    return sp;
  });
  text = text.replace(/\s{2,}/g, " ").trim();

  // ---- natural mentions ----
  if (!tool) {
    const cx = text.search(/\bcodex\b|\bcx\b/i), cc = text.search(/\bclaude\b|\bcc\b/i);
    if (cx >= 0 && (cc < 0 || cx < cc)) { tool = "cx"; reasons.push("mentions Codex"); }
    else if (cc >= 0) { tool = "cc"; reasons.push("mentions Claude"); }
  }
  if (!node && text) {
    for (const n of nodes) if (n.name.length >= 3 && wordRe(n.name).test(text)) { node = n; reasons.push(`mentions ${n.name}`); break; }
  }
  if (!project && text) {
    let best: { p: PlanProject; len: number; repo: string | null } | null = null;
    for (const p of input.projects) {
      const names: [string, string | null][] = [[p.name, null], [p.slug.split("/").pop() ?? p.slug, null], ...p.repos.map(repoName).map((r): [string, string | null] => [r, r])];
      for (const [needle, r] of names) {
        if (needle.length < 3 || /\*/.test(needle)) continue;
        if (wordRe(needle).test(text) && (!best || needle.length > best.len)) best = { p, len: needle.length, repo: r };
      }
    }
    if (best) { project = best.p; repo = best.repo; reasons.push(best.repo ? `mentions ${best.repo} (${best.p.name})` : `mentions ${best.p.name}`); }
    // Any indexed checkout counts too (a longer repo name beats a shorter project match).
    let bestRepo: { r: PlanRepo; len: number } | null = null;
    const seen = new Set<string>();
    for (const r of repos) {
      const key = r.name.toLowerCase();
      if (r.name.length < 3 || seen.has(key) || (best && best.len >= r.name.length)) continue;
      if (!wordRe(r.name).test(text)) continue;
      seen.add(key);
      const pick = pickRepo(repos.filter((x) => x.name.toLowerCase() === key));
      if (pick && (!bestRepo || r.name.length > bestRepo.len)) bestRepo = { r: pick, len: r.name.length };
    }
    if (bestRepo) { scanned = bestRepo.r; project = null; repo = null; reasons.push(`mentions ${bestRepo.r.name} (checkout on ${nodes.find((n) => n.id === bestRepo!.r.node)?.name ?? "node"})`); }
  }

  // ---- context fallbacks ----
  if (!project && input.context.project) {
    const p = input.projects.find((x) => x.slug === input.context.project);
    if (p) { project = p; reasons.push(`current project ${p.name}`); }
  }
  const projRepo = repo ?? (project ? (project as PlanProject).repos.map(repoName).find((r) => r && !r.includes("*")) : null);

  // ---- node ----
  if (ov.node !== undefined) { node = nodes.find((n) => n.id === ov.node) ?? self; pinned.push("node"); }
  else if (!node && scanned) node = nodes.find((n) => n.id === (scanned as PlanRepo).node) ?? self;
  else if (!node) {
    const current = nodes.find((n) => n.id === input.context.node) ?? self;
    const hosts = project ? (project as PlanProject).hosts : [];
    if (hosts.length && !hosts.some((h) => h.toLowerCase() === current.name.toLowerCase())) {
      const target = hosts.map(findNode).find((n) => n && n.online);
      if (target) { node = target; reasons.push(`${(project as PlanProject).name} lives on ${target.name}`); }
    }
    if (!node) node = current;
  }
  if (node && node.id !== "" && !node.online && (ov.tool ?? tool ?? input.defaultTool ?? "seed") !== "seed") { reasons.push(`${node.name} is offline; using ${self.name}`); node = self; }
  node = node ?? self;

  // ---- cwd ----
  if (ov.cwd !== undefined) { cwd = ov.cwd; pinned.push("cwd"); }
  else if (scanned && (scanned as PlanRepo).node === node.id) cwd = (scanned as PlanRepo).path;
  else if (scanned) cwd = `~/Code/${(scanned as PlanRepo).name}`;
  else if (projRepo) cwd = `~/Code/${projRepo}`;
  else if (input.context.cwd && (node.id === input.context.node)) { cwd = input.context.cwd; reasons.push(`current directory ${shortCwd(cwd)}`); }
  else cwd = "~/Code";

  const contextNodeName = node.name;

  // Seed queries run on a ready agents server, independently of local CLI availability.
  if (ov.tool !== undefined) { tool = ov.tool; pinned.push("tool"); }
  else if (!tool) {
    tool = input.defaultTool ?? "seed";
    const available = node.caps;
    if ((tool === "cc" || tool === "cx") && available && !available[tool] && available[tool === "cc" ? "cx" : "cc"]) {
      reasons.push(`${tool} is not installed on ${node.name}`);
      tool = tool === "cc" ? "cx" : "cc";
    } else reasons.push(`default ${tool}`);
  }
  let error: string | undefined;
  if (tool === "seed" && (!node.online || !node.caps?.seed)) {
    const explicitNode = ov.node !== undefined || reasons.some((r) => r.startsWith("@"));
    const server = !explicitNode && nodes.find((n) => n.online && n.caps?.seed);
    if (server) { node = server; reasons.push(`Seed agents server on ${server.name}`); }
    else error = `No ready Seed agents server${explicitNode ? ` on ${node.name}` : ""}. Configure Seed on a fleet node or choose another agent.`;
  }
  const caps = node.caps ?? null;
  if (tool !== "seed" && tool !== "shell" && caps && !caps[tool]) reasons.push(`warning: ${tool} not found on ${node.name}`);

  let runner: Runner;
  if (tool === "seed") runner = "agent";
  else if (ov.runner !== undefined && ov.runner !== "agent") { runner = ov.runner; pinned.push("runner"); }
  else if (caps?.tmux) { runner = "tmux"; reasons.push("tmux: survives daemon restarts"); }
  else { runner = "pty"; if (caps) reasons.push("no tmux: session ends if the daemon restarts"); }

  // Tool pinned to shell (or chosen by caps) with no `$` prefix: the text itself is the command.
  if (tool === "shell" && shellCmd === null && text) { shellCmd = text; text = ""; reasons.push("shell: the text runs as a command"); }
  const prompt = text;
  const cmd = tool === "seed" ? "" : tool === "shell" ? (shellCmd ?? "") : launchCmd(tool, prompt || undefined);
  const base = (cwd ?? "~").split("/").filter(Boolean).pop() ?? "~";
  const gist = (tool === "shell" ? shellCmd ?? "" : prompt).replace(/\s+/g, " ").trim();
  const title = `${tool === "shell" ? "sh" : tool} ${gist ? gist.slice(0, 32) : base}`;

  return { node: node.id, nodeName: node.name, contextNodeName, tool, cwd: cwd ?? "~", runner, prompt, cmd, title, reasons, pinned, error };
}
