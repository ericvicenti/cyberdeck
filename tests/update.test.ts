// Self-update endpoint + fleet convergence plumbing.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, testConfig, type TestServer } from "./helpers";
import { currentCommit, getLastUpdateAttempt, resetLastUpdateAttempt, setUpdatePersistPath } from "../src/daemon/updater";

let srv: TestServer;
beforeAll(() => {
  srv = startTestServer(); // autoUpdate: false in testConfig
});
afterAll(() => srv.stop());

test("status reports the running git commit", async () => {
  const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
  const expected = (await new Response(proc.stdout).text()).trim();
  expect(await currentCommit()).toBe(expected);
  // allow the server's async commit cache to fill
  const start = Date.now();
  let s: any;
  do {
    s = await (await srv.api("/api/status")).json();
    if (s.commit) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() - start < 3000);
  expect(s.commit).toBe(expected);
  expect(s.updating).toBe(false);
});

test("update is refused when autoUpdate is disabled", async () => {
  const res = await srv.api("/api/system/update", { method: "POST" });
  expect(res.status).toBe(403);
});

test("update check reports drift from origin", async () => {
  const res = await srv.api("/api/system/update?check=1", { method: "POST" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.commit).toMatch(/^[a-f0-9]{7,}$/);
  // offline machines get an error field instead of drift counts
  if (!body.error) {
    expect(body.behind).toBeGreaterThanOrEqual(0);
    expect(body.ahead).toBeGreaterThanOrEqual(0);
  }
}, 30000);

test("rev-list counts drift from a boot commit after the checkout moves forward", async () => {
  // Reproduces the 2026-11-10 bug: when another process pulls ~/.cyberdeck/src,
  // `HEAD..origin/main` reports 0 even though the running daemon is on the pre-pull
  // code. Counting from the boot commit (what we actually run) must reveal the drift.
  const dir = mkdtempSync(join(tmpdir(), "cyberdeck-update-"));
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    const out = (await new Response(p.stdout).text()).trim();
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(p.stderr).text()}`);
    return out;
  };
  try {
    await git("init", "--quiet", "--initial-branch=main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await git("commit", "--allow-empty", "-m", "boot");
    const boot = await git("rev-parse", "HEAD");
    await git("commit", "--allow-empty", "-m", "post-boot-1");
    await git("commit", "--allow-empty", "-m", "post-boot-2");
    // Simulate an external pull: a bare "origin" that already has the new commits.
    const originPath = join(dir, "origin.git");
    const p = Bun.spawn(["git", "clone", "--bare", "--quiet", dir, originPath], { stdout: "pipe", stderr: "pipe" });
    if (await p.exited !== 0) throw new Error("bare clone failed");
    await git("remote", "add", "origin", originPath);
    await git("fetch", "--quiet", "origin");

    // Against the current HEAD (both post-boot commits already here), the old
    // query reports no drift:
    const headProc = Bun.spawn(["git", "-C", dir, "rev-list", "--count", "HEAD..origin/main"], { stdout: "pipe" });
    await headProc.exited;
    const fromHead = parseInt((await new Response(headProc.stdout).text()).trim(), 10);
    expect(fromHead).toBe(0);

    // Against the boot commit, it reveals two post-boot commits — that's what
    // checkForUpdate now uses as its base.
    const bootProc = Bun.spawn(["git", "-C", dir, "rev-list", "--count", `${boot}..origin/main`], { stdout: "pipe" });
    await bootProc.exited;
    const fromBoot = parseInt((await new Response(bootProc.stdout).text()).trim(), 10);
    expect(fromBoot).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rev-list counts local commits that origin does not have (ahead of origin)", async () => {
  // A node that commits locally to ~/.cyberdeck/src without pushing is running code
  // no other machine has. `origin/main..bootFull` surfaces that, which is what
  // DeployState.ahead reports; the Deploy widget then flags it louder than a pending pull.
  const dir = mkdtempSync(join(tmpdir(), "cyberdeck-ahead-"));
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    const out = (await new Response(p.stdout).text()).trim();
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(p.stderr).text()}`);
    return out;
  };
  try {
    await git("init", "--quiet", "--initial-branch=main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await git("commit", "--allow-empty", "-m", "shared");
    const originPath = join(dir, "origin.git");
    const p = Bun.spawn(["git", "clone", "--bare", "--quiet", dir, originPath], { stdout: "pipe", stderr: "pipe" });
    if (await p.exited !== 0) throw new Error("bare clone failed");
    await git("remote", "add", "origin", originPath);
    await git("fetch", "--quiet", "origin");
    // Three unpushed commits on top; this is yacht's state on 2026-11-22.
    await git("commit", "--allow-empty", "-m", "local-only-1");
    await git("commit", "--allow-empty", "-m", "local-only-2");
    await git("commit", "--allow-empty", "-m", "local-only-3");
    const boot = await git("rev-parse", "HEAD");

    const behindProc = Bun.spawn(["git", "-C", dir, "rev-list", "--count", `${boot}..origin/main`], { stdout: "pipe" });
    await behindProc.exited;
    expect(parseInt((await new Response(behindProc.stdout).text()).trim(), 10)).toBe(0);

    const aheadProc = Bun.spawn(["git", "-C", dir, "rev-list", "--count", `origin/main..${boot}`], { stdout: "pipe" });
    await aheadProc.exited;
    expect(parseInt((await new Response(aheadProc.stdout).text()).trim(), 10)).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastAttempt persists across a simulated daemon restart", async () => {
  // A chronic auto-update failure must still be visible on the Deploy widget right after a daemon
  // restart, not hidden for up to an hour until the next cycle writes a fresh in-memory copy.
  // setUpdatePersistPath wires a JSON file; a later call with the same path (the "restart") reloads it.
  const dir = mkdtempSync(join(tmpdir(), "cyberdeck-lastattempt-"));
  const path = join(dir, "last-update.json");
  try {
    resetLastUpdateAttempt();
    setUpdatePersistPath(path);
    // No prior file -> no attempt loaded, no file written yet.
    expect(getLastUpdateAttempt()).toBeNull();
    expect(existsSync(path)).toBe(false);

    // Seed the file as if a previous process had recorded a failure, then "restart" by re-pointing
    // the persist path. The new process reads what was there.
    const failure = { at: Date.now() - 20 * 60 * 1000, ok: false, detail: "git pull failed: fatal: Not possible to fast-forward, aborting." };
    writeFileSync(path, JSON.stringify(failure));
    resetLastUpdateAttempt(); // wipes memory AND the file if a path is set
    expect(existsSync(path)).toBe(false);

    // Re-seed and re-point to simulate boot after a prior process wrote the file.
    writeFileSync(path, JSON.stringify(failure));
    setUpdatePersistPath(null); // detach so the next set is a true cold boot
    resetLastUpdateAttempt();
    writeFileSync(path, JSON.stringify(failure)); // reset deleted it; put it back
    setUpdatePersistPath(path);
    const loaded = getLastUpdateAttempt();
    expect(loaded).not.toBeNull();
    expect(loaded!.ok).toBe(false);
    expect(loaded!.detail).toContain("Not possible to fast-forward");

    // Garbage in the file does not crash boot and leaves lastAttempt null.
    setUpdatePersistPath(null);
    resetLastUpdateAttempt();
    writeFileSync(path, "not json");
    setUpdatePersistPath(path);
    expect(getLastUpdateAttempt()).toBeNull();

    // A missing `detail` field is rejected, not loaded as half-valid.
    setUpdatePersistPath(null);
    resetLastUpdateAttempt();
    writeFileSync(path, JSON.stringify({ at: 1, ok: false }));
    setUpdatePersistPath(path);
    expect(getLastUpdateAttempt()).toBeNull();
  } finally {
    // Leave persistence off for the rest of the suite.
    setUpdatePersistPath(null);
    resetLastUpdateAttempt();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update endpoint on an up-to-date autoUpdate node is a safe no-op", async () => {
  const enabled = startTestServer(testConfig({ autoUpdate: true }));
  try {
    const res = await enabled.api("/api/system/update", { method: "POST" });
    const body = await res.json();
    // dev checkouts are at-or-ahead of origin, so this must NOT restart
    if (res.status === 200) expect(body.detail ?? "").toContain("up to date");
  } finally {
    enabled.stop();
  }
}, 30000);
