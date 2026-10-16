import { installTVInput } from "./runtime";
/** A native confirm suspends gamepad polling. Keep confirmation in the page. */
export function confirmAction(message: string): Promise<boolean> {
  return installTVInput().confirm(message);
}
