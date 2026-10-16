import type { BrowserContext, Frame, Page } from "playwright";
import { ACTIONS, sanitizeSettings, type Settings } from "../ui/lib/tv/model";

/** Kiosk-only bridge. Untrusted embedded apps can focus themselves, but cannot
 * dispatch input into other apps, change mappings, or choose a navigation URL. */
export async function attachInputBridge(
  context: BrowserContext,
  options: {
    origin: string;
    publicOrigin?: string;
    load: () => Promise<unknown>;
    save: (settings: Settings) => Promise<void>;
  },
) {
  let settings = sanitizeSettings(await options.load());
  let saving: Promise<void> = Promise.resolve();
  const root = (frame: Frame) => frame === frame.page().mainFrame();
  const trusted = (frame: Frame) => {
    try {
      return root(frame) && new URL(frame.url()).origin === options.origin;
    } catch {
      return false;
    }
  };
  // Follow the real focus chain on every press: a remembered frame races with
  // apps that focus themselves while loading.
  const target = async (page: Page) => {
    let frame = page.mainFrame();
    for (let depth = 0; depth < 4; depth++) {
      try {
        const active = await frame.evaluateHandle(() =>
          document.activeElement instanceof HTMLIFrameElement
            ? document.activeElement
            : null,
        );
        const inside = await active.asElement()?.contentFrame();
        await active.dispose();
        if (!inside) break;
        frame = inside;
      } catch {
        break;
      }
    }
    return frame;
  };
  const invoke = async (frame: Frame, method: string, args: unknown[] = []) => {
    try {
      await frame.evaluate(
        ({ method, args }) => window.__cyberdeckTV?.[method]?.(...args),
        { method, args },
      );
    } catch {
      /* A frame may navigate between a controller sample and dispatch. */
    }
  };
  await context.exposeBinding(
    "__cyberdeckInputBridge",
    async ({ frame, page }, command, data) => {
      if (command === "settings") return settings;
      if (command === "pairingOrigin") {
        if (!trusted(frame)) throw new Error("Pairing belongs to Cyberdeck");
        return options.publicOrigin ?? options.origin;
      }
      if (command === "focused") return;
      if (command === "enterFrame") {
        // Chromium does not match `iframe:focus` once focus is inside a
        // cross-origin (out-of-process) frame, so ask for activeElement.
        const active = await frame.evaluateHandle(() => document.activeElement);
        const inside = await active.asElement()?.contentFrame();
        await active.dispose();
        if (inside) await invoke(inside, "focusFirst");
        return;
      }
      if (command === "leaveFrame") {
        const parent = frame.parentFrame();
        if (parent) {
          const element = await frame.frameElement();
          await element.evaluate((el) =>
            window.__cyberdeckTV?.focusOutsideFrame(el),
          );
          await element.dispose();
        }
        return;
      }
      if (command === "home" || command === "controls") {
        // Fixed destinations only; apps never get the Cyberdeck bearer token.
        if (await page.evaluate(() => !!document.fullscreenElement))
          await page.evaluate(() => document.exitFullscreen());
        await page.goto(
          `${options.origin}/#/${command === "home" ? "fleet" : "controls"}`,
        );
        await invoke(page.mainFrame(), "focusFirst");
        return;
      }
      if (command === "saveSettings") {
        if (!trusted(frame))
          throw new Error("Controller settings belong to Cyberdeck");
        const next = sanitizeSettings(data);
        saving = saving
          .catch(() => {})
          .then(async () => {
            await options.save(next);
            settings = next;
            await Promise.all(
              context
                .pages()
                .flatMap((p) => p.frames())
                .map((f) => invoke(f, "setSettings", [settings])),
            );
          });
        await saving;
        return;
      }
      if (!root(frame))
        throw new Error("Only the kiosk controller can dispatch input");
      if (
        command === "dispatch" &&
        ACTIONS.some((a) => a.id === data?.action)
      ) {
        await invoke(await target(page), "dispatch", [data.action]);
      } else if (
        command === "scroll" &&
        Number.isFinite(data?.x) &&
        Number.isFinite(data?.y)
      ) {
        await invoke(await target(page), "scroll", [
          Math.max(-120, Math.min(120, data.x)),
          Math.max(-120, Math.min(120, data.y)),
        ]);
      }
    },
  );
}
