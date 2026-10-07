import { describe, expect, test } from "bun:test";
import { parseTree, isRef } from "../src/daemon/api/cmux";

const SAMPLE = `window window:1 CD9790BC-7B16-452D-8F3B-DC20EE303CC1 [current] ◀ active
├── workspace workspace:10 D40D0D4B-868D-4B7F-A98A-C54140B5FD10 "✳ Claude Code" [selected] ◀ active
│   └── pane pane:14 B7412D51-6832-440E-9BC0-BAA4927847C1 [focused] ◀ active
│       └── surface surface:47 2A2395E8-0637-40F3-9E1B-A9DC33914B4C [terminal] "◐ Unified CLI" [selected] ◀ active tty=ttys009
├── workspace workspace:2 EEDEC9A3-AD78-4598-933C-D0E6A6D8D852 "✳ Claude Code"
│   ├── pane pane:3 A1D24E20-BF11-44C1-B6C1-CBD2D9A76A35 [focused]
│   │   ├── surface surface:38 54F190BF-9F02-45A8-AE99-8B6B54ABD216 [terminal] "Seedteamtalks \\"quoted\\" issue" tty=ttys014
│   │   └── surface surface:45 10D2EF12-6E92-41AA-8CC1-2F8AD7EEBA24 [terminal] "Review PR #1201 | Code" [selected] tty=ttys000
│   └── pane pane:11 55BF32FC-B1CF-4A7C-9AD1-332A238C1356
│       └── surface surface:28 3357D359-4A44-4531-8B01-C2B8D8C4DFF6 [terminal] "./dev up" [selected] tty=ttys001
└── workspace workspace:6 "LangKit"
    └── pane pane:8
        └── surface surface:13 [browser] "What is LangKit?" [selected] file:///Users/eric/Code/LangKit/site.html
`;

describe("cmux tree parser", () => {
  const tree = parseTree(SAMPLE);
  test("nests window > workspace > pane > surface", () => {
    expect(tree).toHaveLength(1);
    const w = tree[0];
    expect(w.kind).toBe("window");
    expect(w.ref).toBe("window:1");
    expect(w.uuid).toBe("CD9790BC-7B16-452D-8F3B-DC20EE303CC1");
    expect(w.current).toBe(true);
    expect(w.children.map((x) => x.ref)).toEqual(["workspace:10", "workspace:2", "workspace:6"]);
    expect(w.children[1].children.map((p) => p.ref)).toEqual(["pane:3", "pane:11"]);
    expect(w.children[1].children[0].children).toHaveLength(2);
  });
  test("captures titles, flags, type, tty and url", () => {
    const ws10 = tree[0].children[0];
    expect(ws10.title).toBe("✳ Claude Code");
    expect(ws10.selected).toBe(true);
    expect(ws10.active).toBe(true);
    const s47 = ws10.children[0].children[0];
    expect(s47.type).toBe("terminal");
    expect(s47.tty).toBe("ttys009");
    expect(s47.title).toBe("◐ Unified CLI");
    const quoted = tree[0].children[1].children[0].children[0];
    expect(quoted.title).toBe('Seedteamtalks \\"quoted\\" issue');
    expect(quoted.selected).toBe(false);
    const browser = tree[0].children[2].children[0].children[0];
    expect(browser.type).toBe("browser");
    expect(browser.uuid).toBeUndefined();
    expect(browser.url).toBe("file:///Users/eric/Code/LangKit/site.html");
  });
  test("ignores noise lines", () => {
    expect(parseTree("cmux: notice\n\n")).toEqual([]);
  });
});

describe("cmux ref validation", () => {
  test("accepts short refs and uuids only", () => {
    expect(isRef("surface:47")).toBe(true);
    expect(isRef("tab:3")).toBe(true);
    expect(isRef("2A2395E8-0637-40F3-9E1B-A9DC33914B4C")).toBe(true);
    expect(isRef("surface:47; rm -rf /")).toBe(false);
    expect(isRef("--workspace")).toBe(false);
    expect(isRef(47)).toBe(false);
  });
});
