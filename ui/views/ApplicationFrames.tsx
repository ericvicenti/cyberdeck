import { useEffect, useRef, useState } from "react";
import { EmbeddedFrame } from "./EmbeddedFrame";
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
    // Refresh display metadata without changing the retained document identity.
    const currentApp = active ? app! : item;
    return <div key={key(item)} className={active ? "h-full" : "hidden"} inert={!active} aria-hidden={!active}>
      {item.id === "afterglow"
        ? <AfterglowFrame url={item.url} name={currentApp.name} params={selections.current.get(key(item))!} visible={active} />
        : <EmbeddedFrame app={currentApp} params={selections.current.get(key(item))!} visible={active} />}
    </div>;
  })}</>;
}
