// Home-screen install: the Desk page swaps in its own manifest so a phone gets a one-tap TALK button.
import { describe, test, expect } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { installTarget } from "../ui/lib/pwa";

const PUBLIC = join(import.meta.dir, "..", "ui", "public");

describe("PWA manifests", () => {
  test("the Desk route installs as Desk, every other route as Cyberdeck", () => {
    expect(installTarget("desk")).toEqual({ manifest: "/desk.webmanifest", title: "Desk", icon: "/icons/desk-180.png" });
    expect(installTarget("fleet").manifest).toBe("/manifest.webmanifest");
    expect(installTarget("services").title).toBe("Cyberdeck");
  });
  for (const [file, start] of [["desk.webmanifest", "/#/desk"], ["manifest.webmanifest", "/"]] as const) {
    test(`${file} is installable standalone and its icons exist`, async () => {
      const m = await Bun.file(join(PUBLIC, file)).json();
      expect(m.start_url).toBe(start);
      expect(m.display).toBe("standalone");
      const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
      expect(sizes).toContain("192x192");
      expect(sizes).toContain("512x512");
      for (const i of m.icons) expect(existsSync(join(PUBLIC, i.src))).toBe(true);
    });
  }
  test("touch icons for both targets exist", () => {
    for (const v of ["desk", "fleet"]) expect(existsSync(join(PUBLIC, installTarget(v).icon))).toBe(true);
  });
});
