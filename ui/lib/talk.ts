// Talk modes on the Desk, as a pure planner so the view and the tests share it.
// hands-free: the mic is open for the whole call, tap TALK to start and END to hang up.
// push-to-talk: the call is up but the mic stays muted until the button (or the space bar)
// is held; letting go mutes again, so a noisy room or a side conversation never reaches
// the agent. The iPad Talk tab (casework/cyberdeck.tsx) mirrors the same two modes.
import type { AgentState, VoicePhase } from "./voice";

export type TalkMode = "hands-free" | "push-to-talk";
export const TALK_MODES: readonly [TalkMode, string][] = [["hands-free", "hands-free"], ["push-to-talk", "push to talk"]];
export const TALK_MODE_KEY = "cyberdeck-voice-mode";

export const isTalkMode = (v: unknown): v is TalkMode => v === "hands-free" || v === "push-to-talk";
/** The saved mode; anything unknown (or no storage) means hands-free, the mode the first version shipped with. */
export const readTalkMode = (saved: string | null | undefined): TalkMode => (isTalkMode(saved) ? saved : "hands-free");

export type TalkFace = {
  /** The word on the big button. */
  button: string;
  /** The state line under it. */
  state: string;
  /** Tailwind/HUD class for the state line's color. */
  tone: string;
  /** Ring class for the button (the breathing color); "" when idle. */
  ring: string;
  /** Tapping the big button toggles the call (hands-free, or push-to-talk before the call is up). */
  tapToggles: boolean;
  /** Holding the big button opens the mic (push-to-talk during the call). */
  holdTalks: boolean;
  /** Show a separate "end call" control (push-to-talk during the call: the button is busy being held). */
  endChip: boolean;
  /** Show the mute switch (hands-free only: in push-to-talk letting go is the mute). */
  muteChip: boolean;
};

export function talkFace(mode: TalkMode, phase: VoicePhase, agent: AgentState, muted: boolean, held: boolean): TalkFace {
  const live = phase === "live";
  const ptt = mode === "push-to-talk";
  const base = { tapToggles: !(ptt && live), holdTalks: ptt && live, endChip: ptt && live, muteChip: !ptt && live };
  if (phase === "error") return { ...base, button: "talk", state: "failed · tap to retry", tone: "neon-red", ring: "talk-error" };
  if (phase === "connecting") return { ...base, button: "end", state: "connecting", tone: "neon-amber", ring: "talk-connecting" };
  if (phase === "ending") return { ...base, button: "talk", state: "hanging up", tone: "text-zinc-500", ring: "talk-ending" };
  if (phase === "idle") return { ...base, button: "talk", state: ptt ? "tap to call · then hold to talk" : "tap to talk", tone: "text-zinc-500", ring: "" };
  // live
  if (ptt) {
    if (agent === "speaking") return { ...base, button: "hold", state: "speaking", tone: "neon", ring: "talk-speaking" };
    if (agent === "thinking") return { ...base, button: "hold", state: "thinking", tone: "neon-magenta", ring: "talk-thinking" };
    if (held) return { ...base, button: "talking", state: "listening · let go when done", tone: "neon-green", ring: "talk-listening" };
    if (agent === "initializing") return { ...base, button: "hold", state: "waiting for the agent", tone: "text-zinc-400", ring: "talk-armed" };
    return { ...base, button: "hold", state: "hold to talk", tone: "text-zinc-400", ring: "talk-armed" };
  }
  if (muted) return { ...base, button: "end", state: "muted", tone: "neon-amber", ring: "talk-listening" };
  if (agent === "speaking") return { ...base, button: "end", state: "speaking", tone: "neon", ring: "talk-speaking" };
  if (agent === "thinking") return { ...base, button: "end", state: "thinking", tone: "neon-magenta", ring: "talk-thinking" };
  if (agent === "listening") return { ...base, button: "end", state: "listening", tone: "neon-green", ring: "talk-listening" };
  return { ...base, button: "end", state: "waiting for the agent", tone: "text-zinc-400", ring: "talk-listening" };
}

/** Whether a key event should drive push-to-talk: the space bar, outside text fields, not a key repeat. */
export function isTalkKey(key: string, repeat: boolean, targetTag: string | undefined, editable: boolean): boolean {
  if (key !== " " && key !== "Spacebar") return false;
  if (repeat) return false;
  const tag = (targetTag ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  return !editable;
}
