import { useRef } from "react";
import { navigate } from "../lib/api";
import { CaseworkConsole, type CaseworkApp } from "./CaseworkConsole";

/** Each visited console owns its socket, call and received media until lock/close. */
export function CaseworkConsoles({ app, params, visible, onLocked }: {
  app?: CaseworkApp; params: URLSearchParams; visible: boolean; onLocked: () => void;
}) {
  const opened = useRef(new Map<string, { app: CaseworkApp; params: URLSearchParams }>());
  if (visible && app) opened.current.set(app.id, { app, params });
  return <>{[...opened.current.values()].map(item => {
    const active = visible && app?.id === item.app.id;
    return <section key={item.app.id} className={active ? "flex h-full flex-col" : "hidden"}
      inert={!active} aria-hidden={!active} aria-label={item.app.name}>
      <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
        <button data-tv-frame-back onClick={() => navigate("applications")} className="text-cyan-300">← Applications</button>
        <strong>{item.app.name}</strong><span className="text-zinc-500">Casework example app</span>
      </div>
      <div className="min-h-0 flex-1"><CaseworkConsole app={item.app} params={item.params}
        visible={active} onLocked={onLocked} /></div>
    </section>;
  })}</>;
}
