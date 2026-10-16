// Retro games: SNES and N64 ROMs in ~/Games/<system>/ played through RetroArch, fullscreen
// on the node's own screen (the enuc TV). The daemon owns the emulator process so the
// kiosk, the dashboard and a remote can all see what is playing and stop it. RetroArch
// gets a Cyberdeck config layer (--appendconfig): controller autoconfig for Xbox-style
// pads, resume via auto save states, and Back-chorded hotkeys. Clients name a game by id
// only; paths never come from a request.
import type { Hono } from "hono";
import { createHash } from "crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, type ReadStream } from "fs";
import { homedir } from "os";
import { basename, extname, join } from "path";
import type { CyberdeckConfig } from "../config";
import { CYBERDECK_HOME } from "../config";

export type GameSystem = {
  id: "snes" | "n64";
  name: string;
  short: string;
  exts: string[];
  /** Preferred libretro cores, best first. */
  cores: string[];
  /** Folder name in the libretro-thumbnails collection; also the No-Intro DAT name. */
  thumbnails: string;
  /** Extensions that alone identify this system (not .zip). */
  romExts: string[];
};

export const SYSTEMS: GameSystem[] = [
  { id: "snes", name: "Super Nintendo", short: "SNES", exts: [".sfc", ".smc", ".fig", ".swc", ".zip"], cores: ["snes9x_libretro.so", "bsnes_libretro.so", "bsnes_mercury_balanced_libretro.so"], thumbnails: "Nintendo - Super Nintendo Entertainment System", romExts: [".sfc", ".smc", ".fig", ".swc"] },
  { id: "n64", name: "Nintendo 64", short: "N64", exts: [".z64", ".n64", ".v64", ".zip"], cores: ["mupen64plus_next_libretro.so", "parallel_n64_libretro.so"], thumbnails: "Nintendo - Nintendo 64", romExts: [".z64", ".n64", ".v64"] },
];

export type Game = {
  id: string;
  system: GameSystem["id"];
  /** Display title: the No-Intro name when the ROM's checksum is known, else the file
   *  name, without (Region)/[tags]. */
  title: string;
  /** Region and dump tags from the file name, e.g. "USA". */
  tags: string;
  /** No-Intro name (or the file name): the libretro-thumbnails lookup key. */
  name: string;
  file: string;
  size: number;
  /** Identification cache key: changes when the file does. */
  key: string;
  lastPlayed: number | null;
};

export type Running = { id: string; title: string; system: GameSystem["id"]; startedAt: number };

export const HOTKEYS = [
  { keys: "Home, or Back + Start", does: "Back to Cyberdeck" },
  { keys: "Back + X", does: "RetroArch menu" },
  { keys: "Back + RB / LB", does: "Save / load state" },
];

/** Shown on the TV when a game starts (RetroArch on-screen message). */
export const EXIT_HINT = "Press HOME (or BACK + START) to return to Cyberdeck";

export const gameId = (system: string, file: string): string => createHash("sha1").update(`${system}/${file}`).digest("hex").slice(0, 12);

/** "Super Mario World (USA) [!]" -> title "Super Mario World", tags "USA, !". */
export function parseTitle(name: string): { title: string; tags: string } {
  const tags = [...name.matchAll(/[([]([^)\]]*)[)\]]/g)].map((m) => m[1].trim()).filter(Boolean);
  const title = name.replace(/\s*[([][^)\]]*[)\]]/g, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return { title: title || name, tags: tags.join(", ") };
}

/** libretro-thumbnails replaces these characters with "_" in file names. */
export const thumbnailUrl = (system: GameSystem, name: string): string =>
  `https://thumbnails.libretro.com/${encodeURIComponent(system.thumbnails)}/Named_Boxarts/${encodeURIComponent(name.replace(/[&*/:`<>?\\|"]/g, "_"))}.png`;

/** ROMs directly in <dir>/<system>/ or one folder below it. `names` maps an
 *  identification key to its No-Intro name ("" = checked, unknown). */
