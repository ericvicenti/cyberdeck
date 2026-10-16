import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { parseVdf, readSteamGames, Steam, registerSteamRoutes, type SteamClientPort } from "../src/daemon/api/steam";
const home = await mkdtemp(join(tmpdir(), "cyberdeck-steam-"));
const root = join(home, ".local/share/Steam"), external = join(home, "Steam Library");
await mkdir(join(root, "steamapps"), { recursive: true }); await mkdir(join(external, "steamapps"), { recursive: true });
await writeFile(join(root, "steamapps/libraryfolders.vdf"), `"libraryfolders" { "0" { "path" "${root}" } "1" { "path" "${external}" } "2" { "path" "${home}/offline" } }`);
await writeFile(join(root, "steamapps/appmanifest_10.acf"), '"AppState" { "appid" "10" "name" "Counter-Strike" "StateFlags" "4" }');
await writeFile(join(external, "steamapps/appmanifest_20.acf"), '"AppState" { "appid" "20" "name" "Downloading Game" "StateFlags" "1026" }');
await writeFile(join(root, "steamapps/appmanifest_30.acf"), '"AppState" { "appid" "40" "name" "Mismatched ID" }');
afterAll(() => rm(home, { recursive: true, force: true }));
test("VDF parses escapes/prototype keys and rejects malformed or excessively deep input", () => {
  const value = parseVdf('// ignored\n"x" { "name" "A \\"quoted\\" title" } "__proto__" { "polluted" "yes" }');
  expect((value.x as any).name).toBe('A "quoted" title'); expect(Object.getPrototypeOf(value)).toBeNull();
  expect(() => parseVdf('"x" {')).toThrow(); expect(() => parseVdf('"x" "y" }')).toThrow(); expect(() => parseVdf('x { '.repeat(30))).toThrow();
});
test("manifest fallback merges disks, rejects mismatched IDs, reports offline disks", async () => {
  const data = await readSteamGames([root, root]);
  expect(data.games).toEqual([{ id: "10", name: "Counter-Strike", ready: true }, { id: "20", name: "Downloading Game", ready: false }]);
  expect(data.warnings).toContain("A Steam library is offline or inaccessible.");
});
function fixture(overrides: any = {}) {
  const calls: string[] = [];
  const games = [{ id: "10", name: "Counter-Strike", ready: true, status: 11, progress: 100, compatible: true }, { id: "20", name: "Downloading Game", ready: false, status: 9, progress: 0, compatible: true }];
  const install = { currentAppID: 20, eInstallState: 7, nDiskSpaceRequired: 50, nDiskSpaceAvailable: 100, eAppError: 0, errorDetail: "" };
  const actions: any[] = [];
  const client: SteamClientPort = { actions: async () => actions, respond: async (id,choice) => { calls.push(`respond:${id}:${choice}`); }, cancelLaunch: async id => { calls.push(`cancelLaunch:${id}`); }, cancelInstall: async id => { calls.push(`cancelInstall:${id}`); }, library: async () => games.map(g => ({...g})), background: async () => { calls.push("background"); }, play: async id => { calls.push(`play:${id}`); }, resume: async id => { calls.push(`resume:${id}`); }, stop: async id => { calls.push(`stop:${id}`); }, install: async id => { calls.push(`install:${id}`); }, installation: async () => install, continueInstall: async () => { calls.push("continueInstall"); } };
  const steam = new Steam("enuc", { platform: "linux", home, env: { DISPLAY: ":0" }, command: async () => ["/usr/games/steam"], client, desktop: async () => { calls.push("desktop"); }, monitor: false, ...overrides });
  const app = new Hono(); registerSteamRoutes(app, steam);
  return { app, steam, calls, games, install, client, actions };
}
test("owned games launch directly with Steam backgrounded and no library handoff", async () => {
  const { app, calls, steam } = fixture();
  expect((await app.request("/api/steam/games/10/play", {method:"POST"})).status).toBe(200);
  expect(calls).toEqual(["background", "play:10"]); expect(steam.status().session?.phase).toBe("launching");
});
test("uninstalled owned games download, use default disk settings and launch when ready", async () => {
  const { steam, calls, games } = fixture();
  await steam.open("20"); expect(steam.status().session?.phase).toBe("installing");
  await steam.tick(); expect(calls).toContain("continueInstall"); expect(calls).not.toContain("play:20");
  games[1].ready = true; games[1].status = 11; await steam.tick(); expect(calls).toContain("play:20"); expect(steam.status().session?.phase).toBe("launching");
});
test("return preserves game, Play resumes, game exit restores Vault, Quit is explicit", async () => {
  const { steam, games, calls } = fixture();
  await steam.open("10"); games[0].status=4; await steam.tick(); expect(steam.status().session?.phase).toBe("running");
  await steam.returnToVault(); expect(calls).not.toContain("stop:10"); expect(steam.status().session?.phase).toBe("returned");
  await steam.open("10"); expect(calls).toContain("resume:10");
  games[0].status=11; await steam.tick(); expect(steam.status().session?.phase).toBe("ended");
  await steam.open("10"); games[0].status=4; await steam.tick(); await steam.stop(); expect(calls).toContain("stop:10");
});
test("a second title cannot replace a running game", async () => {
  const { steam } = fixture(); await steam.open("10"); await expect(steam.open("20")).rejects.toThrow("Quit the current game");
});
test("no space and license requirements stop automation without accepting terms", async () => {
  for (const mode of ["space", "license", "download error"]) {
    const { steam, calls, install } = fixture();
    await steam.open("20");
    if (mode==="space") install.nDiskSpaceAvailable=0;
    else if(mode==="license") install.eInstallState=8;
    else { install.eAppError=1; install.errorDetail="Download unavailable"; }
    await steam.tick(); expect(steam.status().session?.phase).toBe("error"); expect(calls).not.toContain("continueInstall"); expect(calls).not.toContain("play:20");
  }
});
test("non-Linux/headless/client absent and bridge disconnected cannot launch", async () => {
  for (const options of [{platform:"darwin"},{platform:"win32"},{env:{}},{command:async()=>null},{client:null}]) {
    const {app,calls}=fixture(options); expect((await app.request("/api/steam/games/10/play",{method:"POST"})).status).toBe(409); expect(calls).toEqual([]);
  }
});
test("unknown IDs, injected arguments and client failures do not report success", async () => {
  const {app,client}=fixture();
  expect((await app.request("/api/steam/games/999/play",{method:"POST"})).status).toBe(404);
  for(const id of ["10;shutdown","-1","0","10?test","1234567890123456789"]) expect((await app.request(`/api/steam/games/${encodeURIComponent(id)}/play`,{method:"POST"})).status).toBe(400);
  client.play=async()=>{throw Error("Failed")}; expect((await app.request("/api/steam/games/10/play",{method:"POST"})).status).toBe(502);
});

