import { useRef, type ReactNode } from "react";

/** Mount on first visit, then hide without disposing browser-owned sessions.
 * Hidden views receive their last own params, never another view's selection. */
export function RetainedView({ visible, params, children }: {
  visible: boolean;
  params: URLSearchParams;
  children: (params: URLSearchParams, visible: boolean) => ReactNode;
}) {
  const last = useRef<URLSearchParams | null>(null);
  if (visible) last.current = params;
  return last.current && <div className={visible ? "h-full" : "hidden"} inert={!visible} aria-hidden={!visible}>
    {children(last.current, visible)}
  </div>;
}
