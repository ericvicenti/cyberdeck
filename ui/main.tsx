import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Token arrives via `cyberdeck open` as #t=..., then persists in localStorage.
const hashToken = new URLSearchParams(location.hash.slice(1)).get("t");
if (hashToken) {
  localStorage.setItem("cyberdeck-token", hashToken);
  history.replaceState(null, "", location.pathname);
}

// OAuth returns to the allowlisted root URL (Spotify does not allow hash redirects).
if (new URLSearchParams(location.search).has("code") || new URLSearchParams(location.search).has("error")) {
  history.replaceState(null, "", location.pathname + location.search + "#/spotify");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
