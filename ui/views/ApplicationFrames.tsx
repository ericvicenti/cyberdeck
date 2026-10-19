import { useEffect, useRef, useState } from "react";
import { navigate } from "../lib/api";
import { AfterglowFrame } from "./AfterglowFrame";

type Application = { id: string; name: string; url: string };

/** Only visited apps mount. Keep their documents alive while browsing elsewhere. */
export function ApplicationFrames({ app, params, visible }: {
  app?: Application; params: URLSearchParams; visible: boolean;
}) {
  const [opened, setOpened] = useState<Application[]>([]);
  const selections = useRef(new Map<string, URLSearchParams>());
  const key = (item: Application) => `${item.id}\n${item.url}`;
  if (visible && app) selections.current.set(key(app), params);
  useEffect(() => {
    if (visible && app) setOpened(previous => previous.some(item => key(item) === key(app)) ? previous : [...previous, app]);
  }, [app, visible]);
  return <>{opened.map(item => {
    const active = visible && !!app && key(item) === key(app);
    return <div key={key(item)} className={active ? "h-full" : "hidden"} inert={!active} aria-hidden={!active}>
      {item.id === "afterglow"
        ? <AfterglowFrame url={item.url} name={item.name} params={selections.current.get(key(item))!} visible={active} />
        : <GenericFrame app={item} visible={active} />}
    </div>;
  })}</>;
}

function GenericFrame({ app, visible }: { app: Application; visible: boolean }) {
  const [reload, setReload] = useState(0);
  return <section className="flex h-full flex-col" aria-label={app.name}>
    <div className="flex shrink-0 items-center gap-4 border-b border-zinc-800 px-4 py-2 text-sm">
      <button data-tv-frame-back onClick={() => navigate("applications")} className="text-cyan-300">← Applications</button>
      <strong>{app.name}</strong><span className="flex-1" />
      <button onClick={() => setReload(n => n + 1)}>Reload</button>
    </div>
    <iframe key={reload} data-tv-autofocus onLoad={event => {
      const input = window as Window & { __cyberdeckInputBridge?: unknown; __cyberdeckTV?: { focusElement: (element: HTMLElement) => void } };
      if (visible && input.__cyberdeckInputBridge) input.__cyberdeckTV?.focusElement(event.currentTarget);
    }} title={app.name} src={app.url} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen className="min-h-0 w-full flex-1 border-0 bg-black" />
  </section>;
}