export function scanLibrary(dir: string, played: Record<string, number> = {}, names: Record<string, string> = {}): Game[] {
  const games: Game[] = [];
  for (const system of SYSTEMS) {
    const root = join(dir, system.id);
    const walk = (rel: string, depth: number) => {
      let entries: string[] = [];
      try { entries = readdirSync(join(root, rel)); } catch { return; }
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const file = rel ? join(rel, entry) : entry;
        let st;
        try { st = statSync(join(root, file)); } catch { continue; }
        if (st.isDirectory()) { if (depth < 1) walk(file, depth + 1); continue; }
        if (!system.exts.includes(extname(entry).toLowerCase())) continue;
        const key = `${system.id}/${file}:${st.size}:${Math.round(st.mtimeMs)}`;
        const name = names[key] || basename(entry, extname(entry));
        const id = gameId(system.id, file);
        games.push({ id, system: system.id, ...parseTitle(name), name, file, size: st.size, key, lastPlayed: played[id] ?? null });
      }
    };
    walk("", 0);
  }
  return games.sort((a, b) => a.title.localeCompare(b.title));
}

/** Which system a file belongs to by extension; .zip needs its contents. */
export function systemFor(file: string): GameSystem | undefined {
  const ext = extname(file).toLowerCase();
  return SYSTEMS.find((s) => s.romExts.includes(ext));
}

/** A ROM file name safe to write: no directories, a known extension, printable. */
export function safeRomName(name: string): string | null {
  const clean = basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f<>:"|?*]/g, "").trim();
  if (!clean || clean.startsWith(".") || clean.length > 200) return null;
  return SYSTEMS.some((s) => s.exts.includes(extname(clean).toLowerCase())) ? clean : null;
}

/** N64 dumps come in three byte orders; No-Intro checksums the big-endian (.z64) one. */
export function toZ64(rom: Uint8Array): Uint8Array {
  const out = new Uint8Array(rom.length);
  const magic = rom.length >= 4 ? (rom[0] << 24 | rom[1] << 16 | rom[2] << 8 | rom[3]) >>> 0 : 0;
  if (magic === 0x37804012) { for (let i = 0; i + 1 < rom.length; i += 2) { out[i] = rom[i + 1]; out[i + 1] = rom[i]; } return out; }
  if (magic === 0x40123780) { for (let i = 0; i + 3 < rom.length; i += 4) { out[i] = rom[i + 3]; out[i + 1] = rom[i + 2]; out[i + 2] = rom[i + 1]; out[i + 3] = rom[i]; } return out; }
  return rom;
}

/** CRC32 the way No-Intro lists it: SNES without a 512-byte copier header, N64 as .z64. */
export function romCrc(system: GameSystem["id"], rom: Uint8Array): string {
  const data = system === "snes" && rom.length % 1024 === 512 ? rom.subarray(512) : system === "n64" ? toZ64(rom) : rom;
  return (Bun.hash.crc32(data) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** CRC -> game name from a clrmamepro DAT (libretro-database metadat/no-intro). */
export function parseDat(dat: string): Map<string, string> {
  const byCrc = new Map<string, string>();
  for (const m of dat.matchAll(/game \(\s*name "((?:[^"\\]|\\.)*)"[\s\S]*?\bcrc ([0-9A-Fa-f]{8})/g)) {
    if (!byCrc.has(m[2].toUpperCase())) byCrc.set(m[2].toUpperCase(), m[1]);
  }
  return byCrc;
}

/** `unzip -v` lists each member's CRC-32; the first ROM of the system is the game. */
async function unzipListing(path: string): Promise<{ name: string; crc: string }[]> {
  const proc = Bun.spawn(["unzip", "-v", path], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return [...out.matchAll(/^\s*\d+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+([0-9a-f]{8})\s+(.+)$/gim)].map((m) => ({ crc: m[1].toUpperCase(), name: m[2].trim() }));
}
async function zipSystem(path: string): Promise<GameSystem | undefined> {
  for (const entry of await unzipListing(path)) { const s = systemFor(entry.name); if (s) return s; }
  return undefined;
}
async function zipCrc(path: string, system: GameSystem): Promise<string | null> {
  return (await unzipListing(path)).find((e) => systemFor(e.name) === system)?.crc ?? null;
}

export const datUrl = (system: GameSystem): string =>
  `https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/${encodeURIComponent(system.thumbnails)}.dat`;

export function findCore(system: GameSystem, dirs: string[]): string | null {
  for (const core of system.cores) for (const dir of dirs) if (existsSync(join(dir, core))) return join(dir, core);
  return null;
}

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":").concat(["/usr/bin", "/usr/local/bin", "/snap/bin"])) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

