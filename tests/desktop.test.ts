import { test, expect } from "bun:test";
import { createServer as tcpServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instruction, readInstruction } from "../src/daemon/api/desktop";
import { startTestServer, testConfig, TEST_TOKEN } from "./helpers";

function listen(server: ReturnType<typeof tcpServer>): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
}
function receive(ws: WebSocket): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (e) => resolve(e.data), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

test("desktop framing preserves Unicode, partial messages and separators", () => {
  const text = instruction("name", "a;🛥,é");
  expect(readInstruction(text.slice(0, -1))).toBeNull();
  expect(readInstruction(text + instruction("sync", "1"))).toEqual({
    parts: ["name", "a;🛥,é"],
    rest: instruction("sync", "1"),
  });
  expect(() => readInstruction("x.bad;")).toThrow();
});

test("desktop is disabled by default and requires owner authentication", async () => {
  const app = startTestServer();
  try {
    expect((await fetch(app.base + "/api/desktop/status")).status).toBe(401);
    expect(await (await app.api("/api/desktop/status")).json()).toMatchObject({
      enabled: false,
      ready: false,
    });
    const ws = new WebSocket(
      app.wsBase + `/api/desktop/stream?token=${TEST_TOKEN}`,
    );
    const code = await new Promise<number>(
      (resolve) => (ws.onclose = (e) => resolve(e.code)),
    );
    expect(code).toBe(1008);
  } finally {
    app.stop();
  }
});

test("VNC carries binary frames and input through a selected fleet node", async () => {
  const tcp = tcpServer((socket) => {
    socket.write(Buffer.from([82, 70, 66, 0, 255]));
    socket.on("data", (data) => socket.write(data));
  });
  const port = await listen(tcp);
  const target = startTestServer(
    testConfig({ desktop: { enabled: true, backend: "vnc", port } }),
  );
  const relay = startTestServer();
  try {
    relay.db
      .query(
        "INSERT INTO nodes (id,name,url,token,added_at) VALUES (?,?,?,?,?)",
      )
      .run("desktop-test", "desktop", target.base, TEST_TOKEN, Date.now());
    const ws = new WebSocket(
      relay.wsBase +
        `/api/nodes/desktop-test/desktop/stream?token=${TEST_TOKEN}`,
    );
    ws.binaryType = "arraybuffer";
    const frame = await receive(ws);
    expect([...new Uint8Array(frame as ArrayBuffer)]).toEqual([
      82, 70, 66, 0, 255,
    ]);
    const next = receive(ws);
    ws.send(new Uint8Array([0, 200, 255]));
    expect([...new Uint8Array((await next) as ArrayBuffer)]).toEqual([
      0, 200, 255,
    ]);
    ws.close();
  } finally {
    relay.stop();
    target.stop();
    tcp.close();
  }
});

test("RDP performs server-owned handshake without exposing credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-test-"));
  const credentialsFile = join(dir, "credentials.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({ username: "desktop-user", password: "private-secret" }),
  );
  let received = "";
  const tcp = tcpServer((socket) => {
    socket.on("data", (data) => {
      received += data;
      if (data.toString().includes("select"))
        socket.write(
          instruction(
            "args",
            "VERSION_1_5_0",
            "hostname",
            "username",
            "password",
          ),
        );
      if (data.toString().includes("connect"))
        socket.write(
          instruction("ready", "test-id") + instruction("sync", "123"),
        );
    });
  });
  const gatewayPort = await listen(tcp);
  const app = startTestServer(
    testConfig({
      desktop: { enabled: true, backend: "rdp", gatewayPort, credentialsFile },
    }),
  );
  try {
    const ws = new WebSocket(
      app.wsBase +
        `/api/desktop/stream?token=${TEST_TOKEN}&hostname=evil.example`,
    );
    const data = String(await receive(ws));
    expect(data).toContain("test-id");
    expect(data).not.toContain("private-secret");
    expect(received).toContain("127.0.0.1");
    expect(received).toContain("private-secret");
    expect(received).not.toContain("evil.example");
    ws.close();
  } finally {
    app.stop();
    tcp.close();
    rmSync(dir, { recursive: true });
  }
});

test("RDP buffers split TCP instructions before forwarding WebSocket frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-fragments-"));
  const credentialsFile = join(dir, "credentials.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({ username: "user", password: "secret" }),
  );
  const drawing = instruction("size", "0", "1920", "1080");
  const tcp = tcpServer((socket) =>
    socket.on("data", (data) => {
      const text = data.toString();
      if (text.includes("select"))
        socket.write(instruction("args", "hostname"));
      else if (text.includes("connect"))
        socket.write(instruction("ready", "fragment-id") + drawing.slice(0, 4));
      else socket.write(drawing.slice(4));
    }),
  );
  const gatewayPort = await listen(tcp);
  const app = startTestServer(
    testConfig({
      desktop: { enabled: true, backend: "rdp", gatewayPort, credentialsFile },
    }),
  );
  try {
    const ws = new WebSocket(
      app.wsBase + `/api/desktop/stream?token=${TEST_TOKEN}`,
    );
    expect(await receive(ws)).toBe(instruction("", "fragment-id"));
    const next = receive(ws);
    ws.send(instruction("sync", "1"));
    expect(await next).toBe(drawing);
    ws.close();
  } finally {
    app.stop();
    tcp.close();
    rmSync(dir, { recursive: true });
  }
});
