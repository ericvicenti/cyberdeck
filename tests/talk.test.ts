// The Desk's talk modes (ui/lib/talk.ts): what the button and the state line say in
// hands-free vs push-to-talk, and which controls show.
import { describe, expect, test } from "bun:test";
import { talkFace, readTalkMode, isTalkKey, TALK_MODES } from "../ui/lib/talk";

describe("readTalkMode", () => {
  test("defaults to hands-free and accepts only the two modes", () => {
    expect(readTalkMode(null)).toBe("hands-free");
    expect(readTalkMode(undefined)).toBe("hands-free");
    expect(readTalkMode("ptt")).toBe("hands-free");
    expect(readTalkMode("push-to-talk")).toBe("push-to-talk");
    expect(readTalkMode("hands-free")).toBe("hands-free");
    expect(TALK_MODES.map(([k]) => k)).toEqual(["hands-free", "push-to-talk"]);
  });
});

describe("talkFace hands-free", () => {
  test("idle: tap to talk, no chips", () => {
    const f = talkFace("hands-free", "idle", "initializing", false, false);
    expect(f.button).toBe("talk");
    expect(f.state).toBe("tap to talk");
    expect(f.tapToggles).toBe(true);
    expect(f.holdTalks).toBe(false);
    expect(f.endChip).toBe(false);
    expect(f.muteChip).toBe(false);
    expect(f.ring).toBe("");
  });
  test("live: the button ends the call, mute chip shows, the ring follows the agent", () => {
    expect(talkFace("hands-free", "live", "listening", false, false)).toMatchObject({ button: "end", state: "listening", ring: "talk-listening", muteChip: true, endChip: false, tapToggles: true });
    expect(talkFace("hands-free", "live", "thinking", false, false)).toMatchObject({ state: "thinking", ring: "talk-thinking" });
    expect(talkFace("hands-free", "live", "speaking", false, false)).toMatchObject({ state: "speaking", ring: "talk-speaking" });
    expect(talkFace("hands-free", "live", "listening", true, false)).toMatchObject({ state: "muted", tone: "neon-amber" });
    expect(talkFace("hands-free", "live", "initializing", false, false).state).toBe("waiting for the agent");
  });
  test("connecting, ending and error read the same in both modes", () => {
    for (const mode of ["hands-free", "push-to-talk"] as const) {
      expect(talkFace(mode, "connecting", "initializing", false, false)).toMatchObject({ button: "end", state: "connecting", ring: "talk-connecting" });
      expect(talkFace(mode, "ending", "initializing", false, false)).toMatchObject({ state: "hanging up", ring: "talk-ending" });
      expect(talkFace(mode, "error", "initializing", false, false)).toMatchObject({ button: "talk", state: "failed · tap to retry", ring: "talk-error", tapToggles: true });
    }
  });
});

describe("talkFace push-to-talk", () => {
  test("idle: the tap still places the call, and the line explains the hold", () => {
    const f = talkFace("push-to-talk", "idle", "initializing", false, false);
    expect(f.button).toBe("talk");
    expect(f.state).toBe("tap to call · then hold to talk");
    expect(f.tapToggles).toBe(true);
    expect(f.holdTalks).toBe(false);
  });
  test("live and let go: the mic is closed, the button says hold, end moves to a chip, no mute chip", () => {
    const f = talkFace("push-to-talk", "live", "listening", true, false);
    expect(f).toMatchObject({ button: "hold", state: "hold to talk", ring: "talk-armed", tapToggles: false, holdTalks: true, endChip: true, muteChip: false });
  });
  test("live and held: listening with the open-mic ring", () => {
    expect(talkFace("push-to-talk", "live", "listening", false, true)).toMatchObject({ button: "talking", state: "listening · let go when done", ring: "talk-listening", tone: "neon-green" });
  });
  test("the agent's turn shows whether or not the button is held", () => {
    expect(talkFace("push-to-talk", "live", "speaking", true, false)).toMatchObject({ button: "hold", state: "speaking", ring: "talk-speaking" });
    expect(talkFace("push-to-talk", "live", "thinking", false, true)).toMatchObject({ button: "hold", state: "thinking", ring: "talk-thinking" });
    expect(talkFace("push-to-talk", "live", "initializing", true, false).state).toBe("waiting for the agent");
  });
});

describe("isTalkKey", () => {
  test("space bar outside text fields, first press only", () => {
    expect(isTalkKey(" ", false, "BODY", false)).toBe(true);
    expect(isTalkKey("Spacebar", false, undefined, false)).toBe(true);
    expect(isTalkKey(" ", false, "BUTTON", false)).toBe(true);
    expect(isTalkKey(" ", true, "BODY", false)).toBe(false);
    expect(isTalkKey("Enter", false, "BODY", false)).toBe(false);
    expect(isTalkKey(" ", false, "INPUT", false)).toBe(false);
    expect(isTalkKey(" ", false, "textarea", false)).toBe(false);
    expect(isTalkKey(" ", false, "DIV", true)).toBe(false);
  });
});
