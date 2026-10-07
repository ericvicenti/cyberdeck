import { test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, TEST_TOKEN, type TestServer } from "./helpers";

let srv: TestServer;
beforeAll(() => { srv = startTestServer(); });
afterAll(() => srv.stop());

type Msg = { t: string; data?: string; code?: number; replay?: boolean; session?: any };
function attach(id: string, params = ""): Promise<{ ws: WebSocket; msgs: Msg[]; output: () => string; closed: Promise<void> }> {
  const ws = new WebSocket(`${srv.wsBase}/api/sessions/${id}/attach?token=${TEST_TOKEN}${params}`);
  const msgs: Msg[] = [];
  ws.addEventListener("message", (ev) => { try { msgs.push(JSON.parse(String(ev.data))); } catch {} });
  const closed = new Promise<void>((r) => ws.addEventListener("close", () => r()));
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, msgs, output: () => msgs.filter((m) => m.t === "data").map((m) => m.data).join(""), closed }));
    ws.addEventListener("error", reject);
  });
}
async function until(fn: () => boolean, ms = 10000) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); }
}
const create = async (body: Record<string, unknown>) => {
  const res = await srv.api("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return res.json();
};

test("a session runs its startup command and survives detaching; re-attach replays the backlog", async () => {
  const s = await create({ cmd: "echo boot_$((40+2))", title: "boot test", tool: "shell", runner: "pty" });
  expect(s.id).toMatch(/^[0-9a-f]{8}$/);
  expect(s.state).toBe("running");
  expect(s.runner).toBe("pty");

  const a = await attach(s.id);
  await until(() => a.output().includes("boot_42"));
  expect(a.msgs[0].t).toBe("hello");
  expect(a.msgs[0].session.title).toBe("boot test");
  a.ws.close();
  await a.closed;

  // still listed as running with no clients
  const list = (await (await srv.api("/api/sessions")).json()).sessions;
  const mine = list.find((x: any) => x.id === s.id);
  expect(mine.state).toBe("running");
  expect(mine.clients).toBe(0);

  // output produced while nobody was attached is replayed on re-attach
  const res = await srv.api(`/api/sessions/${s.id}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: "echo later_$((1+1))", enter: true }) });
  expect(res.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 600));
  const b = await attach(s.id);
  await until(() => b.output().includes("later_2"));
  expect(b.msgs.find((m) => m.t === "data")?.replay).toBe(true);
  expect(b.output()).toContain("boot_42");

  // typing through the socket works and resize is applied
  b.ws.send(JSON.stringify({ t: "resize", cols: 91, rows: 37 }));
  b.ws.send(JSON.stringify({ t: "input", data: "stty size\r" }));
  await until(() => /37 91/.test(b.output()));
  b.ws.close();

  // delete kills it
  expect((await srv.api(`/api/sessions/${s.id}`, { method: "DELETE" })).ok).toBe(true);
  expect((await srv.api(`/api/sessions/${s.id}`)).status).toBe(404);
}, 30000);

test("exit is reported and the row remains until removed", async () => {
  const s = await create({ cmd: "exit 3", runner: "pty" });
  const a = await attach(s.id);
  await until(() => a.msgs.some((m) => m.t === "exit"));
  expect(a.msgs.find((m) => m.t === "exit")!.code).toBe(3);
  await until(() => true);
  const info = await (await srv.api(`/api/sessions/${s.id}`)).json();
  expect(info.state).toBe("exited");
  expect(info.exitCode).toBe(3);
  // attaching to an exited session replays its final screen, reports the exit, and closes
  const b = await attach(s.id);
  await b.closed;
  expect(b.msgs.find((m) => m.t === "exit")!.code).toBe(3);
  expect(b.msgs[0].session.state).toBe("exited");
  await srv.api(`/api/sessions/${s.id}`, { method: "DELETE" });
}, 20000);

test("cwd with ~ expands; bad input is rejected; rename works", async () => {
  const s = await create({ cwd: "~", cmd: "pwd", runner: "pty" });
  expect(s.cwd.startsWith("/")).toBe(true);
  expect(s.cwd).not.toContain("~");
  expect((await srv.api("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runner: "nope" }) })).status).toBe(400);
  expect((await srv.api("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "bash" }) })).status).toBe(400);
  expect((await srv.api(`/api/sessions/${s.id}/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "renamed" }) })).ok).toBe(true);
  expect((await (await srv.api(`/api/sessions/${s.id}`)).json()).title).toBe("renamed");
  await srv.api(`/api/sessions/${s.id}`, { method: "DELETE" });
});

test("attach without a token gets no shell output", async () => {
  const s = await create({ cmd: "echo leak_$((2+2))", runner: "pty" });
  const ws = new WebSocket(`${srv.wsBase}/api/sessions/${s.id}/attach`);
  let out = "";
  ws.addEventListener("message", (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.t === "data") out += m.data; } catch {} });
  await new Promise((r) => { ws.addEventListener("close", r); ws.addEventListener("error", r); setTimeout(r, 2500); });
  expect(out).not.toContain("leak_4");
  try { ws.close(); } catch {}
  await srv.api(`/api/sessions/${s.id}`, { method: "DELETE" });
});

test("capabilities endpoint reports booleans", async () => {
  const caps = await (await srv.api("/api/harness/caps")).json();
  for (const k of ["cc", "cx", "tmux", "cmux"]) expect(typeof caps[k]).toBe("boolean");
}, 20000);
