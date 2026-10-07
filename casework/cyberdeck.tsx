// Cyberdeck experience for the Casework Desk app. Compiled by src/daemon/api/casework.ts
// (Bun.build, CommonJS, native modules external) and served at /api/modules/cyberdeck.
// Only modules from the app's native registry may be imported here.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
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
  const [tab, setTab] = useState<'fleet' | 'agents' | 'sessions' | 'run'>('fleet');
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
  const tabs: [typeof tab, string][] = [['fleet', 'Fleet'], ['agents', 'Agents'], ['sessions', 'Sessions'], ['run', 'Run']];
  return <View style={{ gap: 14, backgroundColor: C.bg }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Led on={status === 'connected'} /><Text style={{ color: C.text, fontWeight: '700', letterSpacing: 3 }}>CYBERDECK</Text>
      <Text style={{ color: C.dim, fontSize: 12 }}>{status}</Text>
      <View style={{ flex: 1 }} />
      <Button label={busy ? 'syncing' : 'refresh'} onPress={() => void refresh()} disabled={busy} />
    </View>
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{tabs.map(([key, label]) => <Pressable key={key} onPress={() => setTab(key)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: tab === key ? '#102a33' : 'transparent', borderWidth: 1, borderColor: tab === key ? C.cyan : C.line }}><Text style={{ color: tab === key ? C.cyan : C.dim, fontSize: 12, letterSpacing: 1, fontWeight: '700' }}>{label.toUpperCase()}</Text></Pressable>)}</View>
    {error ? <Text style={{ color: C.red }}>{error}</Text> : null}
    {tab === 'fleet' ? <FleetTab nodes={nodes} overview={overview} servicesDown={servicesDown} tasks={tasks} /> : null}
    {tab === 'agents' ? <AgentsTab tasks={tasks} runs={runs} json={json} refresh={refresh} /> : null}
    {tab === 'sessions' ? <SessionsTab json={json} /> : null}
    {tab === 'run' ? <RunTab json={json} /> : null}
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
