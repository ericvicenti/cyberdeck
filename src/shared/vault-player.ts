/** The installed browser cores; the rest of the Vault stays available for browsing. */
export const PLAYER_SYSTEMS: Record<
  string,
  { core: string; folder: string; extensions: string[]; scheme?: string }
> = {
  NES: { core: "nestopia", folder: "nes", extensions: ["nes"] },
  SNES: {
    core: "snes9x",
    folder: "snes",
    extensions: ["sfc", "smc", "fig", "swc"],
  },
  N64: {
    core: "mupen64plus_next",
    folder: "n64",
    extensions: ["z64", "n64", "v64"],
  },
  GB: { core: "gambatte", folder: "gb", extensions: ["gb"] },
  GBC: { core: "gambatte", folder: "gbc", extensions: ["gbc", "gb"] },
  GBA: { core: "mgba", folder: "gba", extensions: ["gba"] },
  Genesis: {
    core: "genesis_plus_gx",
    folder: "genesis",
    extensions: ["md", "gen", "bin", "smd"],
    scheme: "segaMD",
  },
  SMS: {
    core: "genesis_plus_gx",
    folder: "sms",
    extensions: ["sms"],
    scheme: "segaMS",
  },
  GG: {
    core: "genesis_plus_gx",
    folder: "gg",
    extensions: ["gg"],
    scheme: "segaGG",
  },
};
export const MAX_ROM_BYTES = 128 * 1024 * 1024;
export const MAX_STATE_BYTES = 32 * 1024 * 1024;
export type NodeRom = {
  id: string;
  system: string;
  name: string;
  size: number;
};
export function romError(
  system: string,
  name: string,
  size: number,
): string | null {
  const supported = PLAYER_SYSTEMS[system];
  if (!supported) return "Inline play is not available for this console yet.";
  if (!size) return "This game file is empty.";
  if (size > MAX_ROM_BYTES) return "Choose a game file smaller than 128 MiB.";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (![...supported.extensions, "zip", "7z"].includes(ext))
    return `Choose a ${supported.extensions
      .map((e) => "." + e)
      .join(", ")}, .zip or .7z game file.`;
  return null;
}
