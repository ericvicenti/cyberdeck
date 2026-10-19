export type Direction = "up" | "down" | "left" | "right";
export type Action =
  | Direction
  | "activate"
  | "back"
  | "home"
  | "controls"
  | "keyboard"
  | "play"
  | "pageUp"
  | "pageDown";
export const ACTIONS: { id: Action; label: string }[] = [
  { id: "up", label: "Focus up" },
  { id: "down", label: "Focus down" },
  { id: "left", label: "Focus left" },
  { id: "right", label: "Focus right" },
  { id: "activate", label: "Select / open" },
  { id: "back", label: "Back / close" },
  { id: "home", label: "Cyberdeck Home" },
  { id: "controls", label: "Controller settings" },
  { id: "keyboard", label: "On-screen keyboard" },
  { id: "play", label: "Play / pause" },
  { id: "pageUp", label: "Scroll one page up" },
  { id: "pageDown", label: "Scroll one page down" },
];
export type Binding =
  | { kind: "button"; index: number }
  | { kind: "axis"; index: number; sign: 1 | -1 };
export type Profile = {
  bindings: Partial<Record<Action, Binding>>;
  scrollX: number;
  scrollY: number;
  invertX: boolean;
  invertY: boolean;
  deadzone: number;
  speed: number;
};
export type Settings = {
  version: 1;
  enabled: boolean;
  profiles: Record<string, Profile>;
};
export const defaults = (): Profile => ({
  bindings: Object.fromEntries(
    Object.entries({
      up: 12,
      down: 13,
      left: 14,
      right: 15,
      activate: 0,
      back: 1,
      keyboard: 2,
      play: 3,
      home: 8,
      controls: 9,
      pageUp: 4,
      pageDown: 5,
    }).map(([a, index]) => [a, { kind: "button", index }]),
  ),
  scrollX: 0,
  scrollY: 1,
  invertX: false,
  invertY: false,
  deadzone: 0.22,
  speed: 900,
});
export function sanitizeProfile(raw: any): Profile {
  const p = defaults();
  if (!raw || typeof raw !== "object") return p;
  if (raw.bindings && typeof raw.bindings === "object")
    for (const { id } of ACTIONS) {
      const b = raw.bindings[id];
      if (b === null) {
        delete p.bindings[id];
        continue;
      }
      if (
        b &&
        Number.isInteger(b.index) &&
        b.index >= 0 &&
        b.index < 64 &&
        (b.kind === "button" || (b.kind === "axis" && [1, -1].includes(b.sign)))
      )
        p.bindings[id] =
          b.kind === "button"
            ? { kind: "button", index: b.index }
            : { kind: "axis", index: b.index, sign: b.sign };
    }
  for (const k of ["scrollX", "scrollY"] as const)
    if (Number.isInteger(raw[k]) && raw[k] >= 0 && raw[k] < 32) p[k] = raw[k];
  for (const k of ["invertX", "invertY"] as const) p[k] = raw[k] === true;
  p.deadzone =
    typeof raw.deadzone === "number" && Number.isFinite(raw.deadzone)
      ? Math.min(0.6, Math.max(0.08, raw.deadzone))
      : p.deadzone;
  p.speed =
    typeof raw.speed === "number" && Number.isFinite(raw.speed)
      ? Math.min(2400, Math.max(150, raw.speed))
      : p.speed;
  return p;
}
export function sanitizeSettings(raw: any): Settings {
  const profiles: Record<string, Profile> = {};
  if (raw?.profiles && typeof raw.profiles === "object")
    for (const [id, p] of Object.entries(raw.profiles).slice(0, 20))
      if (
        id.length < 300 &&
        !["__proto__", "constructor", "prototype"].includes(id)
      )
        profiles[id] = sanitizeProfile(p);
  return { version: 1, enabled: raw?.enabled !== false, profiles };
}
export function labelBinding(b?: Binding) {
  return !b
    ? "Unassigned"
    : b.kind === "button"
      ? `Button ${b.index}`
      : `Axis ${b.index} ${b.sign === 1 ? "+" : "−"}`;
}
export const axisValue = (n: number, d: number) =>
  Math.abs(n) <= d ? 0 : (Math.sign(n) * (Math.abs(n) - d)) / (1 - d);
