import { installTVInput } from "./runtime";
/** Confirm an action. With a controller (or on a kiosk) a native confirm would suspend gamepad polling,
 *  so the question stays in the page; with a keyboard and mouse the browser's own dialog is used. */
export function confirmAction(message: string): Promise<boolean> {
  const tv = installTVInput();
  const snap = tv.snapshot();
  if (snap.kiosk || snap.pad || document.documentElement.hasAttribute("data-cyberdeck-tv")) return tv.confirm(message);
  return Promise.resolve(window.confirm(message));
}
