import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { installTVInput } from "./lib/tv/runtime";
installTVInput();

// On the TV, a running game owns the controller: the deck stands down until it exits,
// however the game was started (this screen, a phone, the API).
if (window.__cyberdeckInputBridge) {
  const check = () =>
    fetch("/api/games/status", { headers: { authorization: `Bearer ${localStorage.getItem("cyberdeck-token") ?? ""}` } })
      .then(r => (r.ok ? r.json() : { running: null }))
      .then(({ running }) => document.documentElement.toggleAttribute("data-tv-suspend", Boolean(running)))
      .catch(() => {});
  setInterval(check, 1000);
  void check();
}

// Token arrives via `cyberdeck open` as #t=..., then persists in localStorage.
const hashToken = new URLSearchParams(location.hash.slice(1)).get("t");
if (hashToken) {
  localStorage.setItem("cyberdeck-token", hashToken);
  history.replaceState(null, "", location.pathname);
}

// OAuth returns to the allowlisted root URL (Spotify does not allow hash redirects).
if (new URLSearchParams(location.search).has("code") || new URLSearchParams(location.search).has("error")) {
  history.replaceState(null, "", location.pathname + location.search + "#/applications?app=afterglow&tab=music");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
