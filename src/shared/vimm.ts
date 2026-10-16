/** Vimm's public Vault system identifiers. No credentials or executable content. */
export const VIMM_SYSTEMS = [
  ["NES", "Nintendo", "8-bit beginnings"],
  ["SNES", "Super Nintendo", "The golden age"],
  ["N64", "Nintendo 64", "A new dimension"],
  ["GameCube", "GameCube", "Small console. Big worlds."],
  ["Wii", "Wii", "Everybody plays"],
  ["WiiU", "Wii U", "Two screens, one world"],
  ["PS1", "PlayStation", "Greatness begins"],
  ["PS2", "PlayStation 2", "An endless library"],
  ["PS3", "PlayStation 3", "The HD generation"],
  ["Genesis", "Genesis", "16-bit attitude"],
  ["Dreamcast", "Dreamcast", "Ahead of its time"],
  ["Saturn", "Saturn", "Arcade at home"],
  ["GB", "Game Boy", "Pocket-sized adventures"],
  ["GBC", "Game Boy Color", "A little more color"],
  ["GBA", "Game Boy Advance", "Take the classics along"],
  ["DS", "Nintendo DS", "Double the possibilities"],
  ["3DS", "Nintendo 3DS", "Another dimension"],
  ["PSP", "PS Portable", "Big games to go"],
  ["Xbox", "Xbox", "A new challenger"],
  ["Xbox360", "Xbox 360", "Jump in"],
  ["Atari2600", "Atari 2600", "Where it started"],
  ["Atari5200", "Atari 5200", "Early adventures"],
  ["Atari7800", "Atari 7800", "Arcade roots"],
  ["SMS", "Master System", "Sega's early years"],
  ["TG16", "TurboGrafx-16", "Beyond 8-bit"],
  ["TGCD", "TurboGrafx-CD", "The CD era"],
  ["CDi", "CD-i", "Off the beaten path"],
  ["SegaCD", "Sega CD", "A new format"],
  ["Jaguar", "Jaguar", "An ambitious era"],
  ["32X", "Sega 32X", "The next level"],
  ["JaguarCD", "Jaguar CD", "Rare discoveries"],
  ["X360-D", "Xbox 360 (Digital)", "Digital discoveries"],
  ["WiiWare", "WiiWare", "Small wonders"],
  ["Lynx", "Lynx", "Color on the go"],
  ["GG", "Game Gear", "Portable Sega"],
  ["VB", "Virtual Boy", "A different perspective"],
] as const;
export type VaultGame = {
  id: string;
  title: string;
  system: string;
  regions: string[];
  version?: string;
  rating?: number;
  manual?: string;
};
export type VaultShelf = { title: string; system: string; games: VaultGame[] };
export type VaultCatalog = {
  games: VaultGame[];
  page: number;
  pages: number;
  source: string;
  fetchedAt: number;
};
export type VaultHome = { shelves: VaultShelf[]; errors: string[] };
export const systemName = (id: string) =>
  VIMM_SYSTEMS.find((s) => s[0] === id)?.[1] ?? id;
