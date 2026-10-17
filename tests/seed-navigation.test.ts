import { expect, test } from "bun:test";
import { seedHash } from "../ui/lib/seed-agents";
test("Seed new-window links carry the exact signing node and encoded nested route", () => {
  const path = "agent/example?tab=memory&file=notes%2Ftoday.md";
  const hash = seedHash(path, "peer/a & b");
  const params = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  expect(params.get("node")).toBe("peer/a & b");
  expect(params.get("r")).toBe(path);
  expect(seedHash("", "")).toBe("#/seed");
  expect(seedHash("", "peer-a")).toBe("#/seed?node=peer-a");
});
