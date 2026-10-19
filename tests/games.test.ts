import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EXIT_HINT, Games, joystickEvents, parseDat, romCrc, safeRomName, toZ64, parseTitle, registerGameRoutes, scanLibrary, thumbnailUrl, wantsExit, SYSTEMS, type Spawner } from "../src/daemon/api/games";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cd-games-"));
  const dir = join(root, "Games");
  mkdirSync(join(dir, "snes", "RPG"), { recursive: true });
  mkdirSync(join(dir, "n64"), { recursive: true });
  mkdirSync(join(root, "cores"));
  writeFileSync(join(dir, "snes", "Super Mario World (USA).sfc"), "x");
  writeFileSync(join(dir, "snes", "RPG", "Chrono Trigger (USA) [!].smc"), "x");
  writeFileSync(join(dir, "snes", "notes.txt"), "x");
  writeFileSync(join(dir, "n64", "Mario Kart 64 (USA).z64"), "x");
  writeFileSync(join(root, "cores", "snes9x_libretro.so"), "");
  return { root, dir };
}

function fakeSpawner() {
  const calls: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  let exit = (_: number) => {};
  const kills: string[] = [];
  const spawn: Spawner = (argv, env) => {
    calls.push({ argv, env });
    const exited = new Promise<number>((r) => (exit = r));
    return { pid: 1, exited, kill: (s) => { kills.push(String(s)); exit(0); } };
  };
  return { spawn, calls, kills, exit: () => exit(0) };
}

describe("games library", () => {
  test("titles drop region and dump tags but keep them for display", () => {
    expect(parseTitle("Chrono Trigger (USA) [!]")).toEqual({ title: "Chrono Trigger", tags: "USA, !" });
    expect(parseTitle("Pilotwings")).toEqual({ title: "Pilotwings", tags: "" });
  });

  test("scans per-system folders one level deep, ROM extensions only", () => {
    const { dir } = fixture();
    const games = scanLibrary(dir);
    expect(games.map((g) => [g.system, g.title])).toEqual([
      ["snes", "Chrono Trigger"],
      ["n64", "Mario Kart 64"],
      ["snes", "Super Mario World"],
    ]);
    expect(new Set(games.map((g) => g.id)).size).toBe(3);
  });

  test("box art uses the libretro-thumbnails name with unsafe characters replaced", () => {
    expect(thumbnailUrl(SYSTEMS[0], "Kirby's Dream Course: Plus (USA)")).toBe(
      "https://thumbnails.libretro.com/Nintendo%20-%20Super%20Nintendo%20Entertainment%20System/Named_Boxarts/Kirby's%20Dream%20Course_%20Plus%20(USA).png",
    );
  });
});

describe("games routes", () => {
  test("launch runs RetroArch fullscreen with the system's core, records play, and stop ends it", async () => {
    const { root, dir } = fixture();
    const fake = fakeSpawner();
    const games = new Games({ games: { dir, retroarch: "/usr/bin/retroarch", coreDirs: [join(root, "cores")] } } as any, fake.spawn, join(root, "home"), () => () => {}, (async () => new Response("", { status: 404 })) as any);
    const app = new Hono();
    registerGameRoutes(app, games, { artDir: join(root, "art"), fetcher: (async () => new Response("", { status: 404 })) as any });

    const list = await (await app.request("/api/games")).json();
    expect(list.available).toBe(true);
    expect(list.systems.map((s: any) => [s.id, s.core, s.count])).toEqual([["snes", true, 2], ["n64", false, 1]]);
    const smw = list.games.find((g: any) => g.title === "Super Mario World");
    const mk = list.games.find((g: any) => g.title === "Mario Kart 64");

    const noCore = await app.request(`/api/games/${mk.id}/launch`, { method: "POST" });
    expect(noCore.status).toBe(400);
    expect((await noCore.json()).error).toContain("N64");
    expect((await app.request("/api/games/nope/launch", { method: "POST" })).status).toBe(400);

    const ok = await app.request(`/api/games/${smw.id}/launch`, { method: "POST" });
    expect((await ok.json()).running.title).toBe("Super Mario World");
    const argv = fake.calls[0].argv;
    expect(argv[0]).toBe("/usr/bin/retroarch");
    expect(argv).toContain("--fullscreen");
    expect(argv.slice(-3)).toEqual(["-L", join(root, "cores", "snes9x_libretro.so"), join(dir, "snes", "Super Mario World (USA).sfc")]);
    const layer = readFileSync(argv[argv.indexOf("--appendconfig") + 1], "utf8");
    expect(layer).toContain('input_exit_emulator_btn = "7"');
    expect(readFileSync(join(root, "home", "retroarch", "autoconfig", "Microsoft X-Box 360 pad.cfg"), "utf8")).toContain('input_b_btn = "0"');

    expect((await (await app.request("/api/games/status")).json()).running.id).toBe(smw.id);
    const during = await (await app.request("/api/games")).json();
    expect(during.running.id).toBe(smw.id);
    expect(during.games.find((g: any) => g.id === smw.id).lastPlayed).toBeNumber();

    await app.request("/api/games/stop", { method: "POST" });
    expect(fake.kills).toEqual(["SIGTERM"]);
    expect((await (await app.request("/api/games")).json()).running).toBeNull();
  });

  test("the emulator quitting by itself clears the running game", async () => {
    const { root, dir } = fixture();
    const fake = fakeSpawner();
    const games = new Games({ games: { dir, retroarch: "/usr/bin/retroarch", coreDirs: [join(root, "cores")] } } as any, fake.spawn, join(root, "home"), () => () => {});
    const id = scanLibrary(dir).find((g) => g.system === "snes")!.id;
    await games.launch(id);
    fake.exit();
    await Bun.sleep(5);
    expect(games.status()).toBeNull();
  });

  test("no RetroArch: unavailable, and launch refuses", async () => {
    const { root, dir } = fixture();
    const games = new Games({ games: { dir, retroarch: undefined, coreDirs: [] } } as any, fakeSpawner().spawn, join(root, "home"));
    (games as any).retroarch = null;
    expect(games.list().available).toBe(false);
    await expect(games.launch("x")).rejects.toThrow("RetroArch");
  });
});

