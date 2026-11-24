// Pure classifier behind the Home dashboard's Deploy widget. Every combination of
// commit/head/behind/ahead/error has a specific severity and label; a stuck node
// (local commits AND behind origin) must read as its own red state because the
// auto-updater's ff-only pull cannot resolve it on its own.
import { describe, expect, test } from "bun:test";
import { deployTone } from "../ui/views/Home";
import type { DeployState } from "../src/daemon/api/dashboard";

const state = (p: Partial<DeployState>): DeployState => ({
  commit: "abc1234", head: "abc1234", behind: 0, ahead: 0, updating: false, checkedAt: 1, ...p,
});

describe("deployTone", () => {
  test("up to date: green", () => {
    expect(deployTone(state({}), true)).toEqual({ sev: "ok", label: "up to date" });
  });
  test("behind origin: amber, counts commits", () => {
    expect(deployTone(state({ behind: 3 }), true)).toEqual({ sev: "warn", label: "3 behind origin" });
  });
  test("ahead of origin without behind: red (local-only commits are drift)", () => {
    expect(deployTone(state({ ahead: 2 }), true)).toEqual({ sev: "bad", label: "2 ahead of origin" });
  });
  test("diverged (behind AND ahead): red, because ff-only pull cannot converge", () => {
    // This is yacht's state on 2026-11-23: behind=1 (missing a push), ahead=3 (local
    // nav-routine commits). Before this classifier, the widget read "1 behind origin" (amber),
    // which hid the real reason the auto-updater had been failing silently.
    expect(deployTone(state({ behind: 1, ahead: 3 }), true)).toEqual({ sev: "bad", label: "diverged from origin" });
  });
  test("checkout moved past the running daemon: amber, 'restart to deploy'", () => {
    expect(deployTone(state({ commit: "aaa", head: "bbb" }), true)).toEqual({ sev: "warn", label: "restart to deploy" });
  });
  test("updating: amber, overrides drift counts", () => {
    expect(deployTone(state({ updating: true, behind: 2 }), true)).toEqual({ sev: "warn", label: "updating…" });
  });
  test("check failed (git fetch error): red", () => {
    expect(deployTone(state({ error: "offline" }), true)).toEqual({ sev: "bad", label: "check failed" });
  });
  test("no deploy state: off (offline if the node says so)", () => {
    expect(deployTone(null, false)).toEqual({ sev: "off", label: "offline" });
    expect(deployTone(null, true)).toEqual({ sev: "off", label: "no node" });
  });
});
