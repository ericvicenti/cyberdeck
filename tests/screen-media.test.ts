// The screen media module over a fake kiosk page: Afterglow's frame, its video, and the routes.
import { describe, test, expect } from "bun:test";
import { screenMedia, watchRoute, routeFor, parseMediaCommand, mediaSentence, type MediaPage, type MediaFrame, type LibraryItem } from "../src/daemon/screenmedia";

type FakeVideo = { paused: boolean; ended: boolean; currentTime: number; duration: number; muted: boolean; volume: number };
type FakeDoc = { afterglow?: boolean; route?: string; title: string; video?: FakeVideo; label?: string; navigated: string[] };

/** Runs the serialized probe/act scripts against a fake window + document. */
function fakeFrame(doc: FakeDoc, url = "https://afterglow.test/?cyberdeck=x"): MediaFrame & { doc: FakeDoc } {
  const el = (v: FakeVideo) => ({ ...v, getBoundingClientRect: () => ({ width: 100, height: 100 }), play: async () => { v.paused = false; }, pause: () => { v.paused = true; },
    get paused() { return v.paused; }, set paused(x: boolean) { v.paused = x; }, get currentTime() { return v.currentTime; }, set currentTime(x: number) { v.currentTime = x; },
    get muted() { return v.muted; }, set muted(x: boolean) { v.muted = x; }, get volume() { return v.volume; }, set volume(x: number) { v.volume = x; }, get ended() { return v.ended; }, get duration() { return v.duration; } });
  return {
    doc,
    url: () => url,
    async evaluate(fn: any, arg?: any) {
      const win: any = { afterglowNavigation: doc.afterglow ? { route: () => doc.route ?? "", navigate: (r: string) => { doc.navigated.push(r); doc.route = r; } } : undefined };
      const document = {
        title: doc.title,
        querySelectorAll: (sel: string) => (sel === "video" && doc.video ? [el(doc.video)] : []),
        querySelector: (sel: string) => (sel === ".player-title" && doc.label ? { textContent: ` ${doc.label} ` } : null),
      };
      const location = { get hash() { return doc.route ?? ""; }, set hash(h: string) { doc.navigated.push(h); doc.route = h; } };
      const src = fn.toString();
      const f = new Function("window", "document", "location", `return (${src})(arguments[3]);`);
      return f(win, document, location, arg);
    },
  };
}

function fakePage(docs: FakeDoc[], url = "http://127.0.0.1:4777/#/applications?app=afterglow"): MediaPage & { outer: string[]; frames(): (MediaFrame & { doc: FakeDoc })[] } {
  const frames = docs.map((d, i) => fakeFrame(d, i === 0 ? url : undefined));
  const page = {
    outer: [] as string[],
    url: () => url,
    title: async () => docs[0]?.title ?? "",
    frames: () => frames,
    async evaluate(fn: any, arg?: any) { page.outer.push(arg); if (docs[1]) { docs[1].afterglow = true; docs[1].route = new URLSearchParams(String(arg).split("?")[1]).get("route") ?? ""; } },
  };
  return page;
}
const noSleep = async () => {};

