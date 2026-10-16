/* EmulatorJS 4.2.3 adapter. The pinned GameManager API is exercised by the real-core browser test. */
(() => {
  let session = "",
    emulator,
    started = false,
    initialized = false,
    paused = false;
  const urls = [];
  // Some browsers deny the core's optional screen wake lock in an iframe.
  // That does not affect emulation, input, or saves; leave other errors visible.
  addEventListener("unhandledrejection", (event) => {
    if (
      event.reason?.name === "NotAllowedError" &&
      /wake lock/i.test(event.reason.message)
    )
      event.preventDefault();
  });
  const send = (type, extra = {}) =>
    parent.postMessage(
      { source: "vault-player", session, type, ...extra },
      location.origin,
    );
  const fail = (error) => {
    const message = error?.message || String(error);
    const banner = document.getElementById("player-error");
    banner.textContent = message;
    banner.hidden = false;
    send("error", { message });
  };
  const blobUrl = (blob) => {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return url;
  };
  const save = (requestId, closing = false) => {
    if (!started) {
      send("not-started", { requestId, closing });
      return;
    }
    try {
      emulator.gameManager.saveSaveFiles();
      send("state", {
        data: emulator.gameManager.getState(),
        requestId,
        closing,
      });
    } catch (error) {
      send("save-error", {
        message: "Couldn't save progress: " + error.message,
        requestId,
        closing,
      });
    }
  };
  const exit = () => send("menu-request");
  addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      event.origin !== location.origin ||
      event.data?.source !== "vault-host"
    )
      return;
    const message = event.data;
    if (message.type === "init" && !initialized) {
      if (
        !(message.rom instanceof Blob) ||
        typeof message.session !== "string" ||
        ![
          "nestopia",
          "snes9x",
          "mupen64plus_next",
          "gambatte",
          "mgba",
          "genesis_plus_gx",
        ].includes(message.core)
      )
        return;
      initialized = true;
      session = message.session;
      try {
        if (!window.EmulatorJS)
          throw new Error(
            "The emulator assets are missing. Rebuild Cyberdeck and try again.",
          );
        // No external version polling; the application pins and verifies all engine assets.
        EmulatorJS.prototype.checkForUpdates = () => {};
        emulator = new EmulatorJS("#game", {
          system: message.core,
          controlScheme: message.scheme,
          dataPath: "/emulatorjs/4.2.3/",
          gameUrl: blobUrl(message.rom),
          gameName: "vault-" + message.digest,
          gameId: parseInt(message.digest.slice(0, 8), 16),
          loadState: message.state
            ? blobUrl(new Blob([message.state]))
            : undefined,
          color: "#9fc74e",
          backgroundColor: "#080b10",
          startBtnName: "Start playing",
          startOnLoad: true,
          threads: false,
          disableCue: true,
          volume: 0.7,
          hideSettings: ["retroarch_core", "ejs_threads"],
          buttonOpts: { exitEmulation: false, netplay: false, rightClick: false },
          defaultOptions: { "save-state-location": "browser", ...(message.core === "mupen64plus_next" ? {
            "mupen64plus-43screensize": "320x240",
            "mupen64plus-EnableNativeResFactor": "1",
            "mupen64plus-MultiSampling": "0",
            "mupen64plus-FXAA": "0",
          } : {}) },
        });
        emulator.on("ready", () => send("ready"));
        emulator.on("start", () => {
          started = true;
          paused = false;
          send("started");
        });
        emulator.on("exit", exit);
        emulator.on("saveState", (e) =>
          send("state", { data: e.state, requestId: "menu" }),
        );
        const observer = new MutationObserver(() => {
          const error = document.querySelector(".ejs_error_text");
          if (error) {
            observer.disconnect();
            fail(new Error(error.textContent));
          }
        });
        observer.observe(document.getElementById("game"), {
          subtree: true,
          childList: true,
          attributes: true,
        });
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (message.session !== session) return;
    if (message.type === "save") save(message.requestId, message.closing);
    if (message.type === "pause" && started) {
      paused = typeof message.paused === "boolean" ? message.paused : !paused;
      paused ? emulator.pause() : emulator.play();
      send("paused", { paused });
    }
    if (
      message.type === "load" &&
      started &&
      message.data instanceof Uint8Array
    ) {
      try {
        emulator.gameManager.loadState(message.data);
        send("loaded");
      } catch (error) {
        fail(error);
      }
    }
  });
  addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      exit();
    },
    true,
  );
  addEventListener("pointermove", () => send("pointer"));
  addEventListener("pointerdown", () => send("pointer"));
  addEventListener("pagehide", () => {
    for (const url of urls) URL.revokeObjectURL(url);
  });
  send("hello");
})();
