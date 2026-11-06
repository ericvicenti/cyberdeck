// Host liveness: the manifest's tailnet view, corrected by paired nodes that answer (src/shared/liveness.ts).
import { describe, expect, test } from "bun:test";
import { withPeerLiveness } from "../src/shared/liveness";

describe("withPeerLiveness", () => {
  const hosts = [{ name: "yacht", online: false }, { name: "botical", online: null }, { name: "clipper", online: true }, { name: "agentic", online: null }];

  test("an answering peer makes an offline or unknown host online, reached by Cyberdeck", () => {
    const out = withPeerLiveness(hosts, [{ name: "Yacht", online: true, transport: "probe" }, { name: "botical", online: true, transport: "probe" }]);
    expect(out[0]).toEqual({ name: "yacht", online: true, reach: "cyberdeck", transport: "probe" });
    expect(out[1]).toEqual({ name: "botical", online: true, reach: "cyberdeck", transport: "probe" });
    expect(out[2]).toBe(hosts[2]);
    expect(out[3]).toBe(hosts[3]);
  });

  test("a silent peer fills in unknown as offline and never overrides the manifest", () => {
    const out = withPeerLiveness(hosts, [{ name: "botical", online: false }, { name: "clipper", online: false }, { name: "yacht", online: false }]);
    expect(out.map((h) => h.online)).toEqual([false, false, true, null]);
    expect(out[1].reach).toBeUndefined();
  });
});