describe("way out of a game", () => {
  test("Home alone, or Back + Start together, asks to leave", () => {
    expect(wantsExit(new Set([316]))).toBe(true);
    expect(wantsExit(new Set([314, 315]))).toBe(true);
    expect(wantsExit(new Set([315]))).toBe(false);
    expect(wantsExit(new Set([304, 314]))).toBe(false);
  });

  test("finds controllers' event devices, not keyboards or mice", () => {
    const devices = `I: Bus=0003 Vendor=1c4f Product=0002\nN: Name="SIGMACHIP USB Keyboard"\nH: Handlers=sysrq kbd event3 leds\n\nI: Bus=0003 Vendor=045e Product=028e\nN: Name="Microsoft X-Box 360 pad"\nH: Handlers=event14 js0\n\nN: Name="Logitech M705"\nH: Handlers=mouse0 event7\n`;
    expect(joystickEvents(devices)).toEqual(["/dev/input/event14"]);
  });

  test("the controller watcher ends the game, and the TV shows how to get out", async () => {
    const { root, dir } = fixture();
    const sent: string[] = [];
    let exit = (_: number) => {};
    const spawn: Spawner = () => {
      const exited = new Promise<number>((r) => (exit = r));
      return { pid: 1, exited, kill: () => exit(0), send: (c) => { sent.push(c); if (c === "QUIT") exit(0); } };
    };
    let leave = () => {};
    let watching = 0;
    const games = new Games({ games: { dir, retroarch: "/usr/bin/retroarch", coreDirs: [join(root, "cores")] } } as any, spawn, join(root, "home"), (onExit) => { leave = onExit; watching++; return () => { watching--; }; });
    await games.launch(scanLibrary(dir).find((g) => g.system === "snes")!.id);
    expect(watching).toBe(1);
    await Bun.sleep(2600);
    expect(sent).toEqual([`SHOW_MSG ${EXIT_HINT}`]);
    leave();
    await Bun.sleep(20);
    expect(sent.at(-1)).toBe("QUIT");
    expect(games.status()).toBeNull();
    expect(watching).toBe(0);
  });
});

describe("library identification and upload", () => {
  const z64 = new Uint8Array([0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4]);
  test("N64 byte orders normalise to .z64 before checksumming", () => {
    const v64 = new Uint8Array([0x37, 0x80, 0x40, 0x12, 2, 1, 4, 3]);
    const n64 = new Uint8Array([0x40, 0x12, 0x37, 0x80, 4, 3, 2, 1]);
    expect([...toZ64(v64)]).toEqual([...z64]);
    expect([...toZ64(n64)]).toEqual([...z64]);
    expect(romCrc("n64", v64)).toBe(romCrc("n64", z64));
  });

  test("SNES copier headers are skipped", () => {
    const rom = new Uint8Array(1024).fill(7);
    const headered = new Uint8Array(1536); headered.set(rom, 512);
    expect(romCrc("snes", headered)).toBe(romCrc("snes", rom));
  });

  test("parses a No-Intro DAT into crc -> name", () => {
    const dat = `game (\n\tname "Mario Kart 64 (USA)"\n\trom ( name "Mario Kart 64 (USA).z64" size 12582912 crc 434389C1 md5 X )\n)\n`;
    expect(parseDat(dat).get("434389C1")).toBe("Mario Kart 64 (USA)");
  });

  test("upload names must be plain ROM files", () => {
    expect(safeRomName("../../etc/passwd")).toBeNull();
    expect(safeRomName("C:\\roms\\mk64.z64")).toBe("mk64.z64");
    expect(safeRomName(".hidden.sfc")).toBeNull();
    expect(safeRomName("notes.txt")).toBeNull();
  });

  test("an uploaded ROM lands in its system's folder and is named by checksum", async () => {
    const { root, dir } = fixture();
    const crc = romCrc("n64", z64);
    const dat = `game (\n\tname "Mario Kart 64 (USA)"\n\trom ( name "x.z64" size 8 crc ${crc} )\n)\n`;
    const fetcher = (async () => new Response(dat)) as any;
    const games = new Games({ games: { dir, retroarch: "/usr/bin/retroarch", coreDirs: [] } } as any, fakeSpawner().spawn, join(root, "home"), () => () => {}, fetcher);
    const app = new Hono();
    registerGameRoutes(app, games, { artDir: join(root, "art"), fetcher });
    const r = await app.request("/api/games/upload?name=mk64.z64", { method: "POST", body: z64 });
    const { game } = await r.json();
    expect(game.system).toBe("n64");
    expect(game.title).toBe("Mario Kart 64");
    expect(game.name).toBe("Mario Kart 64 (USA)");
    expect(readFileSync(join(dir, "n64", "mk64.z64")).length).toBe(8);
    expect((await app.request("/api/games/upload?name=mk64.z64", { method: "POST", body: z64 })).status).toBe(400);
    expect((await app.request("/api/games/upload?name=../evil.z64", { method: "POST", body: z64 })).status).toBe(200);
    expect(readFileSync(join(dir, "n64", "evil.z64")).length).toBe(8);
    expect((await app.request("/api/games/upload?name=evil.sh", { method: "POST", body: z64 })).status).toBe(400);
  });
});