/** RetroArch's udev driver numbers an xpad's buttons A B X Y LB RB Back Start Guide LS RS = 0..10. */
export const XBOX_AUTOCONFIG = (device: string) => `input_driver = "udev"
input_device = "${device}"
input_device_display_name = "Xbox controller"
input_b_btn = "0"
input_a_btn = "1"
input_y_btn = "2"
input_x_btn = "3"
input_l_btn = "4"
input_r_btn = "5"
input_select_btn = "6"
input_start_btn = "7"
input_menu_toggle_btn = "8"
input_l3_btn = "9"
input_r3_btn = "10"
input_up_btn = "h0up"
input_down_btn = "h0down"
input_left_btn = "h0left"
input_right_btn = "h0right"
input_l2_axis = "+2"
input_r2_axis = "+5"
input_l_x_plus_axis = "+0"
input_l_x_minus_axis = "-0"
input_l_y_plus_axis = "+1"
input_l_y_minus_axis = "-1"
input_r_x_plus_axis = "+3"
input_r_x_minus_axis = "-3"
input_r_y_plus_axis = "+4"
input_r_y_minus_axis = "-4"
`;

/** Layered over the user's retroarch.cfg; never saved back into it. */
export const RETROARCH_LAYER = (autoconfigDir: string) => `video_fullscreen = "true"
video_windowed_fullscreen = "true"
pause_nonactive = "false"
config_save_on_exit = "false"
savestate_auto_save = "true"
savestate_auto_load = "true"
input_autodetect_enable = "true"
input_joypad_driver = "udev"
joypad_autoconfig_dir = "${autoconfigDir}"
input_enable_hotkey_btn = "6"
input_exit_emulator_btn = "7"
input_menu_toggle_btn = "2"
input_save_state_btn = "5"
input_load_state_btn = "4"
quit_press_twice = "false"
stdin_cmd_enable = "true"
menu_show_quit_retroarch = "true"
notification_show_autoconfig = "false"
`;

type Child = {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
  /** A RetroArch stdin command (SHOW_MSG, QUIT, ...). */
  send?: (command: string) => void;
};
export type Spawner = (argv: string[], env: Record<string, string | undefined>) => Child;

const defaultSpawner: Spawner = (argv, env) => {
  const proc = Bun.spawn(argv, { env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal),
    send: (command) => { try { proc.stdin.write(command + "\n"); void proc.stdin.flush(); } catch { /* exited */ } },
  };
};

// Linux input_event: struct timeval (16 bytes on 64-bit), u16 type, u16 code, s32 value.
const EV_KEY = 1, BTN_SELECT = 314, BTN_START = 315, BTN_MODE = 316;

/** Decide from a pad's held buttons whether the player asked to leave the game. */
export function wantsExit(held: Set<number>): boolean {
  return held.has(BTN_MODE) || (held.has(BTN_SELECT) && held.has(BTN_START));
}

/** Joystick event devices from /proc/bus/input/devices (handlers include jsN). */
export function joystickEvents(devices: string): string[] {
  return devices.split(/\n\s*\n/).flatMap((block) => {
    const h = /^H: Handlers=(.*)$/m.exec(block)?.[1] ?? "";
    const ev = /\b(event\d+)\b/.exec(h)?.[1];
    return /\bjs\d+\b/.test(h) && ev ? [`/dev/input/${ev}`] : [];
  });
}

