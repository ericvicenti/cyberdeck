// Home-screen install: the Desk page advertises its own manifest ("Desk", mic icon, opens on #/desk)
// so "Add to Home Screen" from there gives the phone a one-tap TALK button; every other page installs
// Cyberdeck itself. Browsers read these tags when the user installs, so swapping them per route is enough.
export type InstallTarget = { manifest: string; title: string; icon: string };

export function installTarget(view: string): InstallTarget {
  return view === "desk"
    ? { manifest: "/desk.webmanifest", title: "Desk", icon: "/icons/desk-180.png" }
    : { manifest: "/manifest.webmanifest", title: "Cyberdeck", icon: "/icons/cyberdeck-180.png" };
}

function headTag(selector: string, create: () => HTMLElement): HTMLElement {
  return document.head.querySelector<HTMLElement>(selector) ?? document.head.appendChild(create());
}

export function applyInstallTarget(view: string) {
  const t = installTarget(view);
  const link = (rel: string) => () => Object.assign(document.createElement("link"), { rel });
  headTag('link[rel="manifest"]', link("manifest")).setAttribute("href", t.manifest);
  headTag('link[rel="apple-touch-icon"]', link("apple-touch-icon")).setAttribute("href", t.icon);
  headTag('meta[name="apple-mobile-web-app-title"]', () => Object.assign(document.createElement("meta"), { name: "apple-mobile-web-app-title" })).setAttribute("content", t.title);
}