export type Pad = {
  id: string;
  index: number;
  mapping: string;
  buttons: readonly { pressed: boolean; value: number }[];
  axes: readonly number[];
};
export class PadDriver {
  private held = new Map<Action, number>();
  private id = "";
  private armed = false;
  private last = 0;
  reset() {
    this.held.clear();
    this.id = "";
    this.armed = false;
    this.last = 0;
  }
  step(
    pad: Pad | null,
    p: Profile,
    now: number,
  ): { actions: Action[]; x: number; y: number } {
    const out = { actions: [] as Action[], x: 0, y: 0 };
    if (!pad) {
      this.reset();
      return out;
    }
    if (this.id !== `${pad.id}:${pad.index}`) {
      this.reset();
      this.id = `${pad.id}:${pad.index}`;
    }
    const dt = this.last
      ? Math.min(0.05, Math.max(0, (now - this.last) / 1000))
      : 0;
    this.last = now;
    const active = ACTIONS.filter(({ id }) => {
      const b = p.bindings[id];
      return b?.kind === "button"
        ? (pad.buttons[b.index]?.value ?? 0) > 0.55
        : b?.kind === "axis"
          ? (pad.axes[b.index] ?? 0) * b.sign > 0.65
          : false;
    }).map((a) => a.id);
    if (!this.armed) {
      if (
        !active.length &&
        Math.abs(pad.axes[p.scrollX] ?? 0) < p.deadzone &&
        Math.abs(pad.axes[p.scrollY] ?? 0) < p.deadzone
      )
        this.armed = true;
      return out;
    }
    for (const { id } of ACTIONS) {
      if (!active.includes(id)) {
        this.held.delete(id);
        continue;
      }
      const next = this.held.get(id);
      if (next === undefined) {
        out.actions.push(id);
        this.held.set(id, now + 380);
      } else if (
        now >= next &&
        ["up", "down", "left", "right", "pageUp", "pageDown"].includes(id)
      ) {
        out.actions.push(id);
        this.held.set(id, now + 125);
      }
    }
    out.x =
      axisValue(pad.axes[p.scrollX] ?? 0, p.deadzone) *
      p.speed *
      dt *
      (p.invertX ? -1 : 1);
    out.y =
      axisValue(pad.axes[p.scrollY] ?? 0, p.deadzone) *
      p.speed *
      dt *
      (p.invertY ? -1 : 1);
    return out;
  }
}
export type Box = { left: number; right: number; top: number; bottom: number };
/** Prefer controls in the same row/column before diagonal candidates. No wrap at an edge. */
export function nearest(from: Box, boxes: Box[], direction: Direction): number {
  let best = -1,
    score = Infinity;
  const horizontal = direction === "left" || direction === "right",
    positive = direction === "right" || direction === "down";
  const main = (b: Box) =>
    horizontal ? (b.left + b.right) / 2 : (b.top + b.bottom) / 2;
  const cross = (b: Box) =>
    horizontal ? (b.top + b.bottom) / 2 : (b.left + b.right) / 2;
  boxes.forEach((b, i) => {
    const distance = (main(b) - main(from)) * (positive ? 1 : -1);
    if (distance < 2) return;
    const overlap = horizontal
      ? Math.min(from.bottom, b.bottom) - Math.max(from.top, b.top)
      : Math.min(from.right, b.right) - Math.max(from.left, b.left);
    const value =
      distance +
      Math.abs(cross(b) - cross(from)) * 2 +
      (overlap > 0 ? 0 : 1000);
    if (value < score) {
      score = value;
      best = i;
    }
  });
  return best;
}