export type PadWatcher = (onExit: () => void) => () => void;

/** While a game runs, the daemon reads every controller itself, so the way out works
 *  whatever RetroArch's own bindings do, and for pads plugged in mid-game. */
export const watchPads: PadWatcher = (onExit) => {
  const open = new Map<string, ReadStream>();
  let fired = false;
  const attach = () => {
    let devices = "";
    try { devices = readFileSync("/proc/bus/input/devices", "utf8"); } catch { return; }
    for (const path of joystickEvents(devices)) {
      if (open.has(path)) continue;
      const held = new Set<number>();
      let rest = Buffer.alloc(0);
      const stream = createReadStream(path);
      open.set(path, stream);
      stream.on("data", (chunk) => {
        let buf = Buffer.concat([rest, chunk as Buffer]);
        for (; buf.length >= 24; buf = buf.subarray(24)) {
          if (buf.readUInt16LE(16) !== EV_KEY) continue;
          const code = buf.readUInt16LE(18), value = buf.readInt32LE(20);
          if (value) held.add(code); else held.delete(code);
          if (!fired && wantsExit(held)) { fired = true; onExit(); }
        }
        rest = Buffer.from(buf);
      });
      const drop = () => { open.delete(path); };
      stream.on("error", drop);
      stream.on("close", drop);
    }
  };
  attach();
  const timer = setInterval(attach, 2000);
  return () => { clearInterval(timer); for (const s of open.values()) s.destroy(); open.clear(); };
};

