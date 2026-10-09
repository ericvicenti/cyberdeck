// Cyberdeck experience for the Casework Desk app. Compiled by src/daemon/api/casework.ts
// (Bun.build, CommonJS, native modules external) and served at /api/modules/cyberdeck.
// Only modules from the app's native registry may be imported here.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { useRuntime } from '@remote/runtime';

const C = { bg: '#07080c', panel: '#0b0d14', line: '#1b2230', text: '#d7dde6', dim: '#7c8798', cyan: '#22d3ee', magenta: '#e879f9', green: '#a3e635', amber: '#fbbf24', red: '#f87171' };
const panel = { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 16, gap: 10 };
const mono = { fontFamily: 'Menlo', fontSize: 13, color: C.text } as const;

type Node = { id: string; name: string; online: boolean; status?: { repos?: number; atRisk?: number; commit?: string } | null };
type Overview = { status?: { host?: string; hosts?: { name: string; kind: string; online: boolean | null; roles?: string[]; steward?: any }[]; handoffOpen?: number }; collab?: { tasks?: Task[]; runs?: Run[] }; services?: { probedAt: string; rows: { host: string; service: string; ok: boolean | null; state: string }[] } | null };
type Task = { id: string; title: string; project: string; host: string; worker: string; reviewer: string; status: string };
type Run = { id: string; title: string; host: string; status: string; step: string; verdict: string | null; startedAt: string };
type Session = { host: string; tool: string; id: string; title: string; cwd: string; updated: string };