test("cancel download pauses installation without treating it as a running game", async () => {
  const { steam, calls } = fixture(); await steam.open("20"); await steam.stop();
  expect(calls).toContain("cancelInstall:20"); expect(calls).not.toContain("stop:20"); expect(steam.status().session?.phase).toBe("ended");
});

test("Steam marking files installed during a download does not launch before ready", async () => {
 const { steam, games, calls }=fixture(); await steam.open("20"); games[1].ready=true; games[1].status=7;
 await steam.tick(); expect(calls).not.toContain("play:20"); expect(steam.status().session?.phase).toBe("installing");
 games[1].status=11; await steam.tick(); expect(calls).toContain("play:20");
});

test("cloud-sync decisions stay in Vault and never overwrite saves automatically", async () => {
 const { steam, calls, actions }=fixture(); await steam.open("10");
 actions.push({nGameActionID:42,gameid:"10",bWaitingForUI:true,strTaskName:"SynchronizingCloud",strTaskDetails:"syncfailed"});
 await steam.tick();expect(steam.status().session?.phase).toBe("attention");expect(calls.some(c=>c.startsWith("respond:"))).toBe(false);
 await steam.returnToVault();expect(steam.status().session?.phase).toBe("attention");
 await expect(steam.respond("cloud")).rejects.toThrow("Invalid game choice");
 await steam.respond("local");expect(calls).toContain("respond:42:IgnoreCloud");
 await steam.tick();await steam.respond("cancel");expect(calls).toContain("cancelLaunch:10");
});
test("stale cloud decisions cannot affect a new game action",async()=>{
 const {steam,actions}=fixture();await steam.open("10");actions.push({nGameActionID:42,gameid:"10",bWaitingForUI:true,strTaskName:"SynchronizingCloud",strTaskDetails:"cloudconflict"});await steam.tick();actions[0].gameid="20";
 await expect(steam.respond("cloud")).rejects.toThrow("request changed");
});
