import { useEffect, useState } from "react";

/** Locked screen. Checks /api/auth/whoami first: a request authenticated by Tailscale identity needs no token. */
export function TokenGate() {
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/whoami")
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => { if (alive && w?.method === "tailscale") { localStorage.removeItem("cyberdeck-token"); location.reload(); } else if (alive) setChecked(true); })
      .catch(() => { if (alive) setChecked(true); });
    return () => { alive = false; };
  }, []);
  if (!checked) return <div className="flex min-h-screen items-center justify-center text-xs uppercase tracking-widest text-zinc-600">checking identity…</div>;
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="hud-card w-full max-w-md p-8">
        <div className="hud-label neon">Access</div>
        <h1 className="mt-3 text-xl font-semibold uppercase tracking-[0.15em] text-zinc-100">Cyberdeck is locked</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Over the tailnet this unlocks by itself. Otherwise run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">cyberdeck open</code> in a
          terminal, or paste the token from <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">~/.cyberdeck/token</code>.
        </p>
        <form
          className="mt-5 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            localStorage.setItem("cyberdeck-token", value.trim());
            location.reload();
          }}
        >
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="access token"
            className="flex-1 rounded-sm border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-sky-500/60"
          />
          <button className="hud-badge neon px-4 py-2 text-sm hover:bg-sky-500/10">Unlock</button>
        </form>
      </div>
    </div>
  );
}