function Label({ children, color = C.cyan }: { children: string; color?: string }) {
  return <Text style={{ color, fontSize: 11, letterSpacing: 2, fontWeight: '700' }}>{children.toUpperCase()}</Text>;
}
function Led({ on, warn = false }: { on: boolean | null; warn?: boolean }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: on === true ? (warn ? C.amber : C.green) : on === false ? C.red : C.dim }} />;
}
function Button({ label, onPress, color = C.cyan, disabled = false }: { label: string; onPress: () => void; color?: string; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: color, opacity: disabled ? 0.4 : 1 }}><Text style={{ color, fontWeight: '700', fontSize: 12, letterSpacing: 1 }}>{label.toUpperCase()}</Text></Pressable>;
}
function Stat({ label, value, color = C.text }: { label: string; value: string | number; color?: string }) {
  return <View style={{ minWidth: 90 }}><Text style={{ color, fontSize: 26, fontWeight: '700', fontFamily: 'Menlo' }}>{String(value)}</Text><Text style={{ color: C.dim, fontSize: 11, letterSpacing: 1 }}>{label.toUpperCase()}</Text></View>;
}
const ago = (iso?: string) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? `${s | 0}s` : s < 5400 ? `${(s / 60) | 0}m` : s < 172800 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`; };

export default function Cyberdeck() {
  const { connection, status } = useRuntime();
  const [tab, setTab] = useState<'deck' | 'apps' | 'talk' | 'fleet' | 'agents' | 'sessions' | 'run'>('deck');
  // The web deck's current route, kept here so the inline and the full-screen WebView open on the same page.
  const [route, setRoute] = useState('#/');
  const [nodes, setNodes] = useState<Node[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const json = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => { if (!connection) throw new Error('Not connected'); const r = await connection.request(path, init); return r.json(); }, [connection]);
  const refresh = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [n, o] = await Promise.all([json<{ nodes: Node[]; self: { name: string } }>('/api/fleet/nodes'), json<Overview>('/api/control/overview')]);
      setNodes([{ id: '', name: n.self.name, online: true }, ...n.nodes]); setOverview(o);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [json]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30000); return () => clearInterval(t); }, [refresh]);

  const tasks = overview?.collab?.tasks ?? [], runs = overview?.collab?.runs ?? [];
  const servicesDown = overview?.services?.rows.filter((r) => r.ok === false).length ?? 0;
  const tabs: [typeof tab, string][] = [['deck', 'Deck'], ['apps', 'Apps'], ['talk', 'Talk'], ['fleet', 'Fleet'], ['agents', 'Agents'], ['sessions', 'Sessions'], ['run', 'Run']];
  return <View style={{ gap: 14, backgroundColor: C.bg }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Led on={status === 'connected'} /><Text style={{ color: C.text, fontWeight: '700', letterSpacing: 3 }}>CYBERDECK</Text>
      <Text style={{ color: C.dim, fontSize: 12 }}>{status}</Text>
      <View style={{ flex: 1 }} />
      <Button label={busy ? 'syncing' : 'refresh'} onPress={() => void refresh()} disabled={busy} />
    </View>
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{tabs.map(([key, label]) => <Pressable key={key} onPress={() => setTab(key)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: tab === key ? '#102a33' : 'transparent', borderWidth: 1, borderColor: tab === key ? C.cyan : C.line }}><Text style={{ color: tab === key ? C.cyan : C.dim, fontSize: 12, letterSpacing: 1, fontWeight: '700' }}>{label.toUpperCase()}</Text></Pressable>)}</View>
    {error ? <Text style={{ color: C.red }}>{error}</Text> : null}
    {tab === 'deck' ? <DeckTab route={route} setRoute={setRoute} /> : null}
    {tab === 'apps' ? <AppsTab json={json} openWeb={(next) => { setRoute(next); setTab('deck'); }} /> : null}
    {tab === 'talk' ? <TalkTab json={json} /> : null}
    {tab === 'fleet' ? <FleetTab nodes={nodes} overview={overview} servicesDown={servicesDown} tasks={tasks} /> : null}
    {tab === 'agents' ? <AgentsTab tasks={tasks} runs={runs} json={json} refresh={refresh} /> : null}
    {tab === 'sessions' ? <SessionsTab json={json} /> : null}
    {tab === 'run' ? <RunTab json={json} /> : null}
  </View>;
}

// ---- Deck: the entire Cyberdeck web UI (every view the browser has) in the app's native WebView.
// No credential is handed to the page: a device on the tailnet as the owner is trusted by the daemon as it
// is in Safari, and anything else gets the web UI's own token prompt. The page talks back through
// window.ReactNativeWebView.postMessage({ cyberdeck: 'scene', name }) to open a native example app.
function DeckTab({ route, setRoute }: { route: string; setRoute: (r: string) => void }) {
  const { connection, run } = useRuntime();
  const { height } = useWindowDimensions();
  const [full, setFull] = useState(false);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState('');
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const origin = (connection?.pairing.url ?? '').replace(/\/$/, '');
  // Where the page was last, without re-rendering (and so reloading) the WebView on every navigation.
  const last = useRef(route);
  useEffect(() => {
    if (!origin) return;
    let alive = true;
    // Asked without the pairing key on purpose: this is what the page itself will be allowed.
    fetch(`${origin}/api/auth/whoami`).then((r) => r.json()).then((w) => { if (alive) setTrusted(w?.method === 'tailscale' || w?.method === 'token'); }).catch(() => { if (alive) setTrusted(null); });
    return () => { alive = false; };
  }, [origin, retry]);
  if (!origin) return <ActivityIndicator color={C.cyan} />;
  const reload = () => { setFailed(''); setRoute(last.current); setRetry((n) => n + 1); };
  const toggle = (next: boolean) => { setRoute(last.current); setFull(next); };
  const onMessage = (event: { nativeEvent: { data: string } }) => {
    try { const m = JSON.parse(event.nativeEvent.data); if (m?.cyberdeck === 'scene' && typeof m.name === 'string') { setFull(false); void run({ name: 'scene', args: { name: m.name } }).catch(() => {}); } } catch { /* not ours */ }
  };
  const view = failed
    ? <View style={{ flex: 1, padding: 24, gap: 12 }}><Text style={{ color: C.text }}>Cannot load Cyberdeck from {origin}.</Text><Text style={{ color: C.dim }}>{failed}</Text><Button label="reload" onPress={reload} /></View>
    : <WebView key={`${retry}-${full ? 'full' : 'inline'}`} source={{ uri: `${origin}/${route}` }} style={{ flex: 1, backgroundColor: C.bg }} originWhitelist={['*']} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction={false} allowsBackForwardNavigationGestures onMessage={onMessage}
        onNavigationStateChange={(nav: { url?: string }) => { const at = nav.url?.startsWith(origin + '/') ? nav.url.slice(origin.length + 1) : ''; if (at.startsWith('#')) last.current = at; }}
        onError={(e: { nativeEvent: { description?: string } }) => setFailed(e.nativeEvent.description ?? 'load error')}
        onShouldStartLoadWithRequest={(r: { url: string }) => { if (r.url === 'about:blank' || r.url.startsWith(origin + '/') || r.url === origin) return true; void Linking.openURL(r.url).catch(() => {}); return false; }} />;
  const bar = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
    <Led on={failed ? false : trusted} /><Text style={{ color: C.dim, fontSize: 12, flex: 1 }} numberOfLines={1}>{trusted === false ? 'not trusted on the tailnet: paste the node token on the page, or sign this device into Tailscale as the owner' : origin}</Text>
    <Button label="reload" color={C.dim} onPress={reload} /><Button label={full ? 'exit full screen' : 'full screen'} onPress={() => toggle(!full)} />
  </View>;
  return <View style={{ gap: 10 }}>
    {full ? <Text style={{ color: C.dim }}>Cyberdeck is open full screen.</Text> : <>{bar}<View style={{ height: Math.max(480, height - 190), borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: C.line }}>{view}</View></>}
    <Modal visible={full} presentationStyle="fullScreen" animationType="fade" supportedOrientations={['portrait', 'landscape-left', 'landscape-right']} onRequestClose={() => toggle(false)}>
      <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: 28, paddingHorizontal: 10, paddingBottom: 14, gap: 8 }}>{bar}{full ? view : null}</View>
    </Modal>
  </View>;
}

// ---- Apps: what Applications shows in the browser. Example apps are native scenes served by this node
// (the Casework kitchen sink); web applications open inside the Deck tab.
type CaseworkApp = { id: string; name: string; description: string };
type WebApp = { id: string; name: string; description: string; url: string };
function AppsTab({ json, openWeb }: { json: <T,>(p: string, i?: RequestInit) => Promise<T>; openWeb: (route: string) => void }) {
  const { run } = useRuntime();
  const [apps, setApps] = useState<{ applications: WebApp[]; casework?: { apps: CaseworkApp[] } } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { json<{ applications: WebApp[]; casework?: { apps: CaseworkApp[] } }>('/api/applications').then(setApps).catch((e) => setError(String(e))); }, [json]);
  const card = (key: string, name: string, description: string, action: string, color: string, onPress: () => void) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={`Open ${name}`} onPress={onPress} style={{ ...panel, flexGrow: 1, flexBasis: 280, borderColor: color }}>
    <Text style={{ color: C.text, fontSize: 20, fontWeight: '700' }}>{name}</Text><Text style={{ color: C.dim, lineHeight: 20 }}>{description}</Text><Text style={{ color, fontWeight: '600' }}>{action} →</Text>
  </Pressable>;
  return <View style={{ gap: 12 }}>
    {error ? <Text style={{ color: C.red }}>{error}</Text> : null}
    {!apps && !error ? <ActivityIndicator color={C.cyan} /> : null}
    <Label color={C.green}>Example apps · native on this device</Label>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{(apps?.casework?.apps ?? []).map((a) => card(a.id, a.name, a.description, 'Open here', C.green, () => { void run({ name: 'scene', args: { name: a.id } }).catch((e) => setError(String(e))); }))}</View>
    <Label>Applications · in the deck</Label>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      {card('applications', 'All applications', 'The Applications page of the web deck, with every app configured on this node.', 'Open in Deck', C.cyan, () => openWeb('#/applications'))}
      {(apps?.applications ?? []).map((a) => card(a.id, a.name, a.description, 'Open in Deck', C.cyan, () => openWeb(`#/applications?app=${encodeURIComponent(a.id)}`)))}
    </View>
  </View>;
}

