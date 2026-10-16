import { useEffect } from "react";

/** The fragment is the view's source of truth, including which paired node it uses.
 * Missing node means the serving machine, never a preference from another tab. */
export interface Route { view: string; params: URLSearchParams }
export const VIEW_NAMES: Record<string, string> = {
  fleet: "Home", controls: "Controls", applications: "Applications", spotify: "Spotify",
  desk: "Desk", projects: "Projects", agents: "Agents", services: "Services", data: "Data",
  files: "Files", edit: "Editor", term: "Sessions", cmux: "cmux", cloud: "Cloud", remote: "Screen remote",
};

export function readRoute(hash = location.hash): Route {
  const h = hash.replace(/^#\/?/, ""), separator = h.indexOf("?");
  const view = (separator < 0 ? h : h.slice(0, separator)).replace(/\/$/, "") || "fleet";
  const params = new URLSearchParams(separator < 0 ? "" : h.slice(separator + 1));
  // Normalize legacy links without creating another history entry.
  if (view === "services" && params.has("service")) {
    if (!params.has("svc")) params.set("svc", params.get("service")!);
    params.delete("service");
  }
  if (view === "applications" && params.get("app") === "steam") {
    params.set("app", "vimm"); params.set("tab", "steam");
  }
  if (!params.get("node")) params.delete("node");
  return { view, params };
}

export function routeHash(view: string, params: URLSearchParams | Record<string, string> = {}): string {
  const q = new URLSearchParams(params);
  q.sort();
  return `#/${view}${q.size ? `?${q}` : ""}`;
}

export function parseHash(): Route {
  const route = readRoute();
  const canonical = routeHash(route.view, route.params);
  if (location.hash !== canonical) history.replaceState(history.state, "", canonical);
  return route;
}

export function writeRoute(view: string, params: URLSearchParams | Record<string, string>, mode: "push" | "replace" = "push") {
  const route = readRoute(routeHash(view, params)), hash = routeHash(route.view, route.params);
  if (location.hash === hash) return;
  history[mode === "replace" ? "replaceState" : "pushState"](null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function navigate(view: string, params: Record<string, string> = {}, mode: "push" | "replace" = "push") {
  const q = new URLSearchParams(params);
  if (!q.has("node")) q.set("node", readRoute().params.get("node") ?? "");
  writeRoute(view, q, mode);
}

let editing: { element: Element | null; hash: string } | undefined;
let watchingEdits = false;
/** Merge against the actual location, so rapid events never reuse stale React props.
 * `edit` makes one history entry for an input edit, then replaces successive
 * keystrokes until focus or navigation changes. Back restores the prior search. */
export function updateParams(values: Record<string, string | null>, mode: "push" | "replace" | "edit" = "push") {
  const { view, params } = readRoute();
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === "") params.delete(key); else params.set(key, value);
  }
  if (mode === "edit") {
    if (!watchingEdits) {
      document.addEventListener("focusout", () => { editing = undefined; });
      window.addEventListener("hashchange", () => { editing = undefined; });
      watchingEdits = true;
    }
    const replace = editing?.element === document.activeElement && editing?.hash === location.hash;
    writeRoute(view, params, replace ? "replace" : "push");
    editing = { element: document.activeElement, hash: location.hash };
  } else {
    editing = undefined;
    writeRoute(view, params, mode);
  }
}

export function routeTitle(route = readRoute()): string {
  const p = route.params;
  let title = Object.hasOwn(VIEW_NAMES, route.view) ? VIEW_NAMES[route.view] : "Page not found";
  const detail = route.view === "files" || route.view === "edit" ? p.get("path")
    : route.view === "projects" ? p.get("p")
    : route.view === "services" ? [p.get("host"), p.get("svc")].filter(Boolean).join(" / ")
    : route.view === "term" ? p.get("session")
    : route.view === "cmux" ? p.get("surface")
    : route.view === "agents" ? p.get("run") || p.get("task")
    : route.view === "cloud" ? p.get("conversation") || p.get("profile") : null;
  if (detail) title = `${detail} · ${title}`;
  if (route.view === "applications" && p.get("app")) {
    title = p.get("app") === "vimm" ? `${p.get("tab") === "steam" ? "PC games · " : ""}The Vault` : p.get("app") === "afterglow" ? "Afterglow" : `${p.get("app")} · Applications`;
  }
  if (p.get("q")) title = `${p.get("q")} · ${title}`;
  if (p.get("node")) title += ` · ${p.get("node")}`;
  return `${title.replace(/[\u0000-\u001f]/g, " ").slice(0, 350)} · Cyberdeck`;
}

// Dynamic titles belong to an exact route. An old async response/cleanup cannot
// overwrite the title after Back, a node switch, or leaving an embedded app.
let titleClaim: { owner: object; hash: string; title: string } | undefined;
export function refreshRouteTitle(locked = false, notFound = false) {
  document.title = locked ? "Locked · Cyberdeck" : notFound ? "Page not found · Cyberdeck" : titleClaim?.hash === location.hash ? titleClaim.title : routeTitle();
}
export function claimRouteTitle(title: string, hash = location.hash): () => void {
  const owner = {};
  if (hash === location.hash) {
    titleClaim = { owner, hash, title: `${title.replace(/[\u0000-\u001f]/g, " ").slice(0, 350)} · Cyberdeck` };
    refreshRouteTitle();
  }
  return () => { if (titleClaim?.owner === owner) { titleClaim = undefined; refreshRouteTitle(); } };
}
export function useRouteTitle(title: string | undefined) {
  const hash = location.hash;
  useEffect(() => title ? claimRouteTitle(title, hash) : undefined, [title, hash]);
}
