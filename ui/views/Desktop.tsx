/// <reference types="novnc__novnc" />
import { useEffect, useRef, useState } from "react";
import Guacamole from "guacamole-common-js";
import RFB from "@novnc/novnc/lib/rfb";
import { api, desktopWsUrl, navigate, routeNode } from "../lib/api";
import { useFleet } from "../lib/fleet";
import { NodePicker } from "../components/NodePicker";

type Status = {
  host: string;
  platform: string;
  backend: "rdp" | "vnc";
  ready: boolean;
  message: string;
};

/** Interactive physical desktop of one Cyberdeck host: the machine is in the URL (`?node=`) and picked in the header. */
export function Desktop({ params }: { params: URLSearchParams }) {
  const node = routeNode(params);
  const { targets } = useFleet();
  const target = targets.find((t) => t.id === node);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState(0);
  const [credentials, setCredentials] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [text, setText] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const client = useRef<Guacamole.Client | null>(null);
  const vnc = useRef<RFB | null>(null);
  const disconnect = useRef<() => void>(() => {});
  const refresh = async () => {
    setError("");
    try {
      setStatus(await api<Status>("/api/desktop/status", { node }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!session || !status || !screen.current || !viewport.current) return;
    let alive = true;
    let resize: ResizeObserver | undefined;
    let keyboard: Guacamole.Keyboard | undefined;
    const container = screen.current;
    const frame = viewport.current;
    container.replaceChildren();
    setConnecting(true);
    setConnected(false);
    setError("");
    setCredentials(false);
    if (status.backend === "vnc" && !window.isSecureContext) {
      setConnecting(false);
      setError(
        "Mac sign-in needs HTTPS or localhost. Open Cyberdeck through its private HTTPS address or SSH tunnel.",
      );
      return;
    }
    const url = new URL(desktopWsUrl({
      width: String(Math.round(frame.clientWidth)),
      height: String(Math.round(frame.clientHeight)),
    }, node));
    const up = () => {
      if (alive) {
        setConnecting(false);
        setConnected(true);
        container.focus();
      }
    };
    const down = (message: string) => {
      if (alive) {
        setConnecting(false);
        setConnected(false);
        setCredentials(false);
        setPassword("");
        setError((previous) => previous || message);
      }
    };
    if (status.backend === "vnc") {
      const rfb = new RFB(container, url.toString());
      vnc.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener("connect", up);
      rfb.addEventListener("disconnect", (event) =>
        down(
          event.detail.clean
            ? "Disconnected"
            : "Screen Sharing disconnected. Check that it is enabled and your login is allowed.",
        ),
      );
      rfb.addEventListener("credentialsrequired", () => {
        if (alive) setCredentials(true);
      });
      rfb.addEventListener("securityfailure", () =>
        down(
          "Screen Sharing rejected the login. Check your Mac username and password.",
        ),
      );
      disconnect.current = () => rfb.disconnect();
    } else {
      const tunnel = new Guacamole.WebSocketTunnel(url.origin + url.pathname);
      const guac = new Guacamole.Client(tunnel);
      client.current = guac;
      const display = guac.getDisplay();
      container.appendChild(display.getElement());
      const scale = () => {
        if (display.getWidth() && display.getHeight())
          display.scale(
            Math.min(
              frame.clientWidth / display.getWidth(),
              frame.clientHeight / display.getHeight(),
              1,
            ),
          );
      };
      resize = new ResizeObserver(scale);
      resize.observe(frame);
      display.onresize = () => {
        scale();
        if (display.getWidth() && display.getHeight()) up();
      };
      guac.onstatechange = (state) => {
        if (state === 5) down("Disconnected");
      };
      guac.onerror = (e) => down(e.message || "Desktop connection failed");
      tunnel.onerror = (e) =>
        down(e.message || "Desktop service is unavailable");
      const mouse = new Guacamole.Mouse(display.getElement());
      const touch = new Guacamole.Mouse.Touchscreen(display.getElement());
      for (const input of [mouse, touch])
        input.onEach(["mousedown", "mousemove", "mouseup"], (event: any) => {
          container.focus();
          guac.sendMouseState(event.state, true);
        });
      keyboard = new Guacamole.Keyboard(container);
      keyboard.onkeydown = (key) => {
        guac.sendKeyEvent(1, key);
        return false;
      };
      keyboard.onkeyup = (key) => guac.sendKeyEvent(0, key);
      container.onblur = () => {
        keyboard?.reset();
        guac.sendMouseState(
          new Guacamole.Mouse.State(0, 0, false, false, false, false, false),
        );
      };
      disconnect.current = () => guac.disconnect();
      guac.connect(url.search.slice(1));
    }
    return () => {
      alive = false;
      keyboard?.reset();
      resize?.disconnect();
      disconnect.current();
      container.onblur = null;
      container.replaceChildren();
      client.current = null;
      vnc.current = null;
    };
  }, [session]);
  const key = (keysym: number, code?: string) => {
    client.current?.sendKeyEvent(1, keysym);
    client.current?.sendKeyEvent(0, keysym);
    vnc.current?.sendKey(keysym, code ?? null);
  };
  const typeText = () => {
    for (const char of text) {
      const point = char.codePointAt(0)!;
      key(char === "\n" ? 0xff0d : point <= 0xff ? point : 0x01000000 | point);
    }
    setText("");
    screen.current?.focus();
  };
  return (
    <section
      className="flex h-full min-h-96 flex-col bg-zinc-950 text-zinc-200"
      aria-label="Remote desktop"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-4">
        <div className="mr-auto">
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            Desktop{" "}
            {targets.length > 1 || (node && !target) ? (
              <NodePicker value={node} onChange={(n) => navigate("desktop", { node: n || undefined })} targets={targets} testId="desktop-node" title="which machine's desktop" />
            ) : null}
            <span className="text-zinc-500">/ {status?.host ?? (target?.name ?? "…")}</span>
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            The host’s screen, keyboard and mouse
          </p>
        </div>
        <span
          role="status"
          className={`text-xs ${
            connected ? "text-emerald-400" : "text-zinc-400"
          }`}
        >
          {connected
            ? "● Connected"
            : connecting
              ? "Connecting…"
              : "Disconnected"}
        </span>
        {connected || connecting ? (
          <button
            className="rounded border border-zinc-700 px-3 py-2 text-xs"
            onClick={() => {
              disconnect.current();
              setSession(0);
              setConnecting(false);
              setConnected(false);
              setCredentials(false);
              setPassword("");
            }}
          >
            Disconnect
          </button>
        ) : (
          <button
            disabled={!status?.ready}
            className="rounded bg-emerald-400 px-4 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-30"
            onClick={() => setSession((n) => n + 1)}
          >
            Connect
          </button>
        )}
        <button
          className="rounded border border-zinc-700 px-3 py-2 text-xs"
          onClick={() => {
            void viewport.current
              ?.requestFullscreen()
              .catch(() =>
                setError("Fullscreen is unavailable in this browser."),
              );
          }}
        >
          Fullscreen
        </button>
      </header>
      {error && (
        <p
          role="alert"
          className="border-b border-amber-900 bg-amber-950/30 px-5 py-3 text-sm text-amber-200"
        >
          {error}
        </p>
      )}
      <div
        ref={viewport}
        className="relative flex min-h-80 flex-1 items-center justify-center overflow-hidden bg-black"
      >
        <div
          ref={screen}
          tabIndex={0}
          aria-label="Host screen — click to control"
          className="max-h-full max-w-full outline-none"
          style={{
            touchAction: "none",
            ...(status?.backend === "vnc"
              ? { width: "100%", height: "100%" }
              : {}),
          }}
        />
        {!session && (
          <div className="absolute max-w-lg px-8 text-center">
            <div className="mb-4 text-5xl text-zinc-700" aria-hidden>
              ▣
            </div>
            <h2 className="text-xl font-medium">
              {status?.ready
                ? `${status.host} is ready`
                : "Set up desktop sharing"}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              {status?.ready
                ? "Connect to see the live desktop. Click the screen to use your keyboard; touch to point and scroll."
                : status?.message ?? "Checking the host…"}
            </p>
            <button
              className="mt-5 text-sm text-emerald-400 underline underline-offset-4"
              onClick={() => void refresh()}
            >
              Check connection
            </button>
          </div>
        )}
        {credentials && (
          <form
            className="absolute w-80 rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-xl"
            onSubmit={(e) => {
              e.preventDefault();
              vnc.current?.sendCredentials({ username, password, target: "" });
              setPassword("");
              setCredentials(false);
            }}
          >
            <h2 className="mb-4 font-semibold">Sign in to {status?.host}</h2>
            <label className="block text-xs text-zinc-400">
              Mac username
              <input
                autoComplete="username"
                className="my-2 w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Password
              <input
                type="password"
                autoComplete="current-password"
                className="my-2 w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-sm text-white"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="mt-2 w-full rounded bg-emerald-400 p-2 text-sm font-semibold text-zinc-950">
              Sign in
            </button>
            <p className="mt-3 text-xs text-zinc-500">
              Used for this connection only.
            </p>
          </form>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-4 py-3">
        <span className="mr-2 text-xs text-zinc-500">Send key</span>
        {[
          ["Esc", 0xff1b, "Escape"],
          ["Tab", 0xff09, "Tab"],
          ["Enter", 0xff0d, "Enter"],
          [status?.platform === "darwin" ? "⌘" : "Super", 0xffeb, "MetaLeft"],
        ].map(([label, value, code]) => (
          <button
            key={label}
            disabled={!connected}
            className="rounded border border-zinc-800 px-3 py-1 text-xs disabled:opacity-30"
            onClick={() => key(Number(value), String(code))}
          >
            {label}
          </button>
        ))}
        <form
          className="ml-auto flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            typeText();
          }}
        >
          <input
            aria-label="Text to type on host"
            placeholder="Type on host…"
            disabled={!connected}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-w-0 rounded border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs"
          />
          <button
            disabled={!connected || !text}
            className="text-xs text-emerald-400 disabled:opacity-30"
          >
            Send
          </button>
        </form>
      </footer>
    </section>
  );
}