// ---- Talk: the same big button as the web Desk, driving the app's native call.
// The app owns the LiveKit room (voice.start / call.stop / call.mute); it mirrors the
// worker's `lk.agent.state` into call.agentState and emits `voice.transcript` per segment
// (text + speaker identity: the local speaker is the identity the daemon minted, the
// agent is everyone else). The app also sends "Hi" on lk.chat on join, so the agent greets.
type TalkLine = { id: number; who: 'me' | 'agent'; text: string };
type VoiceConfig = { configured: boolean; provider?: string; reason?: string; agentId?: string; sessionId?: string };
type VoiceStatus = { configured: boolean; reason?: string; agent?: { id: string; name?: string }; sessionId?: string; health?: unknown };
const healthOk = (h: unknown): boolean | null => h == null ? null : typeof h === 'boolean' ? h : typeof h === 'string' ? /^(ok|up|healthy|ready)$/i.test(h) : typeof h === 'object' ? (typeof (h as any).ok === 'boolean' ? (h as any).ok : typeof (h as any).status === 'string' ? /^(ok|up|healthy|ready)$/i.test((h as any).status) : (h as any).error ? false : null) : null;

function TalkTab({ json }: { json: <T,>(p: string, i?: RequestInit) => Promise<T> }) {
  const { call, log, run, status, voiceConfigured } = useRuntime();
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [vstatus, setVstatus] = useState<VoiceStatus | null>(null);
  const [lines, setLines] = useState<TalkLine[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const toggling = useRef(false);
  const seen = useRef<object | undefined>(undefined);
  const nextId = useRef(1);
  const active = ['connected', 'connecting', 'reconnecting'].includes(call.status);
  const connecting = call.status === 'connecting' || call.status === 'reconnecting';

  const refresh = useCallback(async () => {
    try { setConfig(await json<VoiceConfig>('/api/voice/config')); } catch (e) { setConfig({ configured: false, reason: String(e) }); }
    try { setVstatus(await json<VoiceStatus>('/api/voice/status')); } catch { setVstatus(null); }
  }, [json]);
  useEffect(() => { void refresh(); }, [refresh, voiceConfigured]);

  // Each voice.transcript event carries the latest text for one segment of one speaker.
  // Interim segments grow in place: when the newest line for that speaker is a prefix of the
  // new text (or vice versa) replace it, otherwise start a new line.
  useEffect(() => {
    const event = log.find((item) => item.name === 'voice.transcript');
    if (!event || seen.current === event) return;
    seen.current = event;
    const text = typeof event.data?.text === 'string' ? event.data.text.trim() : '';
    if (!text) return;
    const speaker = typeof event.data?.speaker === 'string' ? event.data.speaker : '';
    // The agents server mints the local speaker as user-<accountId>; the worker is anyone else.
    const who: TalkLine['who'] = !speaker || speaker.startsWith('user-') ? 'me' : 'agent';
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.who === who && (text.startsWith(last.text) || last.text.startsWith(text))) return [...prev.slice(0, -1), { ...last, text }];
      return [...prev, { id: nextId.current++, who, text }].slice(-120);
    });
  }, [log]);

  async function toggle() {
    if (toggling.current) return;
    toggling.current = true; setBusy(true); setError('');
    try { await run({ name: active ? 'call.stop' : 'voice.start' }); }
    catch (cause) { setError(String(cause)); }
    finally { toggling.current = false; setBusy(false); }
  }
  async function resetSession() {
    if (active) await run({ name: 'call.stop' }).catch(() => {});
    setNote('…');
    try { const r = await json<{ sessionId?: string }>('/api/voice/session/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setLines([]); setNote(r.sessionId ? `new session ${r.sessionId.slice(0, 8)}` : 'new session'); }
    catch (e) { setNote(String(e)); }
    await refresh();
  }

  const agentState = call.agentState?.toLowerCase();
  const phase = call.error || error ? 'error' : !active ? 'idle' : connecting ? 'connecting' : call.muted ? 'muted' : agentState === 'speaking' ? 'speaking' : agentState === 'thinking' ? 'thinking' : 'listening';
  const color = { idle: C.dim, connecting: C.amber, muted: C.amber, listening: C.green, thinking: C.magenta, speaking: C.cyan, error: C.red }[phase];
  const label = { idle: 'tap to talk', connecting: 'connecting', muted: 'muted', listening: 'listening', thinking: 'thinking', speaking: 'speaking', error: call.error || error }[phase];
  const configured = config?.configured === true;
  const agentName = vstatus?.agent?.name ?? vstatus?.agent?.id ?? config?.agentId;
  const sessionId = vstatus?.sessionId ?? config?.sessionId;
  const health = healthOk(vstatus?.health);
  const size = phase === 'speaking' ? 150 : phase === 'thinking' ? 120 : phase === 'listening' ? 132 : 126;

  return <View style={{ gap: 12 }}>
    {config && !configured ? <View style={{ ...panel, borderColor: C.magenta }}>
      <Label color={C.magenta}>Voice not configured</Label>
      <Text style={{ color: C.text }}>{config.reason ?? 'This node has no Seed agents bridge yet.'}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label="run setup" color={C.magenta} onPress={() => { setNote('running setup…'); void json<{ message?: string; error?: string }>('/api/voice/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => setNote(r.message ?? r.error ?? 'setup complete')).catch((e) => setNote(String(e))).then(refresh); }} />
        <Button label="recheck" color={C.dim} onPress={() => void refresh()} />
      </View>
      {note ? <Text style={{ color: C.dim, fontSize: 12 }}>{note}</Text> : null}
    </View> : null}

    <View style={{ ...panel, alignItems: 'center', paddingVertical: 28, gap: 16 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={active ? 'End call' : 'Start call'} disabled={busy || (!active && (status !== 'connected' || !configured))} onPress={() => void toggle()}
        style={{ width: 200, height: 200, borderRadius: 100, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0e1119', borderWidth: active ? 3 : 2, borderColor: color, opacity: busy || (!active && (status !== 'connected' || !configured)) ? 0.45 : 1, shadowColor: color, shadowOpacity: active ? 0.55 : 0, shadowRadius: phase === 'speaking' ? 34 : 20 }}>
        <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: color, opacity: active ? 0.5 : 0.15, position: 'absolute' }} />
        <Text style={{ color, fontSize: 26, fontWeight: '700', letterSpacing: 6, fontFamily: 'Menlo' }}>{active ? 'END' : 'TALK'}</Text>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Led on={phase === 'error' ? false : active ? true : null} warn={phase === 'connecting' || phase === 'muted'} /><Text style={{ color, fontSize: 12, letterSpacing: 2, fontWeight: '700' }}>{String(label).toUpperCase()}</Text></View>
      {active ? <Button label={call.muted ? 'unmute' : 'mute'} color={call.muted ? C.amber : C.cyan} onPress={() => void run({ name: 'call.mute', args: { muted: !call.muted } }).catch((cause) => setError(String(cause)))} /> : null}
    </View>

    <View style={panel}>
      <Label>Bridge</Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Led on={health} /><Text style={{ color: C.dim, fontSize: 12 }}>agents {health == null ? '?' : health ? 'up' : 'down'}</Text></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Led on={agentName ? true : null} /><Text style={{ color: C.dim, fontSize: 12 }}>agent {agentName ?? '—'}</Text></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Led on={sessionId ? true : null} /><Text style={{ color: C.dim, fontSize: 12, fontFamily: 'Menlo' }}>session {sessionId ? sessionId.slice(0, 8) : '—'}</Text></View>
        {configured ? <Button label="new session" color={C.dim} onPress={() => void resetSession()} /> : null}
      </View>
      {configured && note ? <Text style={{ color: C.dim, fontSize: 12 }}>{note}</Text> : null}
    </View>

    <View style={panel}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}><Label color={C.magenta}>Transcript</Label><View style={{ flex: 1 }} />{lines.length ? <Button label="clear" color={C.dim} onPress={() => setLines([])} /> : null}</View>
      {lines.length ? lines.map((l) => <View key={l.id} style={{ alignSelf: l.who === 'me' ? 'flex-end' : 'flex-start', maxWidth: '88%', borderWidth: 1, borderColor: l.who === 'me' ? '#164e63' : '#4a1d5e', backgroundColor: l.who === 'me' ? '#0b1a21' : '#180b21', borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10 }}><Text style={{ color: l.who === 'me' ? C.cyan : C.magenta, fontSize: 10, letterSpacing: 1 }}>{l.who === 'me' ? 'ME' : (agentName ?? 'AGENT').toUpperCase()}</Text><Text style={{ color: C.text }}>{l.text}</Text></View>) : <Text style={{ color: C.dim }}>{configured ? 'Nothing said yet. Tap TALK and speak.' : 'The conversation shows up here once voice is set up.'}</Text>}
    </View>
  </View>;
}

function FleetTab({ nodes, overview, servicesDown, tasks }: { nodes: Node[]; overview: Overview | null; servicesDown: number; tasks: Task[] }) {
  const hosts = overview?.status?.hosts ?? [];
  return <View style={{ gap: 12 }}>
    <View style={{ ...panel, flexDirection: 'row', flexWrap: 'wrap', gap: 18 }}>
      <Stat label="nodes online" value={`${nodes.filter((n) => n.online).length}/${nodes.length}`} color={C.cyan} />
      <Stat label="services down" value={servicesDown} color={servicesDown ? C.red : C.green} />
      <Stat label="open tasks" value={tasks.filter((t) => t.status === 'open' || t.status === 'running').length} color={C.magenta} />
      <Stat label="handoff" value={overview?.status?.handoffOpen ?? '—'} />
    </View>
    <View style={panel}><Label>Cyberdeck nodes</Label>{nodes.map((n) => <View key={n.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Led on={n.online} /><Text style={{ color: C.text, fontWeight: '600', width: 110 }}>{n.name}</Text><Text style={{ color: C.dim, fontSize: 12 }}>{n.online ? `${n.status?.repos ?? '?'} repos · ${n.status?.atRisk ?? '?'} at risk` : 'offline'}</Text></View>)}</View>
    {hosts.length ? <View style={panel}><Label color={C.magenta}>Fleet manifest</Label>{hosts.map((h) => <View key={h.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Led on={h.online} /><Text style={{ color: C.text, width: 110 }}>{h.name}</Text><Text style={{ color: C.dim, fontSize: 12 }}>{h.kind} · {(h.roles ?? []).join(', ')}</Text></View>)}</View> : null}
    {overview?.services ? <View style={panel}><Label color={servicesDown ? C.red : C.green}>Services ({ago(overview.services.probedAt)} ago)</Label>{overview.services.rows.filter((r) => r.ok !== true).map((r) => <View key={`${r.host}/${r.service}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Led on={r.ok} /><Text style={{ color: C.text }}>{r.host} · {r.service}</Text><Text style={{ color: C.dim, fontSize: 12 }}>{r.state}</Text></View>)}{overview.services.rows.every((r) => r.ok === true) ? <Text style={{ color: C.green }}>all services active</Text> : null}</View> : null}
  </View>;
}

function AgentsTab({ tasks, runs, json, refresh }: { tasks: Task[]; runs: Run[]; json: <T,>(p: string, i?: RequestInit) => Promise<T>; refresh: () => Promise<void> }) {
  const [msg, setMsg] = useState('');
  const act = async (path: string, body?: unknown) => { setMsg('…'); try { await json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }); setMsg('started'); setTimeout(() => void refresh(), 1500); } catch (e) { setMsg(String(e)); } };
  const color = (s: string) => s === 'running' ? C.cyan : s === 'review' ? C.amber : s === 'blocked' || s === 'failed' ? C.red : s === 'done' ? C.green : C.text;
  return <View style={{ gap: 12 }}>
    <View style={panel}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Label>Collaboration</Label><View style={{ flex: 1 }} /><Button label="run next task" onPress={() => void act('/api/control/collab/tick')} color={C.green} /></View>
      {msg ? <Text style={{ color: C.dim, fontSize: 12 }}>{msg}</Text> : null}
      {tasks.length ? tasks.map((t) => <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 }}><Text style={{ color: color(t.status), fontSize: 11, width: 64, fontWeight: '700' }}>{t.status.toUpperCase()}</Text><Text style={{ color: C.dim, width: 48, fontFamily: 'Menlo', fontSize: 12 }}>{t.id}</Text><View style={{ flex: 1 }}><Text style={{ color: C.text }}>{t.title}</Text><Text style={{ color: C.dim, fontSize: 11 }}>{t.project} · {t.host} · {t.worker}→{t.reviewer}</Text></View>{t.status === 'open' ? <Button label="run" onPress={() => void act('/api/control/collab/run', { id: t.id })} /> : null}</View>) : <Text style={{ color: C.dim }}>no tasks</Text>}
    </View>
    <View style={panel}><Label color={C.magenta}>Runs</Label>{runs.slice(0, 12).map((r) => <View key={r.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Led on={r.status === 'running' ? null : r.status === 'done'} warn={r.verdict === 'changes'} /><View style={{ flex: 1 }}><Text style={{ color: C.text }}>{r.title}</Text><Text style={{ color: C.dim, fontSize: 11 }}>{r.host} · {r.status} · {r.step}{r.verdict ? ` · ${r.verdict}` : ''} · {ago(r.startedAt)} ago</Text></View></View>)}{!runs.length ? <Text style={{ color: C.dim }}>no runs yet</Text> : null}</View>
  </View>;
}

function SessionsTab({ json }: { json: <T,>(p: string, i?: RequestInit) => Promise<T> }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<Session[]>([]); const [busy, setBusy] = useState(false);
  const search = useCallback(async (query: string) => { setBusy(true); try { setRows((await json<Session[]>(`/api/control/sessions?q=${encodeURIComponent(query)}`)).slice(0, 40)); } catch { setRows([]); } finally { setBusy(false); } }, [json]);
  useEffect(() => { void search(''); }, [search]);
  return <View style={panel}>
    <Label>Sessions (cc + cx, every host)</Label>
    <View style={{ flexDirection: 'row', gap: 8 }}><TextInput value={q} onChangeText={setQ} onSubmitEditing={() => void search(q)} placeholder="search" placeholderTextColor={C.dim} autoCapitalize="none" style={{ flex: 1, ...mono, backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10 }} /><Button label="search" onPress={() => void search(q)} /></View>
    {busy ? <ActivityIndicator color={C.cyan} /> : null}
    {rows.map((s) => <View key={`${s.host}-${s.id}`} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8, gap: 2 }}><Text style={{ color: C.text }} numberOfLines={2}>{s.title}</Text><Text style={{ color: C.dim, fontSize: 11, fontFamily: 'Menlo' }}>{s.host} · {s.tool} · {ago(s.updated)} ago · {s.cwd.replace(/^\/Users\/[^/]+/, '~')}</Text></View>)}
  </View>;
}

function RunTab({ json }: { json: <T,>(p: string, i?: RequestInit) => Promise<T> }) {
  const [cwd, setCwd] = useState('~'); const [cmd, setCmd] = useState('deck status'); const [out, setOut] = useState(''); const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setOut(''); try { const r = await json<{ code: number; output: string }>('/api/casework/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, cmd }) }); setOut(`${r.output}\n[exit ${r.code}]`); } catch (e) { setOut(String(e)); } finally { setBusy(false); } };
  return <View style={panel}>
    <Label color={C.green}>Run a command on this node</Label>
    <TextInput value={cwd} onChangeText={setCwd} placeholder="working directory" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false} style={{ ...mono, backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10 }} />
    <TextInput value={cmd} onChangeText={setCmd} placeholder="command (non-interactive, 60 s limit)" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => void run()} style={{ ...mono, backgroundColor: C.bg, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10 }} />
    <View style={{ flexDirection: 'row', gap: 8 }}><Button label={busy ? 'running' : 'run'} onPress={() => void run()} disabled={busy} color={C.green} />{['deck status', 'deck todo', 'deck services', 'cyberdeck status'].map((c) => <Button key={c} label={c} onPress={() => setCmd(c)} color={C.dim} />)}</View>
    <ScrollView horizontal style={{ maxHeight: 420 }}><Text selectable style={{ ...mono, fontSize: 12 }}>{out || '—'}</Text></ScrollView>
  </View>;
}