describe("screenMedia", () => {
  test("status reads the Afterglow frame, its route and the visible video", async () => {
    const page = fakePage([{ title: "Cyberdeck", navigated: [] }, { afterglow: true, route: "watch/3/0", title: "Dune · Afterglow", label: "Dune", video: { paused: false, ended: false, currentTime: 125, duration: 9000, muted: false, volume: 0.8 }, navigated: [] }]);
    const s = await screenMedia(page, { action: "status" }, { sleep: noSleep });
    expect(s).toMatchObject({ ok: true, action: "status", afterglow: { present: true, route: "watch/3/0", title: "Dune · Afterglow" }, video: { playing: true, currentTime: 125, duration: 9000, volume: 80, label: "Dune" } });
    expect(mediaSentence("enuc", s)).toBe("enuc's screen is playing Dune at 2 minutes of 2 hours 30 minutes.");
  });

  test("pause, play, seek, mute and volume act on the video and report the result", async () => {
    const video = { paused: false, ended: false, currentTime: 100, duration: 600, muted: false, volume: 1 };
    const page = fakePage([{ title: "Cyberdeck", navigated: [] }, { afterglow: true, route: "watch/3/0", title: "Dune", label: "Dune", video, navigated: [] }]);
    const paused = await screenMedia(page, { action: "pause" }, { sleep: noSleep });
    expect(paused).toMatchObject({ ok: true, did: "paused", video: { playing: false } });
    expect(mediaSentence("enuc", paused)).toBe("Paused enuc's screen; it is paused on Dune at 1 minute of 10 minutes.");
    expect((await screenMedia(page, { action: "toggle" }, { sleep: noSleep })).video?.playing).toBe(true);
    expect((await screenMedia(page, { action: "seek", value: -30 }, { sleep: noSleep })).video?.currentTime).toBe(70);
    expect((await screenMedia(page, { action: "seek", value: "oops" }, { sleep: noSleep })).ok).toBe(false);
    expect((await screenMedia(page, { action: "mute" }, { sleep: noSleep })).video?.muted).toBe(true);
    expect((await screenMedia(page, { action: "unmute" }, { sleep: noSleep })).video?.muted).toBe(false);
    const vol = await screenMedia(page, { action: "volume", value: 25 }, { sleep: noSleep });
    expect(vol.video?.volume).toBe(25);
    expect(mediaSentence("enuc", vol)).toMatch(/^Set the volume on enuc's screen to 25; it is playing Dune/);
  });

  test("video actions without a video say so; status without Afterglow names the page", async () => {
    const page = fakePage([{ title: "Cyberdeck · Fleet", navigated: [] }], "http://127.0.0.1:4777/#/fleet");
    const s = await screenMedia(page, { action: "play" }, { sleep: noSleep });
    expect(s).toMatchObject({ ok: false, error: "Nothing is playing on the screen.", afterglow: { present: false } });
    expect(mediaSentence("enuc", await screenMedia(page, { action: "status" }, { sleep: noSleep }))).toBe("enuc's screen shows Cyberdeck · Fleet; nothing is playing.");
  });

  test("search and library navigate inside Afterglow when it is on screen", async () => {
    const inner = { afterglow: true, route: "discover", title: "Afterglow", navigated: [] as string[] };
    const page = fakePage([{ title: "Cyberdeck", navigated: [] }, inner]);
    const s = await screenMedia(page, { action: "search", value: "blade runner" }, { sleep: noSleep });
    expect(inner.navigated).toEqual(["search/blade%20runner"]);
    expect(s).toMatchObject({ ok: true, did: "opened search/blade%20runner", afterglow: { route: "search/blade%20runner" } });
    expect(page.outer).toEqual([]);
    expect(mediaSentence("enuc", s)).toBe("Opened search/blade%20runner on enuc's screen.");
    await screenMedia(page, { action: "library" }, { sleep: noSleep });
    expect(inner.navigated.at(-1)).toBe("library");
  });

  test("without Afterglow on screen the outer page is pointed at the Applications view first", async () => {
    const page = fakePage([{ title: "Cyberdeck · Fleet", navigated: [] }, { title: "about:blank", navigated: [] }], "http://127.0.0.1:4777/#/fleet");
    const s = await screenMedia(page, { action: "open", value: "#/saved" }, { sleep: noSleep });
    expect(page.outer).toEqual(["#/applications?app=afterglow&route=saved"]);
    expect(s).toMatchObject({ ok: true, did: "opened saved", afterglow: { present: true, route: "saved" } });
  });

  test("watch picks the downloaded title that matches and opens its first video file", async () => {
    const items: LibraryItem[] = [
      { id: 7, name: "Dune.Part.Two.2024.1080p", media: { name: "Dune: Part Two", type: "movie" }, files: [{ index: 0, name: "sample.mkv", video: true, included: false }, { index: 1, name: "Dune.mkv", video: true }, { index: 2, name: "sub.srt", video: false }] },
      { id: 8, name: "Heat.1995", media: { name: "Heat" }, files: [{ index: 0, name: "Heat.mkv", video: true }] },
      { id: 9, name: "Pending", media: { name: "Pending Title" }, files: [{ index: 0, name: "readme.txt", video: false }] },
    ];
    expect(watchRoute(items, "dune part two")).toEqual({ route: "watch/7/1", name: "Dune: Part Two" });
    expect(watchRoute(items, "Heat")).toEqual({ route: "watch/8/0", name: "Heat" });
    expect(watchRoute(items, "pending")).toEqual({ error: "Pending Title is in the library but has no video file yet." });
    expect(watchRoute(items, "alien")).toEqual({ error: 'Nothing in the library matches "alien".' });
    expect(watchRoute(items, "  ")).toEqual({ error: "Say which title to play." });
    const inner = { afterglow: true, route: "discover", title: "Afterglow", navigated: [] as string[] };
    const page = fakePage([{ title: "Cyberdeck", navigated: [] }, inner]);
    const s = await screenMedia(page, { action: "watch", value: "heat" }, { sleep: noSleep, library: async () => items });
    expect(inner.navigated).toEqual(["watch/8/0"]);
    expect(mediaSentence("enuc", s)).toBe("Playing Heat on enuc's screen.");
    const none = await screenMedia(page, { action: "watch", value: "heat" }, { sleep: noSleep });
    expect(none).toMatchObject({ ok: false, error: "This node cannot look up Afterglow's library." });
    const down = await screenMedia(page, { action: "watch", value: "heat" }, { sleep: noSleep, library: async () => { throw new Error("tunnel closed"); } });
    expect(down.error).toBe("Afterglow's library did not answer: tunnel closed");
  });

  test("routeFor and parseMediaCommand validate what the agent sends", () => {
    expect(routeFor({ action: "open", value: "#/title/movie/tt1" })).toBe("title/movie/tt1");
    expect(routeFor({ action: "open" })).toBe("discover");
    expect(routeFor({ action: "music" })).toBe("music");
    expect(routeFor({ action: "play" })).toBeNull();
    expect(parseMediaCommand({})).toEqual({ action: "status", value: undefined });
    expect(parseMediaCommand({ action: "seek", value: -10 })).toEqual({ action: "seek", value: -10 });
    expect(parseMediaCommand({ action: "dance" })).toMatchObject({ error: expect.stringContaining("action must be one of") });
    expect(parseMediaCommand({ action: "search" })).toEqual({ error: "search needs a value" });
    expect(parseMediaCommand({ action: "open", value: { x: 1 } })).toEqual({ error: "value must be a string or a number" });
    expect(parseMediaCommand({ action: "library" })).toEqual({ action: "library", value: undefined });
  });
});
