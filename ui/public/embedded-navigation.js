/** Opt-in SPA adapter. Bundle this module with the child app; trust explicit parent origins. */
export function createEmbeddedNavigation({ parentOrigins, onNavigate, getTitle = () => document.title }) {
  const origins = new Set(parentOrigins.filter(value => {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) && url.origin === value; } catch { return false; }
  }));
  const clean = value => {
    if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
    try { const url = new URL(value, location.origin); return url.origin === location.origin ? url.pathname + url.search + url.hash : null; } catch { return null; }
  };
  const embedded = parent !== window;
  const route = () => location.pathname + location.search + location.hash;
  let connection = null, generation = 0, controller, disposed = false, restoration = null;
  const send = (type, extra = {}) => {
    if (connection && !disposed) parent.postMessage({ type, version: 1, channel: connection.channel, request: connection.request, route: route(), title: getTitle(), ...extra }, connection.origin);
  };
  async function apply(value, mode, fromParent) {
    const next = clean(value);
    if (next === null || disposed) return false;
    controller?.abort(); controller = new AbortController();
    const own = ++generation, signal = controller.signal;
    try {
      // Rendering must never start playback, a command or another action from a URL.
      const canonical = await onNavigate(next, { signal });
      if (disposed || signal.aborted || own !== generation) return false;
      const result = canonical === undefined ? next : clean(canonical);
      if (result === null) throw new Error('Invalid canonical embedded route');
      if (route() !== result) history[embedded || mode === 'replace' ? 'replaceState' : 'pushState'](history.state, '', result);
      send(fromParent ? 'embedded:ack' : 'embedded:navigation', { mode });
      return true;
    } catch (error) {
      if (!signal.aborted) throw error;
      return false;
    }
  }
  const receive = event => {
    const data = event.data;
    if (!embedded || disposed || event.source !== parent || !origins.has(event.origin) || data?.type !== 'cyberdeck:connect' || data.version !== 1 || typeof data.channel !== 'string' || data.channel.length > 128 || !Number.isSafeInteger(data.request) || data.request <= 0) return;
    if (data.route !== null && clean(data.route) === null) return;
    if (connection?.channel === data.channel && data.request <= connection.request) return;
    connection = { origin: event.origin, channel: data.channel, request: data.request };
    const task = apply(data.route ?? route(), 'replace', true).catch(() => false);
    restoration = task;
    void task.finally(() => { if (restoration === task) restoration = null; });
  };
  const restore = () => { if (!connection) void apply(route(), 'replace', false).catch(() => {}); };
  window.addEventListener('popstate', restore);
  window.addEventListener('message', receive);
  if (embedded) for (const origin of origins) parent.postMessage({ type: 'embedded:ready', version: 1 }, origin);
  return {
    navigate: async (value, { replace = false } = {}) => {
      // A click during restoration follows its acknowledgement instead of racing it.
      while (restoration) await restoration;
      return apply(value, replace ? 'replace' : 'push', false);
    },
    // Pass the route that owns an async title, so late results cannot rename another view.
    title: (ownerRoute = route()) => { if (clean(ownerRoute) === route()) send('embedded:title'); },
    route,
    dispose: () => { disposed = true; ++generation; controller?.abort(); window.removeEventListener('message', receive); window.removeEventListener('popstate', restore); connection = null; },
  };
}
