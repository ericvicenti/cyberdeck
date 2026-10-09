export interface NetworkSample {
  source: string;
  target: string;
  at: number;
  latencyMs: number | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  bytes: number;
  error?: string;
}
export interface NetworkNode {
  id: string | null;
  name: string;
  kind: string;
  roles: string[];
  services: string[];
  local: boolean;
}
export interface NetworkSnapshot {
  source: string;
  nodes: NetworkNode[];
  samples: NetworkSample[];
  running: string | null;
  automatic: boolean;
  intervalMs: number;
  nextCheckAt: number | null;
}
export const NETWORK_BYTES = 4 * 1024 * 1024;
export const NETWORK_INTERVAL = 6 * 60 * 60 * 1000;
export const networkName = (name: string) => name.toLowerCase().replace(/\.local$/, "");
