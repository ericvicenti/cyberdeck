import {
  ACTIONS,
  defaults,
  labelBinding,
  nearest,
  PadDriver,
  sanitizeSettings,
  type Action,
  type Binding,
  type Direction,
  type Pad,
  type Profile,
  type Settings,
} from "./model";
export type Bridge = (command: string, data?: any) => Promise<any>;
export type TVRuntime = ReturnType<typeof installTVInput>;
declare global {
  interface Window {
    __cyberdeckTV?: any;
    __cyberdeckInputBridge?: Bridge;
  }
}
const KEY = "cyberdeck-tv-input-v1";
const SELECTOR =
  'button,a[href],input:not([type=hidden]),textarea,select,summary,[tabindex]:not([tabindex="-1"]),[role=button],[role=menuitem],[role=tab],[role=checkbox],[contenteditable=true],iframe,video';
export function installTVInput(
  options: { kiosk?: boolean; bridge?: Bridge } = {},
) {
  if (location.pathname === "/vault-player.html") return;
  if (window.__cyberdeckTV) return window.__cyberdeckTV;
  let saved: any;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {}
  let settings = sanitizeSettings(saved),
    currentPad: Pad | null = null,
    statusError = "",
    active = false,
    overlay: HTMLDivElement | null = null,
    overlayReturn: HTMLElement | null = null;
  let confirmResolve: ((value: boolean) => void) | null = null;
  let highlighted: HTMLElement | null = null,
    lastFocus: HTMLElement | null = null,
    lastBox: DOMRect | null = null,
    rangeEdit: HTMLElement | null = null,
    disposed = false;
  let capture: {
    target: Action | "scrollX" | "scrollY";
    start: number;
    ready: boolean;
    axes: number[];
    callback: (text: string) => void;
  } | null = null;
  const drivers = new Map<number, PadDriver>(),
    driver = { reset: () => drivers.forEach((d) => d.reset()) },
    listeners = new Set<() => void>(),
    history = new Map<string, HTMLElement>();
  let route = location.href,
    restoringRoute = false;
  const routeStack: string[] = [];
  const bridge = options.bridge;
  const emit = () => {
    for (const fn of listeners) fn();
  };
  const profile = () =>
    settings.profiles[currentPad?.id || "default"] ??
    settings.profiles.default ??
    defaults();
  const isVisible = (el: Element) => {
    if (el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  };
  const scope = (): Element | Document =>
    overlay ??
    Array.from(
      document.querySelectorAll("dialog[open],[role=dialog],[aria-modal=true]"),
    )
      .filter(isVisible)
      .at(-1) ??
    document.fullscreenElement ??
    document;
  const candidates = (): HTMLElement[] =>
    Array.from(scope().querySelectorAll<HTMLElement>(SELECTOR)).filter(
      (el) =>
        !el.closest("[data-tv-decoration]") &&
        !el.matches(".skip-link") &&
        !(el as HTMLInputElement).disabled &&
        el.getAttribute("aria-disabled") !== "true" &&
        isVisible(el),
    );
  const style = document.createElement("style");
  style.dataset.tvDecoration = "";
  style.textContent = `
    html[data-cyberdeck-tv] [data-testid^="nav-"]:focus::after { content:attr(title); position:absolute; left:calc(100% + 14px); z-index:2147483645; padding:8px 14px; border:1px solid #a3e635; border-radius:8px; background:#152339; color:#fff; font:20px system-ui; white-space:nowrap; pointer-events:none; }
    html[data-cyberdeck-tv] :focus { outline:4px solid #a3e635!important; outline-offset:4px!important; }
    html[data-cyberdeck-tv] [data-tv-focused] { outline:4px solid #a3e635!important; outline-offset:4px!important; }
    html[data-cyberdeck-tv] .player-frame:focus-within .player-controls {opacity:1!important;visibility:visible!important;pointer-events:auto!important}
    .cd-tv-overlay{position:fixed!important;inset:0!important;z-index:2147483646!important;background:#090d16f5!important;color:#eef6ff!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;padding:24px!important;font:22px system-ui!important;box-sizing:border-box!important;overflow:auto!important}
    .cd-tv-overlay h2{font:600 28px system-ui!important;margin:0 0 12px!important;color:#eef6ff!important}
    .cd-tv-overlay p{font:18px system-ui!important;color:#b6c5d6!important;margin:8px!important}
    .cd-tv-overlay button{font:22px system-ui!important;min-height:48px!important;min-width:48px!important;padding:10px 16px!important;color:#eff6ff!important;background:#1c2b40!important;border:2px solid #40556e!important;border-radius:10px!important;cursor:pointer!important}
    .cd-tv-overlay button:focus{background:#294a42!important;border-color:#a3e635!important}
    .cd-tv-keys{display:grid!important;grid-template-columns:repeat(10,minmax(44px,1fr))!important;gap:9px!important;width:min(900px,94vw)!important}
    .cd-tv-value{white-space:pre-wrap!important;overflow-wrap:anywhere!important;max-height:100px!important;overflow:auto!important;padding:12px!important;background:#132034!important;border-radius:8px!important;width:min(880px,90vw)!important;min-height:28px!important;box-sizing:border-box!important}
    .cd-tv-actions{display:flex!important;flex-wrap:wrap!important;justify-content:center!important;gap:10px!important;margin-top:14px!important}
    .cd-tv-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#152339;color:white;padding:12px 20px;border:1px solid #6b90a8;border-radius:12px;font:18px system-ui;pointer-events:none;max-width:80vw}
  `;
  const attachStyle = () => {
    if (!style.isConnected)
      (document.head ?? document.documentElement)?.append(style);
  };
  attachStyle();
  const toast = (text: string) => {
    const el = document.createElement("div");
    el.dataset.tvDecoration = "";
    el.className = "cd-tv-toast";
    el.setAttribute("role", "status");
    el.textContent = text;
    document.documentElement.append(el);
    setTimeout(() => el.remove(), 2400);
  };
  const turnOn = () => {
    active = true;
    document.documentElement.dataset.cyberdeckTv = "";
    attachStyle();
  };
  const focus = (el: HTMLElement | null) => {
    if (!el || !isVisible(el)) return;
    turnOn();
    highlighted?.removeAttribute("data-tv-focused");
    highlighted = el;
    el.setAttribute("data-tv-focused", "");
    if (
      !el.hasAttribute("tabindex") &&
      !el.matches("button,a,input,textarea,select,summary,iframe,video")
    )
      el.tabIndex = 0;
    el.focus({ preventScroll: true });
    el.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
    lastFocus = el;
    lastBox = el.getBoundingClientRect();
    history.set(route, el);
    // An embedded app is a container, not a stop: step straight into it.
    if (el instanceof HTMLIFrameElement) void bridge?.("enterFrame");
  };
  const first = () => {
    const all = candidates();
    return (
      all.find((el) => el.matches("[data-tv-autofocus]")) ??
      all.find((el) => el.matches('[data-testid="nav-fleet"]')) ??
      all[0] ??
      null
    );
  };
  const remember = () => {
    const el = document.activeElement as HTMLElement;
    if (el && el !== document.body && !el.closest("[data-tv-decoration]")) {
      lastFocus = el;
      lastBox = el.getBoundingClientRect();
      history.set(route, el);
    }
  };
  const getCurrent = () => {
    const el = document.activeElement as HTMLElement;
    return candidates().includes(el)
      ? el
      : lastFocus?.isConnected && candidates().includes(lastFocus)
        ? lastFocus
        : null;
  };
  const closeOverlay = () => {
    confirmResolve?.(false);
    confirmResolve = null;
    const el = overlayReturn;
    overlay?.remove();
    overlay = null;
    overlayReturn = null;
    if (el?.isConnected) focus(el);
    else focus(first());
  };
  const makeOverlay = (title: string) => {
    overlayReturn = getCurrent();
    overlay = document.createElement("div");
    overlay.className = "cd-tv-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", title);
    const h = document.createElement("h2");
    h.textContent = title;
    overlay.append(h);
    (
      document.fullscreenElement ??
      document.body ??
      document.documentElement
    ).append(overlay);
    return overlay;
  };
  const button = (label: string, run: () => void, parent: Element) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = run;
    parent.append(b);
    return b;
  };
  const editable = (el: HTMLElement | null) =>
    !!el &&
    (el.matches("textarea,[contenteditable=true],.xterm-helper-textarea") ||
      el.matches(
        "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=button]):not([type=submit])",
      ));
  const setValue = (
    el: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  function keyboard(target = getCurrent()) {
    if (overlay) return;
    if (!editable(target)) {
      toast("Focus a text field, then press Select to type.");
      return;
    }
    const el = target as HTMLElement;
    let value =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.value
          : (el.textContent ?? ""),
      position = value.length,
      shift = false,
      symbols = false;
    const original = value;
    const root = makeOverlay(
      el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        "Type with the controller",
    );
    const display = document.createElement("div");
    display.className = "cd-tv-value";
    display.setAttribute("aria-live", "polite");
    root.append(display);
    const grid = document.createElement("div");
    grid.className = "cd-tv-keys";
    root.append(grid);
    const actions = document.createElement("div");
    actions.className = "cd-tv-actions";
    root.append(actions);
    const update = () => {
      const rendered =
        el instanceof HTMLInputElement && el.type === "password"
          ? "•".repeat(value.length)
          : value;
      display.textContent =
        rendered.slice(0, position) + "│" + rendered.slice(position);
    };
    const insert = (text: string) => {
      value = value.slice(0, position) + text + value.slice(position);
      position += text.length;
      update();
    };
    const draw = () => {
      grid.replaceChildren();
      const chars = symbols
        ? "!@#$%^&*()_+-=[]{}\\|;:'\",.<>/?`~0123456789"
        : "1234567890qwertyuiopasdfghjklzxcvbnm.,";
      for (const ch of chars)
        button(
          shift ? ch.toUpperCase() : ch,
          () => insert(shift ? ch.toUpperCase() : ch),
          grid,
        );
    };
    const finish = () => {
      closeOverlay();
      if (el.isConnected) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
          setValue(el, value);
        else {
          el.focus();
          document.execCommand("selectAll");
          document.execCommand("insertText", false, value);
        }
        focus(el);
        toast("Text entered. Move to the next control to continue.");
      }
    };
    button("Space", () => insert(" "), actions);
    button(
      "⌫ Delete",
      () => {
        if (position) {
          value = value.slice(0, position - 1) + value.slice(position);
          position--;
        }
        update();
      },
      actions,
    );
    button(
      "Cursor ←",
      () => {
        position = Math.max(0, position - 1);
        update();
      },
      actions,
    );
    button(
      "Cursor →",
      () => {
        position = Math.min(value.length, position + 1);
        update();
      },
      actions,
    );
    button(
      "Shift",
      () => {
        shift = !shift;
        draw();
      },
      actions,
    );
    button(
      "Symbols",
      () => {
        symbols = !symbols;
        draw();
      },
      actions,
    );
    button(
      "Clear",
      () => {
        value = "";
        position = 0;
        update();
      },
      actions,
    );
    button(
      "Cancel",
      () => {
        value = original;
        closeOverlay();
      },
      actions,
    );
    button("Done", finish, actions);
    const hint = document.createElement("p");
    hint.textContent = "Arrows to choose · Select to type · Back to cancel";
    root.append(hint);
    draw();
    update();
    focus(grid.querySelector("button"));
  }
  function confirm(message: string): Promise<boolean> {
    if (overlay) return Promise.resolve(false);
    const root = makeOverlay("Confirm action");
    const detail = document.createElement("p");
    detail.textContent = message;
    root.append(detail);
    return new Promise((resolve) => {
      confirmResolve = resolve;
      const cancel = button("Cancel", closeOverlay, root);
      button(
        "Confirm",
        () => {
          confirmResolve = null;
          closeOverlay();
          resolve(true);
        },
        root,
      );
      focus(cancel);
    });
  }
  function selectMenu(el: HTMLSelectElement) {
    const root = makeOverlay(
      el.getAttribute("aria-label") || el.title || "Choose an option",
    );
    const list = document.createElement("div");
    list.className = "cd-tv-actions";
    list.style.flexDirection = "column";
    list.style.maxHeight = "65vh";
    list.style.overflow = "auto";
    root.append(list);
    let selected: HTMLButtonElement | null = null;
    for (const o of Array.from(el.options)) {
      if (o.disabled) continue;
      const b = button(
        o.text,
        () => {
          el.value = o.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          closeOverlay();
        },
        list,
      );
      if (o.selected) selected = b;
    }
    button("Cancel", closeOverlay, root);
    focus(selected ?? list.querySelector("button"));
  }
  function scroll(x: number, y: number) {
    turnOn();
    const current = getCurrent();
    let el: Element | null = current;
    while (el) {
      const s = getComputedStyle(el);
      if (
        (Math.abs(y) > 0 &&
          el.scrollHeight > el.clientHeight + 2 &&
          /(auto|scroll)/.test(s.overflowY)) ||
        (Math.abs(x) > 0 &&
          el.scrollWidth > el.clientWidth + 2 &&
          /(auto|scroll)/.test(s.overflowX))
      ) {
        const a = el.scrollTop,
          b = el.scrollLeft;
        el.scrollBy({ left: x, top: y, behavior: "instant" });
        if (a !== el.scrollTop || b !== el.scrollLeft) return;
      }
      el = el.parentElement;
    }
    const area = Array.from(scope().querySelectorAll("*")).find(
      (e) =>
        isVisible(e) &&
        e.scrollHeight > e.clientHeight + 2 &&
        /(auto|scroll)/.test(getComputedStyle(e).overflowY),
    );
    (area ?? document.scrollingElement)?.scrollBy({
      left: x,
      top: y,
      behavior: "instant",
    });
  }
  function move(direction: Direction) {
    turnOn();
    const all = candidates(),
      current = getCurrent();
    if (!current) {
      focus(first());
      return;
    }
    if (rangeEdit === current) {
      const el = current as HTMLInputElement;
      if (direction === "left" || direction === "right") {
        direction === "left" ? el.stepDown() : el.stepUp();
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      rangeEdit = null;
    }
    // From an app's title bar, Down goes back into the app it frames.
    const app =
      direction === "down"
        ? current
            .closest("section")
            ?.querySelector<HTMLElement>("iframe[data-tv-autofocus]")
        : null;
    if (
      app &&
      app !== current &&
      app.getBoundingClientRect().top >=
        current.getBoundingClientRect().bottom - 1
    ) {
      focus(app);
      return;
    }
    const choices = all.filter((e) => e !== current);
    const n = nearest(
      current.getBoundingClientRect(),
      choices.map((e) => e.getBoundingClientRect()),
      direction,
    );
    if (n >= 0) focus(choices[n]);
    else if (direction === "up" && window !== window.top && bridge && !overlay)
      void bridge("leaveFrame");
    else if (!overlay)
      scroll(
        direction === "left" ? -300 : direction === "right" ? 300 : 0,
        direction === "up" ? -300 : direction === "down" ? 300 : 0,
      );
  }
  function activate() {
    turnOn();
    const el = getCurrent();
    if (!el) {
      focus(first());
      return;
    }
    if (editable(el)) {
      keyboard(el);
      return;
    }
    if (el instanceof HTMLSelectElement) {
      selectMenu(el);
      return;
    }
    if (el.matches("input[type=range]")) {
      rangeEdit = rangeEdit === el ? null : el;
      toast(
        rangeEdit
          ? "Left / right adjusts · Select or Back finishes"
          : "Adjustment finished",
      );
      return;
    }
    if (el instanceof HTMLIFrameElement) {
      focus(el);
      return;
    }
    if (el instanceof HTMLVideoElement) {
      if (el.paused)
        void el.play().catch(() => toast("Select Play in the player"));
      else el.pause();
      return;
    }
    if (el.dataset.tvActivate === "double")
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    else
      el.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
  }
  function back() {
    if (document.documentElement.hasAttribute("data-vault-playing")) {
      window.dispatchEvent(new Event("vault-player-exit"));
      return;
    }
    if (capture) {
      capture.callback("Remapping cancelled");
      capture = null;
      emit();
      return;
    }
    if (overlay) {
      closeOverlay();
      return;
    }
    if (rangeEdit) {
      rangeEdit = null;
      toast("Adjustment finished");
      return;
    }
    const dialog = scope();
    if (dialog instanceof HTMLDialogElement) {
      dialog.close();
      setTimeout(() => focus(lastFocus?.isConnected ? lastFocus : first()), 0);
      return;
    }
    if (dialog !== document) {
      const close = Array.from(
        dialog.querySelectorAll<HTMLElement>("button,[role=button]"),
      ).find((e) =>
        /^(cancel|close|done|back|×|✕)$/i.test(
          (e.textContent || e.getAttribute("aria-label") || "").trim(),
        ),
      );
      if (close) {
        close.click();
        return;
      }
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const details = getCurrent()?.closest("details[open]");
    if (details) {
      details.removeAttribute("open");
      focus(details.querySelector("summary"));
      return;
    }
    // Afterglow's search is a panel, not a dialog; close it before leaving.
    const search =
      location.port === "13031" ? document.querySelector("#search-bar") : null;
    if (search && isVisible(search)) {
      document.querySelector<HTMLElement>("#search-close")?.click();
      return;
    }
    // Afterglow's own TV handler consumes Escape even at its home screen.
    if (
      window !== window.top &&
      location.port === "13031" &&
      ["", "#discover"].includes(location.hash) &&
      !isVisible(
        document.querySelector("#search-bar") ?? document.createElement("div"),
      )
    ) {
      void bridge?.("leaveFrame");
      return;
    }
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    (getCurrent() ?? document.body).dispatchEvent(escape);
    if (escape.defaultPrevented) return;
    if (window !== window.top) {
      if (location.port === "13031") {
        const path = location.hash.slice(1);
        if (path.startsWith("music/")) location.hash = "music";
        else if (path.startsWith("youtube/watch/"))
          location.hash = path.split("/")[3]
            ? `youtube/show/${path.split("/")[3]}`
            : "youtube";
        else if (path.startsWith("youtube/show/")) location.hash = "youtube";
        else if (path.startsWith("watch/") || path.startsWith("title/"))
          location.hash = "library";
        else location.hash = "discover";
        return;
      }
      if (location.hash && !["#discover", "#/"].includes(location.hash)) {
        window.history.back();
        return;
      }
      void bridge?.("leaveFrame");
      return;
    }
    if (bridge && !document.querySelector('[data-testid="nav-fleet"]')) {
      void bridge("home");
      return;
    }
    if (location.hash.startsWith("#/applications?")) {
      restoringRoute = true;
      while (
        routeStack.length &&
        new URL(routeStack.at(-1)!).hash.startsWith("#/applications?")
      )
        routeStack.pop();
      if (
        routeStack.length &&
        new URL(routeStack.at(-1)!).hash === "#/applications"
      )
        routeStack.pop();
      location.hash = "#/applications";
      return;
    }
    if (location.hash && location.hash !== "#/fleet") {
      if (location.hash.startsWith("#/")) {
        restoringRoute = true;
        location.hash = routeStack.length
          ? new URL(routeStack.pop()!).hash
          : "#/fleet";
      } else if (window.history.length > 1) window.history.back();
      else void bridge?.("home");
      return;
    }
    focus(
      document.querySelector('[data-testid="nav-applications"]') ?? first(),
    );
  }
  function dispatch(action: Action) {
    if (disposed) return;
    turnOn();
    if (["up", "down", "left", "right"].includes(action)) {
      move(action as Direction);
      return;
    }
    switch (action) {
      case "activate":
        activate();
        break;
      case "back":
        back();
        break;
      case "keyboard":
        keyboard();
        break;
      case "home":
        if (bridge) void bridge("home");
        else location.hash = "#/fleet";
        break;
      case "controls":
        if (bridge) void bridge("controls");
        else location.hash = "#/controls";
        break;
      case "pageUp":
        scroll(0, -innerHeight * 0.7);
        break;
      case "pageDown":
        scroll(0, innerHeight * 0.7);
        break;
      case "play": {
        const v = Array.from(document.querySelectorAll("video")).find(
          isVisible,
        );
        if (v) {
          v.paused ? void v.play().catch(() => {}) : v.pause();
        } else {
          const b = Array.from(
            document.querySelectorAll<HTMLElement>("button"),
          ).find(
            (e) =>
              isVisible(e) &&
              /^(play|pause)(\b|$)/i.test(
                e.getAttribute("aria-label") || e.title || e.textContent || "",
              ),
          );
          b?.click();
        }
        break;
      }
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (document.documentElement.hasAttribute("data-vault-playing")) return;
    if (!e.isTrusted && e.key === "Escape") return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    if (
      e.key === "Escape" ||
      e.key === "BrowserBack" ||
      e.key === "GoBack" ||
      (e.key === "Backspace" &&
        !editable(document.activeElement as HTMLElement))
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) back();
      return;
    }
    const mapping: Record<string, Action> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      Enter: "activate",
      " ": "activate",
    };
    const action = mapping[e.key];
    if (!action || (!settings.enabled && !options.kiosk)) return;
    if (
      editable(document.activeElement as HTMLElement) &&
      !active &&
      !options.kiosk
    )
      return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && action === "activate") return;
    dispatch(action);
  };
  window.addEventListener("keydown", onKey, true);
  const onPointer = () => {
    if (options.kiosk) return;
    active = false;
    delete document.documentElement.dataset.cyberdeckTv;
    highlighted?.removeAttribute("data-tv-focused");
  };
  window.addEventListener("pointerdown", onPointer, true);
  const onFocus = () => {
    remember();
    if (active) {
      const el = document.activeElement as HTMLElement;
      if (candidates().includes(el)) {
        highlighted?.removeAttribute("data-tv-focused");
        highlighted = el;
        el.setAttribute("data-tv-focused", "");
      }
    }
    void bridge?.("focused");
  };
  document.addEventListener("focusin", onFocus);
  const onHash = () => {
    if (!restoringRoute) {
      routeStack.push(route);
      if (routeStack.length > 50) routeStack.shift();
    }
    restoringRoute = false;
    route = location.href;
    rangeEdit = null;
    if (overlay) closeOverlay();
    setTimeout(() => {
      if (active) {
        const all = candidates(),
          old = history.get(route);
        const restored = old?.isConnected
          ? old
          : all.find(
              (el) =>
                old &&
                ((old.id && el.id === old.id) ||
                  (old.dataset.testid &&
                    el.dataset.testid === old.dataset.testid) ||
                  (old.tagName === el.tagName &&
                    old.textContent?.trim() &&
                    el.textContent === old.textContent)),
            );
        focus(
          all.find((el) => el.matches("[data-tv-autofocus]")) ??
            restored ??
            all.find((el) => !!el.closest("main")) ??
            first(),
        );
      }
    }, 120);
  };
  window.addEventListener("hashchange", onHash);
  let repairTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    if (!active || repairTimer) return;
    repairTimer = setTimeout(() => {
      repairTimer = undefined;
      if (disposed) return;
      const all = candidates();
      if (!all.includes(document.activeElement as HTMLElement)) {
        const restored =
          lastFocus?.isConnected && all.includes(lastFocus) ? lastFocus : null;
        focus(
          restored ??
            all.find((e) => e.id && e.id === lastFocus?.id) ??
            all[0] ??
            null,
        );
      }
    }, 100);
  });
  const watch = () => {
    attachStyle();
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
  };
  if (document.body) watch();
  else document.addEventListener("DOMContentLoaded", watch, { once: true });
  async function persist() {
    settings = sanitizeSettings(settings);
    try {
      if (bridge) await bridge("saveSettings", settings);
      else localStorage.setItem(KEY, JSON.stringify(settings));
      statusError = "";
    } catch {
      statusError =
        "Could not save controls. Your previous saved mappings are unchanged.";
    }
    emit();
  }
  function setProfile(p: Profile) {
    const id = currentPad?.id || "default";
    settings.profiles[id] = p;
    driver.reset();
    void persist();
  }
  function startCapture(
    target: Action | "scrollX" | "scrollY",
    callback: (text: string) => void,
  ) {
    capture = {
      target,
      start: performance.now(),
      ready: false,
      axes: [...(currentPad?.axes ?? [])],
      callback,
    };
    driver.reset();
    callback(
      target === "scrollX"
        ? "Release the stick, then move it RIGHT. Escape cancels."
        : target === "scrollY"
          ? "Release the stick, then move it DOWN. Escape cancels."
          : "Release buttons, then press the new control. Escape cancels; times out in 12 seconds.",
    );
    emit();
  }
  function bind(binding: Binding) {
    if (!capture) return;
    const { target, callback } = capture;
    const p = structuredClone(profile());
    if (target === "scrollX" || target === "scrollY") {
      if (binding.kind !== "axis") return;
      p[target] = binding.index;
      p[target === "scrollX" ? "invertX" : "invertY"] = binding.sign === -1;
    } else {
      const previous = p.bindings[target];
      for (const { id } of ACTIONS)
        if (
          id !== target &&
          JSON.stringify(p.bindings[id]) === JSON.stringify(binding)
        ) {
          if (previous) p.bindings[id] = previous;
          else delete p.bindings[id];
        }
      p.bindings[target] = binding;
    }
    capture = null;
    setProfile(p);
    callback(`Assigned ${labelBinding(binding)}`);
    emit();
  }
  let frame = 0,
    lastNotify = 0,
    suspended = false;
  function tick(now: number) {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    if (window !== window.top) return;
    let pads: readonly (Gamepad | null)[] = [];
    try {
      pads = navigator.getGamepads?.() ?? [];
    } catch {
      statusError = "Gamepad access is unavailable in this browser context.";
    }
    // Follow whichever controller was used last; receivers often expose a
    // second, idle pad ahead of the one in your hands.
    currentPad =
      pads.reduce<Gamepad | null>(
        (best, p) =>
          p?.connected && (!best || p.timestamp > best.timestamp) ? p : best,
        null,
      ) ?? null;
    // A game owns the controller while it runs; afterwards, ignore the chord
    // that quit it until every button is released.
    if ((window.__cyberdeckInputBridge && !document.hasFocus()) || document.documentElement.hasAttribute("data-tv-suspend") || document.documentElement.hasAttribute("data-vault-playing")) suspended = true;
    else if (suspended && !currentPad?.buttons.some((b) => b.pressed))
      suspended = false;
    if (document.hidden || suspended) {
      driver.reset();
      return;
    }
    if (capture) {
      if (now - capture.start > 12000) {
        capture.callback(
          "No input received. Try again after connecting the controller.",
        );
        capture = null;
        emit();
      } else if (currentPad) {
        if (!capture.ready) {
          if (!currentPad.buttons.some((b) => b.pressed)) {
            capture.ready = true;
            capture.axes = [...currentPad.axes];
          }
        } else {
          const b = currentPad.buttons.findIndex((b) => b.pressed);
          if (b >= 0) bind({ kind: "button", index: b });
          else {
            const a = currentPad.axes.findIndex(
              (v, i) => Math.abs(v - (capture!.axes[i] ?? 0)) > 0.65,
            );
            if (a >= 0)
              bind({
                kind: "axis",
                index: a,
                sign: currentPad.axes[a] > 0 ? 1 : -1,
              });
          }
        }
      }
    } else if (settings.enabled) {
      // Every connected pad drives the deck; each keeps its own press state.
      const result = { actions: [] as Action[], x: 0, y: 0 };
      for (const pad of pads) {
        if (!pad?.connected) continue;
        let d = drivers.get(pad.index);
        if (!d) drivers.set(pad.index, (d = new PadDriver()));
        const r = d.step(
          pad,
          settings.profiles[pad.id] ?? settings.profiles.default ?? defaults(),
          now,
        );
        result.actions.push(...r.actions);
        result.x += r.x;
        result.y += r.y;
      }
      for (const action of result.actions) {
        if (bridge) void bridge("dispatch", { action });
        else dispatch(action);
      }
      if (result.x || result.y) {
        if (bridge) void bridge("scroll", { x: result.x, y: result.y });
        else scroll(result.x, result.y);
      }
    } else driver.reset();
    if (now - lastNotify > 100) {
      lastNotify = now;
      emit();
    }
  }
  frame = requestAnimationFrame(tick);
  const api = {
    dispatch,
    scroll,
    confirm,
    focusOutsideFrame: (el: HTMLElement) => {
      const back = el
        .closest("section")
        ?.querySelector<HTMLElement>("[data-tv-frame-back]");
      if (back) {
        focus(back);
        return;
      }
      const all = candidates().filter((e) => e !== el && !e.matches("iframe"));
      const i = nearest(
        el.getBoundingClientRect(),
        all.map((e) => e.getBoundingClientRect()),
        "up",
      );
      focus(all[i] ?? all[0] ?? null);
    },
    focusFirst: () => focus(first()),
    focusElement: (el: HTMLElement) => focus(el),
    keyboard,
    snapshot: () => ({
      settings,
      profile: profile(),
      pad: currentPad
        ? {
            id: currentPad.id,
            mapping: currentPad.mapping,
            buttons: currentPad.buttons.map((b) => b.value),
            axes: [...currentPad.axes],
          }
        : null,
      error: statusError,
      capturing: capture?.target ?? null,
      kiosk: !!options.kiosk,
      secure: window.isSecureContext,
    }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setProfile,
    startCapture,
    cancelCapture: () => {
      capture?.callback("Remapping cancelled");
      capture = null;
      driver.reset();
      emit();
    },
    setEnabled: (enabled: boolean) => {
      settings.enabled = enabled;
      void persist();
    },
    setSettings: (s: unknown) => {
      settings = sanitizeSettings(s);
      emit();
    },
    reset: () => setProfile(defaults()),
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      clearTimeout(repairTimer);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("pointerdown", onPointer, true);
      style.remove();
      overlay?.remove();
      confirmResolve?.(false);
      delete window.__cyberdeckTV;
    },
  };
  window.__cyberdeckTV = api;
  if (bridge)
    void bridge("settings")
      .then((s) => {
        settings = sanitizeSettings(s);
        emit();
      })
      .catch(() => {
        statusError = "Saved controller settings could not be loaded";
        emit();
      });
  return api;
}
