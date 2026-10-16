import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Hono } from "hono";
import { SteamClient, type ClientGame } from "./steam-client";
import type { SteamGame, SteamLibrary, SteamSession } from "../../shared/steam";

type Vdf = { [key: string]: string | Vdf };
/** Steam's text KeyValues format. No executable config or authentication files are read. */
export function parseVdf(text: string): Vdf {
  if (text.length > 2 * 1024 * 1024) throw new Error("Steam manifest too large");
  const tokens = text.match(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|[{}]|[^\s{}"]+/g)?.filter(t => !t.startsWith("//")) ?? [];
  let i = 0;
  const string = (t: string) => t.startsWith('"') ? t.slice(1, -1).replace(/\\([\\"])/g, "$1") : t;
  function object(depth: number): Vdf {
    if (depth > 16) throw new Error("Steam manifest nesting too deep");
    const result: Vdf = Object.create(null);
    while (i < tokens.length && tokens[i] !== "}") {
      const key = tokens[i++], value = tokens[i++];
      if (!key || key === "{" || !value || value === "}") throw new Error("Invalid Steam manifest");
      if (value === "{") {
        result[string(key)] = object(depth + 1);
        if (tokens[i++] !== "}") throw new Error("Invalid Steam manifest");
      } else result[string(key)] = string(value);
    }
    return result;
  }
  const result = object(0);
  if (i !== tokens.length) throw new Error("Invalid Steam manifest");
  return result;
}
const obj = (value: string | Vdf | undefined): Vdf => typeof value === "object" ? value : Object.create(null);
const appId = (id: string) => /^[1-9]\d{0,9}$/.test(id);
async function manifest(file: string) {
  if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error("Steam manifest too large");
  return parseVdf(await readFile(file, "utf8"));
}
export async function readSteamGames(roots: string[]): Promise<{ games: SteamGame[]; warnings: string[] }> {
  const libraries = new Set<string>(), warnings: string[] = [];
  for (const root of roots) {
    try { libraries.add(await realpath(join(root, "steamapps"))); } catch { continue; }
    try {
      const folders = obj((await manifest(join(root, "steamapps/libraryfolders.vdf"))).libraryfolders);
      for (const [index, entry] of Object.entries(folders)) {
        if (!/^\d+$/.test(index)) continue;
        const path = typeof entry === "string" ? entry : entry.path;
        if (typeof path === "string" && isAbsolute(path)) libraries.add(join(path, "steamapps"));
      }
    } catch (e: any) { if (e.code !== "ENOENT") warnings.push("A Steam library index could not be read."); }
  }
  const games = new Map<string, SteamGame>();
  for (const library of libraries) {
    let files: string[];
    try { files = await readdir(library); }
    catch { warnings.push("A Steam library is offline or inaccessible."); continue; }
    for (const file of files.filter(f => /^appmanifest_[1-9]\d{0,9}\.acf$/.test(f)).slice(0, 10000)) {
      try {
        const state = obj((await manifest(join(library, file))).AppState);
        const id = file.slice(12, -4);
        if (state.appid !== id || typeof state.name !== "string" || !state.name.trim()) continue;
        // Steam validates ownership, installation, updates and Proton compatibility when opening a game.
        const flags = Number(state.StateFlags);
        games.set(id, { id, name: state.name.slice(0, 300), ready: Number.isFinite(flags) && (flags & 4) !== 0 });
      } catch { warnings.push("A Steam game manifest could not be read; other games are still available."); }
    }
  }
  return { games: [...games.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings: [...new Set(warnings)] };
}

export type SteamClientPort = Pick<SteamClient, "library" | "play" | "resume" | "stop" | "install" | "installation" | "continueInstall" | "cancelInstall" | "background" | "actions" | "respond" | "cancelLaunch">;
type Options = {
  platform?: string; home?: string; env?: NodeJS.ProcessEnv;
  command?: () => Promise<string[] | null>;
  launch?: (argv: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  client?: SteamClientPort | null;
  desktop?: () => Promise<void>;
  monitor?: boolean;
};
export class Steam {
  private platform: string;
  private home: string;
  private env: NodeJS.ProcessEnv;
  private client: SteamClientPort | null;
  private opening = false;
  private session: SteamSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private started = 0;
  private sawRunning = false;
  private returned = false;
  private cache: { at: number; games: ClientGame[] } | null = null;
  constructor(private node: string, private options: Options = {}) {
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.client = options.client === undefined ? (options.launch ? null : new SteamClient()) : options.client;
  }
  private async command(): Promise<string[] | null> {
    if (this.options.command) return this.options.command();
    const native = Bun.which("steam") ?? (["/usr/games/steam", "/usr/bin/steam"].find(p => Bun.which(p)));
    if (native) return [native];
    const flatpak = Bun.which("flatpak");
    if (flatpak) {
      const check = Bun.spawn([flatpak, "info", "com.valvesoftware.Steam"], { stdout: "ignore", stderr: "ignore" });
      if (await check.exited === 0) return [flatpak, "run", "com.valvesoftware.Steam"];
    }
    return null;
  }
  private async clientGames(force = false) {
    if (!this.client) throw new Error("Steam bridge not connected");
    if (!force && this.cache && Date.now() - this.cache.at < 2500) return this.cache.games;
    const games = await this.client.library();
    this.cache = { at: Date.now(), games }; return games;
  }
  async library(): Promise<SteamLibrary> {
    const supported = this.platform === "linux";
    const display = Boolean(this.env.DISPLAY || this.env.WAYLAND_DISPLAY);
    const installed = supported && Boolean(await this.command());
    let data: { games: SteamGame[]; warnings: string[] } = { games: [], warnings: [] }, connected = false;
    if (supported && installed) {
      try { data.games = await this.clientGames(); connected = true; }
      catch {
        data = await readSteamGames([join(this.home, ".local/share/Steam"), join(this.home, ".steam/steam"), join(this.home, ".var/app/com.valvesoftware.Steam/.local/share/Steam")]);
        data.games = data.games.filter(g => !/^(Proton |Steam Linux Runtime|Steamworks )|Dedicated Server| SDK($| )/i.test(g.name));
      }
    }
    return { supported, available: Boolean(installed && display), connected, node: this.node, ...data, session: this.session,
      reason: !supported ? "Steam games are available on Linux only." : !installed ? "Install Steam on this Linux machine to connect your library." : !display ? "Steam needs a logged-in desktop session on this machine." : !connected ? "Steam is reconnecting. Your installed games are shown until your library is available." : null };
  }
  status() { return { session: this.session }; }
  private async hideWindows() {
    if (this.options.desktop) return this.options.desktop();
    const python = Bun.which("python3");
    if (!python || !Bun.which("wmctrl")) throw new Error("Steam desktop helpers are not installed");
    const child = Bun.spawn([python, join(import.meta.dir, "../../../scripts/steam-windows.py")], { env: this.env, stdout: "ignore", stderr: "ignore" });
    const code = await Promise.race([child.exited, Bun.sleep(3000).then(() => -1)]);
    if (code !== 0) throw new Error("Could not return to the desktop");
  }
  async returnToVault() {
    if (this.platform !== "linux") throw new SteamError(409, "Steam games are available on Linux only.");
    await this.hideWindows();
    this.returned = true;
    if (this.session && !["ended", "error", "installing", "attention"].includes(this.session.phase)) this.session.phase = "returned";
    return { returned: true, session: this.session };
  }
  async stop() {
    if (!this.session) return { stopped: true };
    if (!this.client) throw new SteamError(409, "Steam is not connected");
    if (this.session.phase === "installing") await this.client.cancelInstall(this.session.id);
    else if (["launching", "attention"].includes(this.session.phase)) await this.client.cancelLaunch(this.session.id);
    else await this.client.stop(this.session.id);
    this.session.phase = "ended";
    await this.hideWindows();
    this.dispose();
    return { stopped: true };
  }
  async respond(choice: unknown) {
    const prompt = this.session?.prompt;
    if (!prompt || !this.session || !this.client || this.session.phase !== "attention") throw new SteamError(409, "This game is no longer waiting for a decision.");
    if (!["cancel", "local", "cloud"].includes(String(choice))) throw new SteamError(400, "Invalid game choice");
    if (choice === "cloud" && prompt.kind !== "cloudconflict") throw new SteamError(400, "Invalid game choice");
    const action = (await this.client.actions()).find(a => a.nGameActionID === prompt.action && a.gameid === this.session!.id && a.bWaitingForUI && a.strTaskName === "SynchronizingCloud" && a.strTaskDetails === prompt.kind);
    if (!action) throw new SteamError(409, "The cloud-save request changed. Please refresh.");
    if (choice === "cancel") return this.stop();
    const command = prompt.kind === "cloudconflict" ? choice === "cloud" ? "KeepRemote" : "KeepLocal" : prompt.kind === "syncfailed" ? "IgnoreCloud" : "IgnorePendingCloudSessions";
    await this.client.respond(prompt.action, command);
    this.session.phase = "launching"; delete this.session.prompt; this.started = Date.now(); this.returned = false;
    return { requested: true };
  }
  dispose() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick() {
    if (!this.session || !this.client || this.checking || ["ended", "error"].includes(this.session.phase)) return;
    this.checking = true;
    try {
      const game = (await this.clientGames(true)).find(g => g.id === this.session!.id);
      if (!game) throw new Error("This game is no longer available in your Steam library.");
      this.session.progress = game.progress;
      if (this.session.phase === "installing") {
        const install = await this.client.installation();
        if (install.currentAppID === Number(game.id)) {
          if (install.eAppError) throw new Error(install.errorDetail || "Steam could not install this game.");
          if (install.eInstallState === 7) {
            if (install.nDiskSpaceRequired > install.nDiskSpaceAvailable) throw new Error("Not enough disk space to install this game.");
            await this.client.continueInstall();
          }
          if (install.eInstallState === 8) throw new Error("This game requires a separate license agreement before installation.");
        }
        await this.hideWindows();
        if (game.ready && [4, 11].includes(game.status)) {
          this.session.phase = "launching"; this.started = Date.now();
          await this.client.play(game.id);
        }
      } else if (game.status === 4) {
        this.sawRunning = true;
        this.session.phase = this.returned ? "returned" : "running";
      } else if (this.sawRunning) {
        this.session.phase = "ended"; await this.hideWindows(); this.dispose();
      } else {
        const action = (await this.client.actions()).find(a => a.gameid === game.id && a.bWaitingForUI && a.strTaskName === "SynchronizingCloud");
        if (action && ["syncfailed", "cloudconflict", "pendingcloudsessions"].includes(action.strTaskDetails)) {
          this.session.phase = "attention";
          this.session.prompt = { kind: action.strTaskDetails as "syncfailed" | "cloudconflict" | "pendingcloudsessions", action: action.nGameActionID };
          await this.hideWindows();
        } else if (Date.now() - this.started > 120000) throw new Error("The game did not start. It may need an update or additional setup.");
      }
    } catch (e) {
      this.session = { ...this.session!, phase: "error", error: e instanceof Error ? e.message : "Steam could not launch this game." };
      this.dispose();
      await this.hideWindows().catch(() => {});
    } finally { this.checking = false; }
  }
  async open(id?: string) {
    if (id !== undefined && !appId(id)) throw new SteamError(400, "Invalid Steam game ID");
    if (this.opening) throw new SteamError(409, "Steam is already preparing a game. Please wait.");
    this.opening = true;
    try {
      const library = await this.library();
      if (!library.available) throw new SteamError(409, library.reason!);
      if (id) {
        const game = library.games.find(g => g.id === id);
        if (!game) throw new SteamError(404, "Game is not in your Steam library.");
        if (!library.connected || !this.client) throw new SteamError(409, "Steam is reconnecting. Try again in a moment.");
        if (game.compatible === false) throw new SteamError(409, "This title is not available for this Linux machine.");
        if (this.session && this.session.id !== id && !["ended", "error"].includes(this.session.phase)) throw new SteamError(409, "Quit the current game in The Vault before starting another.");
        const existingAction = (await this.client.actions()).some(a => a.gameid === id && a.strActionName === "LaunchApp");
        const resume = game.status === 4;
        this.dispose(); this.started = Date.now(); this.returned = false; this.sawRunning = resume;
        this.session = { id, name: game.name, phase: resume ? "running" : (game.ready || existingAction) ? "launching" : "installing" };
        await this.client.background();
        if (resume) await this.client.resume(id);
        else if (existingAction) { /* Observe the existing launch, including an outstanding cloud prompt. */ }
        else if (game.ready) await this.client.play(id);
        else { await this.client.install(id); await this.hideWindows(); }
        if (this.options.monitor !== false) { this.timer = setInterval(() => void this.tick(), 1500); this.timer.unref(); }
      } else {
        const command = await this.command();
        if (!command) throw new SteamError(409, "Steam is not installed");
        const argv = [...command, "-silent", "-cef-enable-debugging", "-devtools-ip", "127.0.0.1", "-devtools-port", "8080"];
        if (this.options.launch) await this.options.launch(argv, this.env);
        else {
          const child = Bun.spawn(argv, { env: this.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
          const code = await Promise.race([child.exited, Bun.sleep(1800).then(() => null)]);
          if (code !== null && code !== 0) throw new Error("Steam exited");
          child.unref();
        }
      }
      return { requested: true, node: this.node, session: this.session };
    } catch (e) {
      if (e instanceof SteamError) throw e;
      if (this.session) this.session = { ...this.session, phase: "error", error: "Steam could not start the game. Please try again." };
      throw new SteamError(502, "Steam could not complete this request. Please try again.");
    } finally { this.opening = false; }
  }
}
export class SteamError extends Error {
  constructor(public status: 400 | 404 | 409 | 502, message: string) { super(message); }
}
export function registerSteamRoutes(app: Hono, steam: Steam) {
  app.get("/api/steam", async c => c.json(await steam.library()));
  app.get("/api/steam/status", c => c.json(steam.status()));
  const run = async (c: any, action: () => Promise<unknown>) => {
    try { return c.json(await action()); }
    catch (e) { if (e instanceof SteamError) return c.json({ error: e.message }, e.status); return c.json({ error: "Steam desktop action failed. Please try again." }, 502); }
  };
  app.post("/api/steam/open", c => run(c, () => steam.open()));
  app.post("/api/steam/games/:id/play", c => run(c, () => steam.open(c.req.param("id"))));
  app.post("/api/steam/return", c => run(c, () => steam.returnToVault()));
  app.post("/api/steam/respond", c => run(c, async () => steam.respond((await c.req.json()).choice)));
  app.post("/api/steam/stop", c => run(c, () => steam.stop()));
}
