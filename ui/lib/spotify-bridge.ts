import { spotifyApi, spotifyConnected, connectSpotify, spotifyClientId } from './spotify';
import { token } from './api';

// Reuse the signed-in tab; never export Spotify credentials to a node or client.
// The existing authenticated Casework transport provides discovery and replies.
export function spotifyBridgeRequest(args: any): { path: string; method: string; body?: unknown } {
  const path = args?.path, method = args?.method || 'GET';
  if (typeof path !== 'string' || path.length > 2000 || !path.startsWith('/') || path.includes('\\')) throw new Error('Invalid Spotify request');
  const url = new URL(path, 'https://api.spotify.com');
  if (url.origin !== 'https://api.spotify.com' || url.hash || url.username || /%2f|%5c/i.test(path)) throw new Error('Invalid Spotify request');
  const read = /^\/(me(?:\/(?:playlists|tracks|albums|following|player(?:\/(?:devices|queue|recently-played))?))?|search|(?:albums|artists|playlists|tracks)\/[a-zA-Z0-9]+(?:\/(?:tracks|items|albums|top-tracks))?)$/;
  const write = method === 'PUT' && /^\/me\/player(?:\/(?:play|pause|seek|volume|shuffle|repeat))?$/.test(url.pathname)
    || method === 'POST' && /^\/me\/player\/(?:next|previous|queue)$/.test(url.pathname);
  if (!(method === 'GET' && read.test(url.pathname)) && !write) throw new Error('Spotify action is not supported');
  if (JSON.stringify(args.body ?? null).length > 20000) throw new Error('Spotify request is too large');
  return { path, method, body: args.body };
}

export function startSpotifyBridge() {
  let socket: WebSocket | undefined, active = 0;
  const connect = () => {
    if (!token() || !spotifyConnected()) { socket?.close(); socket = undefined; return; }
    if (socket && socket.readyState < WebSocket.CLOSING) return;
    const ws = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/control`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'device', token: token(), info: { name: 'Afterglow · Spotify', spotifyBridge: 1, actions: ['spotify.request'] } }));
    ws.onmessage = async event => {
      let message: any; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type !== 'command' || message.action?.name !== 'spotify.request') return;
      const reply = (ok: boolean, result: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, ok, result })); };
      if (active >= 4) { reply(false, { error: 'Spotify is busy. Try again.' }); return; }
      active++;
      try {
        const { path, method, body } = spotifyBridgeRequest(message.action.args);
        const data = await spotifyApi(path, method, body);
        reply(true, { data: data ?? {} });
      } catch (e) { reply(false, { error: e instanceof Error ? e.message : 'Spotify request failed' }); }
      finally { active--; }
    };
  };
  connect();
  const timer = setInterval(() => { connect(); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', at: Date.now() })); }, 5000);
  return () => { clearInterval(timer); socket?.close(); };
}
if (typeof window !== 'undefined' && !(window as any).__afterglowSpotifyBridge) {
  (window as any).__afterglowSpotifyBridge = true; startSpotifyBridge();
  // Explicit native Connect button reuses this app's existing PKCE callback.
  if (new URLSearchParams(location.search).get('afterglowSpotify') === 'connect') {
    history.replaceState(null, '', location.pathname + '#/spotify');
    if (!spotifyConnected()) void connectSpotify(spotifyClientId()).catch(error => {
      const show = () => { const banner = document.createElement('p'); banner.setAttribute('role', 'alert'); banner.textContent = String(error.message || error); document.body.prepend(banner); };
      if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, {once:true});
    });
  }
}
