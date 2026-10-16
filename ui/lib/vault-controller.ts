export type PlayerAction = "menu" | "up" | "down" | "accept" | "resume";
type Pad = { index: number; connected: boolean; buttons: readonly { pressed: boolean }[]; axes: readonly number[] };
/** Runs in the host page, so losing focus to the emulator cannot lose the exit controls. */
export class PlayerController {
  private states = new Map<number, { action: string; at: number; start: number; opened: boolean }>();
  poll(pads: readonly (Pad | null)[], menu: boolean, now: number): PlayerAction | undefined {
    let result: PlayerAction | undefined;
    const connected = new Set<number>();
    for (const pad of pads) {
      if (!pad?.connected) continue;
      connected.add(pad.index);
      const s = this.states.get(pad.index) ?? { action: "", at: 0, start: -1, opened: false };
      const b = (n: number) => !!pad.buttons[n]?.pressed;
      if (b(9)) { if (s.start < 0) s.start = now; } else { s.start = -1; s.opened = false; }
      const chord = b(16) || (b(8) && b(9));
      const heldStart = s.start >= 0 && now - s.start >= 700;
      let action: PlayerAction | "" = "";
      if (chord || (!menu && heldStart && !s.opened)) action = "menu";
      else if (menu && !s.opened) {
        if (b(12) || pad.axes[1] < -0.55) action = "up";
        else if (b(13) || pad.axes[1] > 0.55) action = "down";
        else if (b(0)) action = "accept";
        else if (b(1) || b(9)) action = "resume";
      }
      if (action && (s.action !== action || ((action === "up" || action === "down") && now - s.at >= 230))) {
        result ??= action; s.at = now;
        if (action === "menu") s.opened = true;
      }
      s.action = action;
      this.states.set(pad.index, s);
    }
    for (const id of this.states.keys()) if (!connected.has(id)) this.states.delete(id);
    return result;
  }
}
