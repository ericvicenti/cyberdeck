// The node summary behind GET /api/status, shared with the MCP server.
import type { Database } from "bun:sqlite";
import type { CyberdeckConfig } from "./config";
import { isScanRunning } from "./indexer/scan";
import { isDataScanRunning } from "./indexer/data";
import { isUpdating } from "./updater";

export type NodeStatus = {
  nodeName: string;
  version: string;
  commit: string;
  updating: boolean;
  roots: string[];
  scanning: boolean;
  dataScanning: boolean;
  watching: boolean;
  repos: number | null;
  atRisk: number | null;
  attention: number | null;
  safe: number | null;
  junkBytes: number | null;
  lastScanAt: number | null;
  dataBytes: number | null;
  dataCacheBytes: number | null;
};

export function nodeStatus(db: Database, cfg: CyberdeckConfig, build: { version: string; commit: string }): NodeStatus {
  const counts = db
    .query(
      `SELECT
         COUNT(*) AS repos,
         SUM(risk = 'at-risk') AS atRisk,
         SUM(risk = 'attention') AS attention,
         SUM(risk = 'safe') AS safe,
         SUM(junk_bytes) AS junkBytes,
         MAX(scanned_at) AS lastScanAt
       FROM repos`
    )
    .get() as Pick<NodeStatus, "repos" | "atRisk" | "attention" | "safe" | "junkBytes" | "lastScanAt">;
  const data = db
    .query(`SELECT SUM(size_bytes) AS dataBytes, SUM(cache_bytes) AS dataCacheBytes FROM data_dirs`)
    .get() as Pick<NodeStatus, "dataBytes" | "dataCacheBytes">;
  return {
    nodeName: cfg.nodeName,
    version: build.version,
    commit: build.commit,
    updating: isUpdating(),
    roots: cfg.roots,
    scanning: isScanRunning(),
    dataScanning: isDataScanRunning(),
    watching: cfg.watch,
    ...counts,
    ...data,
  };
}
