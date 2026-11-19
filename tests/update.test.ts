// Self-update endpoint + fleet convergence plumbing.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTestServer, testConfig, type TestServer } from "./helpers";
import { currentCommit } from "../src/daemon/updater";

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
  // offline machines get an error field instead of a behind count
  if (!body.error) expect(body.behind).toBeGreaterThanOrEqual(0);
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
