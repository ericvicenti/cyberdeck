import { test, expect } from "bun:test";
import {
  defaults,
  nearest,
  PadDriver,
  sanitizeSettings,
} from "../ui/lib/tv/model";
const pad = () => ({
  id: "test pad",
  index: 0,
  mapping: "standard",
  axes: [0, 0],
  buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
});

test("directional navigation follows rows and columns, ignores controls behind it, and never wraps", () => {
  const box = { left: 100, right: 160, top: 100, bottom: 160 };
  const choices = [
    { left: 170, right: 230, top: 200, bottom: 260 },
    { left: 300, right: 360, top: 100, bottom: 160 },
    { left: 0, right: 60, top: 100, bottom: 160 },
  ];
  expect(nearest(box, choices, "right")).toBe(1);
  expect(nearest(box, choices, "left")).toBe(2);
  expect(nearest(box, choices, "down")).toBe(0);
  expect(nearest(box, choices, "up")).toBe(-1);
});
test("holding Select never repeats; directional repeat is delayed and throttled", () => {
  const p = pad(),
    d = new PadDriver(),
    config = defaults();
  d.step(p, config, 100);
  p.buttons[0] = { pressed: true, value: 1 };
  p.buttons[15] = { pressed: true, value: 1 };
  expect(d.step(p, config, 120).actions).toEqual(["right", "activate"]);
  expect(d.step(p, config, 200).actions).toEqual([]);
  expect(d.step(p, config, 501).actions).toEqual(["right"]);
  expect(d.step(p, config, 510).actions).toEqual([]);
  expect(d.step(p, config, 627).actions).toEqual(["right"]);
});
test("reconnect and reset require neutral inputs before accepting a press", () => {
  const p = pad(),
    d = new PadDriver(),
    config = defaults();
  p.buttons[0] = { pressed: true, value: 1 };
  expect(d.step(p, config, 100).actions).toEqual([]);
  p.buttons[0] = { pressed: false, value: 0 };
  d.step(p, config, 110);
  p.buttons[0] = { pressed: true, value: 1 };
  expect(d.step(p, config, 120).actions).toEqual(["activate"]);
  d.step(null, config, 130);
  expect(d.step(p, config, 140).actions).toEqual([]);
});
test("left stick scrolls continuously with a dead zone and capped elapsed time", () => {
  const p = pad(),
    d = new PadDriver(),
    config = defaults();
  d.step(p, config, 100);
  p.axes = [0.1, 1];
  const out = d.step(p, config, 120);
  expect(out.x).toBe(0);
  expect(out.y).toBeCloseTo(18);
  expect(out.actions).toEqual([]);
  expect(d.step(p, { ...config, invertY: true }, 10000).y).toBeCloseTo(-45);
});
test("nonstandard axis D-pad can be remapped and persisted; malformed settings are bounded", () => {
  const config = defaults();
  config.bindings.left = { kind: "axis", index: 3, sign: -1 };
  const s = sanitizeSettings({
    profiles: { pad: { ...config, deadzone: -20, speed: 99999, scrollX: -1 } },
  });
  expect(s.profiles.pad.bindings.left).toEqual({
    kind: "axis",
    index: 3,
    sign: -1,
  });
  expect(s.profiles.pad.deadzone).toBe(0.08);
  expect(s.profiles.pad.speed).toBe(2400);
  expect(s.profiles.pad.scrollX).toBe(0);
  const p = pad(),
    d = new PadDriver();
  d.step(p, config, 100);
  p.axes[3] = -1;
  expect(d.step(p, config, 120).actions).toEqual(["left"]);
});
