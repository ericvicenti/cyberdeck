import type { Hono } from "hono";
import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import type { CyberdeckConfig } from "../config";

/** Encode a Guacamole instruction, including Unicode character lengths. */
export function instruction(...parts: string[]): string {
  return parts.map((p) => `${Array.from(p).length}.${p}`).join(",") + ";";
}

/** Parse a complete Guacamole handshake instruction; retain incomplete input. */
export function readInstruction(
  text: string,
): { parts: string[]; rest: string } | null {
  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const dot = text.indexOf(".", offset);
    if (dot < 0) return null;
    const length = text.slice(offset, dot);
    if (!/^\d{1,7}$/.test(length)) throw new Error("Invalid desktop protocol");
    let end = dot + 1;
    for (let n = 0; n < Number(length); n++) {
      if (end >= text.length) return null;
      end += text.codePointAt(end)! > 0xffff ? 2 : 1;
    }
    if (end >= text.length) return null;
    parts.push(text.slice(dot + 1, end));
    const delimiter = text[end];
    if (delimiter === ";") return { parts, rest: text.slice(end + 1) };
    if (delimiter !== ",") throw new Error("Invalid desktop protocol");
    offset = end + 1;
  }
  return null;
}

async function available(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Owner-only access to this host's physical desktop. Targets are fixed loopback ports. */
export function registerDesktopRoutes(
  app: Hono,
  cfg: CyberdeckConfig,
  upgradeWebSocket: any,
  isFullAuth: (c: any) => boolean,
) {
  const settings = cfg.desktop;
  const backend =
    settings?.backend ?? (process.platform === "darwin" ? "vnc" : "rdp");
  const port = settings?.port ?? (backend === "vnc" ? 5900 : 3389);
  const gatewayPort = settings?.gatewayPort ?? 4822;
  app.get("/api/desktop/status", async (c) => {
    if (!isFullAuth(c)) return c.json({ error: "Owner access required" }, 403);
    const enabled = settings?.enabled === true;
    const ready =
      enabled &&
      (await available(port)) &&
      (backend === "vnc" || (await available(gatewayPort)));
    return c.json({
      host: cfg.nodeName,
      platform: process.platform,
      backend,
      enabled,
      ready,
      message: ready
        ? "Ready to connect"
        : process.platform === "darwin"
          ? "Enable Screen Sharing in System Settings → General → Sharing, then retry."
          : "Enable desktop sharing in GNOME and install the Cyberdeck desktop gateway on this host.",
    });
  });
  app.get(
    "/api/desktop/stream",
    upgradeWebSocket((c: any) => {
      let socket: Socket | undefined;
      let closed = false;
      let ready = false;
      let handshake = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const decoder = new TextDecoder();
      const width = Math.max(
        640,
        Math.min(3840, Number(c.req.query("width")) || 1440),
      );
      const height = Math.max(
        480,
        Math.min(2160, Number(c.req.query("height")) || 900),
      );
      const finish = (ws: any, reason = "Desktop disconnected") => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        socket?.destroy();
        ws.close(1000, reason);
      };
      return {
        async onOpen(_event: unknown, ws: any) {
          if (!isFullAuth(c) || !settings?.enabled) {
            ws.close(1008, "Desktop access is disabled");
            return;
          }
          let credentials: Record<string, string> = {};
          if (backend === "rdp") {
            try {
              credentials = JSON.parse(
                await readFile(settings.credentialsFile!, "utf8"),
              );
              if (
                typeof credentials.username !== "string" ||
                typeof credentials.password !== "string"
              )
                throw new Error();
            } catch {
              finish(ws, "Desktop credentials are not configured");
              return;
            }
          }
          if (closed) return;
          timer = setTimeout(
            () => finish(ws, "Desktop connection timed out"),
            15000,
          );
          socket = connect({
            host: "127.0.0.1",
            port: backend === "vnc" ? port : gatewayPort,
          });
          socket.on("connect", () => {
            if (backend === "vnc") {
              ready = true;
              clearTimeout(timer);
            } else socket!.write(instruction("select", "rdp"));
          });
          socket.on("data", (data) => {
            if (closed) return;
            if (backend === "vnc") {
              ws.send(data);
              return;
            }
            const text =
              typeof data === "string"
                ? data
                : decoder.decode(data, { stream: true });
            handshake += text;
            if (handshake.length > (ready ? 4194304 : 65536)) {
              finish(ws, "Invalid desktop handshake");
              return;
            }
            try {
              let parsed;
              while ((parsed = readInstruction(handshake))) {
                const frame = handshake.slice(
                  0,
                  handshake.length - parsed.rest.length,
                );
                handshake = parsed.rest;
                if (ready) {
                  ws.send(frame);
                  continue;
                }
                const [opcode, ...args] = parsed.parts;
                if (opcode === "args") {
                  const values: Record<string, string> = {
                    hostname: "127.0.0.1",
                    port: String(port),
                    username: credentials.username!,
                    password: credentials.password!,
                    security: "nla",
                    "ignore-cert": "true",
                    "disable-audio": "true",
                    "enable-wallpaper": "true",
                    "resize-method": "",
                    width: String(width),
                    height: String(height),
                    "color-depth": "32",
                  };
                  socket!.write(
                    instruction("size", String(width), String(height), "96") +
                      instruction("audio") +
                      instruction("video") +
                      instruction("image", "image/png", "image/jpeg") +
                      instruction(
                        "connect",
                        ...args.map((arg) =>
                          arg.startsWith("VERSION_")
                            ? "VERSION_1_5_0"
                            : values[arg] ?? "",
                        ),
                      ),
                  );
                } else if (opcode === "ready") {
                  ready = true;
                  clearTimeout(timer);
                  ws.send(instruction("", args[0]!));
                  // WebSocketTunnel requires whole instructions in each message.
                  // Keep parsing any drawing data already received with ready.
                } else if (opcode === "error") {
                  finish(ws, "Desktop authentication or connection failed");
                  return;
                }
              }
            } catch {
              finish(ws, "Invalid desktop handshake");
            }
          });
          socket.on("end", () => finish(ws));
          socket.on("error", () =>
            finish(ws, "Desktop service is unavailable"),
          );
          socket.on("close", () => finish(ws));
        },
        onMessage(event: { data: string | ArrayBuffer | Uint8Array }, ws: any) {
          if (!ready || closed) return;
          const data = event.data;
          // WebSocketTunnel's internal keepalive is not a guacd instruction.
          if (
            backend === "rdp" &&
            typeof data === "string" &&
            data.startsWith("0.,")
          ) {
            ws.send(data);
            return;
          }
          if (
            (typeof data === "string" ? data.length : data.byteLength) >
              262144 ||
            (socket?.writableLength ?? 0) > 1048576
          ) {
            finish(ws, "Desktop input buffer exceeded");
            return;
          }
          socket?.write(
            typeof data === "string" ? data : Buffer.from(data as ArrayBuffer),
          );
        },
        onClose() {
          closed = true;
          clearTimeout(timer);
          socket?.destroy();
        },
        onError() {
          closed = true;
          clearTimeout(timer);
          socket?.destroy();
        },
      };
    }),
  );
}