export class Games {
  readonly dir: string;
  readonly retroarch: string | null;
  readonly coreDirs: string[];
  private running: (Running & { child: Child }) | null = null;
  private stateFile: string;
  private layerDir: string;
  private unwatch: (() => void) | null = null;
  private dbDir: string;
  private dats = new Map<string, Promise<Map<string, string> | null>>();
  private identifying: Promise<void> | null = null;
  constructor(cfg: CyberdeckConfig, private spawn: Spawner = defaultSpawner, home = CYBERDECK_HOME, private watch: PadWatcher = watchPads, private fetcher: typeof fetch = fetch) {
    this.dbDir = join(home, "games-db");
    this.dir = cfg.games?.dir ?? join(homedir(), "Games");
    this.retroarch = cfg.games?.retroarch ?? which("retroarch");
    this.coreDirs = cfg.games?.coreDirs ?? [join(homedir(), ".config/retroarch/cores"), "/usr/lib/x86_64-linux-gnu/libretro", "/usr/lib/aarch64-linux-gnu/libretro", "/usr/lib/libretro"];
    this.stateFile = join(home, "games.json");
    this.layerDir = join(home, "retroarch");
  }
  private state(): { lastPlayed: Record<string, number>; names: Record<string, string> } {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, "utf8"));
      return { lastPlayed: s.lastPlayed ?? {}, names: s.names ?? {} };
    } catch { return { lastPlayed: {}, names: {} }; }
  }
  private save(state: { lastPlayed: Record<string, number>; names: Record<string, string> }) {
    mkdirSync(this.layerDir, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2) + "\n");
  }
  private scan(): Game[] {
    const { lastPlayed, names } = this.state();
    return scanLibrary(this.dir, lastPlayed, names);
  }
  /** The No-Intro DAT for a system, cached on disk for 30 days. */
  private dat(system: GameSystem): Promise<Map<string, string> | null> {
    let p = this.dats.get(system.id);
    if (!p) {
      p = (async () => {
        const file = join(this.dbDir, `${system.id}.dat`);
        try {
          if (!existsSync(file) || Date.now() - statSync(file).mtimeMs > 30 * 86400_000) {
            const r = await this.fetcher(datUrl(system), { signal: AbortSignal.timeout(20000) });
            if (r.ok) { mkdirSync(this.dbDir, { recursive: true }); writeFileSync(file, await r.text()); }
          }
          return parseDat(readFileSync(file, "utf8"));
        } catch { return existsSync(file) ? parseDat(readFileSync(file, "utf8")) : null; }
      })();
      this.dats.set(system.id, p);
      void p.then((m) => { if (!m) this.dats.delete(system.id); });
    }
    return p;
  }
  /** Name ROMs by checksum, so "mk64.z64" shows as Mario Kart 64 with its box art. */
  identify(): Promise<void> {
    this.identifying ??= (async () => {
      const state = this.state();
      const todo = scanLibrary(this.dir).filter((g) => !(g.key in state.names));
      for (const game of todo) {
        const system = SYSTEMS.find((s) => s.id === game.system)!;
        const dat = await this.dat(system);
        if (!dat) continue;
        let crc: string | null = null;
        const path = join(this.dir, system.id, game.file);
        try {
          if (extname(game.file).toLowerCase() === ".zip") crc = await zipCrc(path, system);
          else crc = romCrc(system.id, new Uint8Array(await Bun.file(path).arrayBuffer()));
        } catch { /* unreadable: leave the file name */ }
        state.names[game.key] = (crc && dat.get(crc)) || "";
      }
      if (todo.length) this.save({ ...this.state(), names: state.names });
    })().finally(() => { this.identifying = null; });
    return this.identifying;
  }
  /** Store an uploaded ROM under its system's folder; never overwrites. */
  async add(fileName: string, bytes: Uint8Array): Promise<Game> {
    const name = safeRomName(fileName);
    if (!name) throw new Error("Not a SNES or N64 ROM (.sfc .smc .z64 .n64 .v64 or .zip)");
    let system = systemFor(name);
    const temp = join(this.dir, `.upload-${process.pid}-${Date.now()}`);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(temp, bytes);
    try {
      if (!system) system = await zipSystem(temp);
      if (!system) throw new Error("That zip holds no SNES or N64 ROM");
      const dest = join(this.dir, system.id, name);
      if (existsSync(dest)) throw new Error(`${name} is already in the library`);
      mkdirSync(join(this.dir, system.id), { recursive: true });
      await Bun.write(dest, Bun.file(temp));
    } finally {
      try { unlinkSync(temp); } catch {}
    }
    await this.identify();
    return this.scan().find((g) => g.system === system!.id && g.file === name)!;
  }
  list() {
    const games = this.scan();
    return {
      available: Boolean(this.retroarch),
      reason: this.retroarch ? undefined : "RetroArch is not installed on this machine.",
      dir: this.dir,
      systems: SYSTEMS.map((s) => ({ id: s.id, name: s.name, short: s.short, core: Boolean(findCore(s, this.coreDirs)), count: games.filter((g) => g.system === s.id).length, folder: join(this.dir, s.id) })),
      games,
      running: this.status(),
      hotkeys: HOTKEYS,
    };
  }
  status(): Running | null {
    if (!this.running) return null;
    const { child: _child, ...running } = this.running;
    return running;
  }
  find(id: string): Game | undefined {
    return this.scan().find((g) => g.id === id);
  }
  private writeLayer(): string {
    const auto = join(this.layerDir, "autoconfig");
    mkdirSync(auto, { recursive: true });
    for (const device of ["Microsoft X-Box 360 pad", "Xbox 360 Wireless Receiver", "Generic X-Box pad"])
      writeFileSync(join(auto, `${device}.cfg`), XBOX_AUTOCONFIG(device));
    const layer = join(this.layerDir, "cyberdeck.cfg");
    writeFileSync(layer, RETROARCH_LAYER(auto));
    return layer;
  }
  async launch(id: string): Promise<Running> {
    if (!this.retroarch) throw new Error("RetroArch is not installed on this machine.");
    const game = this.find(id);
    if (!game) throw new Error("No such game");
    const system = SYSTEMS.find((s) => s.id === game.system)!;
    const core = findCore(system, this.coreDirs);
    if (!core) throw new Error(`No ${system.short} emulator core is installed.`);
    await this.stop();
    const uid = process.getuid?.() ?? 1000;
    const env = { ...process.env };
    if (!env.WAYLAND_DISPLAY && !env.DISPLAY) env.WAYLAND_DISPLAY = "wayland-0";
    env.XDG_RUNTIME_DIR ??= `/run/user/${uid}`;
    const child = this.spawn([this.retroarch, "--fullscreen", "--appendconfig", this.writeLayer(), "-L", core, join(this.dir, system.id, game.file)], env);
    const running = { id: game.id, title: game.title, system: game.system, startedAt: Date.now(), child };
    this.running = running;
    const state = this.state();
    state.lastPlayed[game.id] = running.startedAt;
    this.save(state);
    this.unwatch?.();
    this.unwatch = this.watch(() => void this.stop());
    // Say how to get out, once the window is up and again in case it was missed.
    const hint = [setTimeout(() => child.send?.(`SHOW_MSG ${EXIT_HINT}`), 2500), setTimeout(() => child.send?.(`SHOW_MSG ${EXIT_HINT}`), 9000)];
    void child.exited.then(() => {
      hint.forEach(clearTimeout);
      if (this.running !== running) return;
      this.running = null;
      this.unwatch?.();
      this.unwatch = null;
    });
    const { child: _child, ...status } = running;
    return status;
  }
  /** Ask RetroArch to quit (it writes SRAM and the auto save state), then insist. */
  async stop(): Promise<void> {
    const running = this.running;
    if (!running) return;
    const exited = (ms: number) => Promise.race([running.child.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
    running.child.send?.("QUIT");
    if (!(await exited(running.child.send ? 3000 : 0))) {
      running.child.kill("SIGTERM");
      if (!(await exited(6000))) running.child.kill("SIGKILL");
    }
    if (this.running === running) {
      this.running = null;
      this.unwatch?.();
      this.unwatch = null;
    }
  }
}

export function registerGameRoutes(app: Hono, games: Games, opts: { artDir?: string; fetcher?: typeof fetch } = {}) {
  const artDir = opts.artDir ?? join(CYBERDECK_HOME, "games-art");
  const fetcher = opts.fetcher ?? fetch;
  app.get("/api/games", async (c) => {
    // Identify new files first, but never hold the page up for long.
    await Promise.race([games.identify(), Bun.sleep(4000)]);
    return c.json(games.list());
  });
  app.post("/api/games/upload", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) return c.json({ error: "Empty file" }, 400);
    if (bytes.length > 256 * 1024 * 1024) return c.json({ error: "Too large for a SNES or N64 ROM" }, 413);
    try { return c.json({ game: await games.add(c.req.query("name") ?? "", bytes) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.get("/api/games/status", (c) => c.json({ running: games.status() }));
  app.post("/api/games/stop", async (c) => { await games.stop(); return c.json({ running: null }); });
  app.post("/api/games/:id/launch", async (c) => {
    try { return c.json({ running: await games.launch(c.req.param("id")) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  // Box art from libretro-thumbnails, cached on disk (misses too, as an empty file).
  app.get("/api/games/art/:id", async (c) => {
    const game = games.find(c.req.param("id"));
    if (!game) return c.json({ error: "No such game" }, 404);
    const system = SYSTEMS.find((s) => s.id === game.system)!;
    const file = join(artDir, `${gameId(system.id, game.name)}.png`);
    if (!existsSync(file)) {
      mkdirSync(artDir, { recursive: true });
      let bytes = new Uint8Array();
      try {
        const r = await fetcher(thumbnailUrl(system, game.name), { signal: AbortSignal.timeout(8000) });
        if (r.ok && (r.headers.get("content-type") ?? "").startsWith("image/")) bytes = new Uint8Array(await r.arrayBuffer());
        else if (!r.ok && r.status !== 404) return c.json({ error: "Box art unavailable" }, 502);
      } catch { return c.json({ error: "Box art unavailable" }, 502); }
      writeFileSync(file, bytes);
    }
    const bytes = readFileSync(file);
    if (!bytes.length) return c.json({ error: "No box art" }, 404);
    return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" } });
  });
}
