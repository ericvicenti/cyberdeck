import { test, expect } from "bun:test";
import { Hono } from "hono";
import { analyzeWindow, registerMusicVisualizerRoutes, VISUALIZER_SIZE } from "./music-visualizer";

test("silence yields zero energy", () => {
  const frame = analyzeWindow(new Int16Array(VISUALIZER_SIZE));
  expect(frame.rms).toBe(0);
  expect(frame.peak).toBe(0);
  expect(frame.bands).toHaveLength(16);
  expect(frame.bands.every((n) => n === 0)).toBe(true);
});

test("1 kHz sine yields responsive log band and RMS", () => {
  const samples = Int16Array.from({ length: VISUALIZER_SIZE }, (_, i) => Math.round(16384 * Math.sin(2 * Math.PI * 1000 * i / 16000)));
  const frame = analyzeWindow(samples);
  expect(frame.rms).toBeGreaterThan(0.34);
  expect(frame.peak).toBeCloseTo(0.5, 2);
  expect(frame.bands.indexOf(Math.max(...frame.bands))).toBeGreaterThanOrEqual(9);
  expect(frame.bands.indexOf(Math.max(...frame.bands))).toBeLessThanOrEqual(11);
  expect(() => analyzeWindow(new Int16Array(2))).toThrow(RangeError);
});

test("poll endpoint exposes derived values only and forbids caching", async () => {
  const app = new Hono();
  registerMusicVisualizerRoutes(app, { get: () => analyzeWindow(new Int16Array(VISUALIZER_SIZE)) } as any);
  const response = await app.request("/api/music/visualizer");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Object.keys(await response.json()).sort()).toEqual(["at", "available", "bands", "peak", "rms", "source"]);
});
