export type SteamGame = { id: string; name: string; ready: boolean; status?: number; progress?: number; compatible?: boolean };
export type SteamSession = { id: string; name: string; phase: "installing" | "launching" | "running" | "returned" | "attention" | "ended" | "error"; prompt?: { kind: "syncfailed" | "cloudconflict" | "pendingcloudsessions"; action: number }; error?: string; progress?: number };
export type SteamLibrary = {
  supported: boolean;
  available: boolean;
  connected?: boolean;
  reason: string | null;
  node: string;
  games: SteamGame[];
  warnings: string[];
  session?: SteamSession | null;
};
