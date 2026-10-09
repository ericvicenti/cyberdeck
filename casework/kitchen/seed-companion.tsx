import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRuntime } from '@remote/runtime';
import { useAgentWorkspace } from './agent-data';
import SessionTimeline from './session-timeline';

const ink = '#f3effa', muted = '#bcb0ce', rose = '#bda4e8';
const field = { padding: 15, color: ink, borderRadius: 12, backgroundColor: '#181320', fontSize: 16 };
function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) { return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ padding: 13, borderRadius: 12, backgroundColor: '#392d4b', opacity: disabled ? 0.5 : 1 }}><Text style={{ color: rose, fontWeight: '600' }}>{label}</Text></Pressable>; }

/** A Seed client for conversations, plans, runs, tools, memory, automation and model selection. */
export default function SeedCompanion() {
  const { connection, emit, scene } = useRuntime();
  const { workspace, request, refresh, error: syncError } = useAgentWorkspace();
  const [tab, setTab] = useState('Conversation');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const acting = useRef(false);
  const [outbox, setOutbox] = useState<{ id: string; text: string; sessionId: string }>();
  const [sessions, setSessions] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<any>({});
  const [expanded, setExpanded] = useState('');
  const [older, setOlder] = useState<any[]>([]);
  const [historyStart, setHistoryStart] = useState(false);
  const [memoryPath, setMemoryPath] = useState('');
  const [memoryText, setMemoryText] = useState('');
  const [models, setModels] = useState<any[]>([]);
  const [provider, setProvider] = useState('OpenAI');
  const [toolInput, setToolInput] = useState('{}');
  const [toolOutput, setToolOutput] = useState('');
  const outboxKey = `casework.outbox:${connection?.pairing.url || ''}`;
  const session = workspace?.session;
  const agent = workspace?.agent;
  // Describe only the visible section and conversation, never drafts, tool inputs, or memory contents.
  useEffect(() => {
    const detail = tab === 'Conversation' ? session?.title || 'Conversation' : tab === 'Tools' && expanded ? expanded : undefined;
    emit('screen.context', { sceneTitle: scene?.title, section: tab, detail: detail?.slice(0, 120) });
  }, [emit, scene?.title, tab, session?.title, expanded]);
  useEffect(() => { void AsyncStorage.getItem(outboxKey).then(value => { if (value) setOutbox(JSON.parse(value)); }).catch(cause => setError(String(cause))); }, [outboxKey]);
  useEffect(() => { setOlder([]); setHistoryStart(false); }, [session?.id]);
  useEffect(() => {
    if (outbox && workspace?.events?.some((item: any) => item.event?.clientMessageId === outbox.id)) {
      void AsyncStorage.removeItem(outboxKey).then(() => setOutbox(undefined)).catch(cause => setError(String(cause)));
    }
  }, [outbox, outboxKey, workspace]);
  async function act(fn: () => Promise<unknown>) { if (acting.current) return; acting.current = true; setBusy(true); setError(''); try { await fn(); await refresh(); } catch (cause) { setError(String(cause)); } finally { acting.current = false; setBusy(false); } }
  async function send(retry = false) {
    if (sending.current || (!retry && !draft.trim()) || !session) return;
    sending.current = true; setBusy(true); setError('');
    const item = retry && outbox ? outbox : { id: `ipad:${Date.now()}:${Math.random().toString(36).slice(2)}`, text: draft.trim(), sessionId: session.id };
    try {
      await AsyncStorage.setItem(outboxKey, JSON.stringify(item)); setOutbox(item);
      const receipt = await request('message', { clientMessageId: item.id, text: item.text, sessionId: item.sessionId });
      if (receipt.status === 'failed') throw new Error(receipt.error || 'Message delivery failed');
      if (receipt.status === 'accepted') { await AsyncStorage.removeItem(outboxKey); setOutbox(undefined); }
      if (!retry) setDraft(''); await refresh();
    } catch (cause) { setError(`Delivery not confirmed. Retry uses the same message ID. ${String(cause)}`); }
    finally { sending.current = false; setBusy(false); }
  }
  async function selectTab(value: string) {
    setTab(value); setExpanded('');
    if (value === 'Sessions') setSessions((await request('sessions')).sessions || []);
    if (['Tools', 'Memory', 'Automation', 'Model'].includes(value)) setCatalog(await request('catalog'));
    if (value === 'Model') setModels((await request('action', { _: 'ListProviderModels', provider })).models || []);
  }
  const events = [...new Map([...older, ...(workspace?.events || [])].map((event: any) => [event.id, event])).values()].sort((a: any, b: any) => a.seq - b.seq) as any[];
  const messages = events.filter(event => event.event?.type === 'message' && ['user', 'assistant'].includes(event.event.role) && event.event.actor !== 'system');
  const rows = (children: React.ReactNode) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
  const action = (body: unknown) => request('action', body);
  return <View style={{ gap: 18, padding: 22, borderRadius: 22, backgroundColor: '#251e32' }}>
    <Text style={{ color: ink, fontSize: 26, fontWeight: '600' }}>{session?.title || 'Your Seed companion'}</Text>
    {rows(['Conversation', 'Activity', 'Sessions', 'Tools', 'Memory', 'Automation', 'Model'].map(name => <Button key={name} label={name === tab ? `${name} · selected` : name} onPress={() => void act(() => selectTab(name))} />))}
    {(error || syncError) ? <Text accessibilityRole="alert" style={{ color: '#ff8585' }}>{error || syncError}</Text> : null}
    {!!outbox && rows(<><Text style={{ color: '#ffb36b' }}>Unconfirmed message: {outbox.text.slice(0, 100)}</Text><Button label="Retry same message" disabled={busy} onPress={() => void send(true)} /></>)}
    {!!session?.plan?.steps?.length && <View style={{ gap: 6, padding: 16, backgroundColor: '#392d4b', borderRadius: 12 }}><Text style={{ color: rose, fontWeight: '600' }}>{session.plan.title || 'Current plan'}</Text>{session.plan.steps.map((step: any) => <Text key={step.id} style={{ color: step.status === 'running' ? '#ffb36b' : ink }}>{step.status === 'done' ? '✓' : step.status === 'running' ? '◉' : '○'} {step.label} · {step.status}</Text>)}</View>}
    {tab === 'Conversation' && <>
      {!historyStart && workspace?.hasMoreBefore && <Button label="Load earlier history" onPress={() => void act(async () => { const result = await action({ _: 'GetSession', sessionId: session.id, beforeSeq: events[0]?.seq, limit: 100 }); setOlder(value => [...result.events, ...value]); setHistoryStart(!result.hasMoreBefore); })} />}
      {session?.continuedFrom && <Button label={`Continued from ${session.continuedFrom.title || session.continuedFrom.sessionId} · Open earlier conversation`} onPress={() => void act(() => request('session/select', { sessionId: session.continuedFrom.sessionId }))} />}
      <SessionTimeline key={session?.id} events={events} running={session?.status === 'streaming'} openSession={id => void act(async () => { await request('session/select', { sessionId: id }); })} />
      {workspace?.partial?.text && session?.status === 'streaming' && !messages.some(event => event.event.content === workspace.partial.text) ? <Text selectable style={{ color: '#d1bff0', fontSize: 17, lineHeight: 26 }}>{workspace.partial.text} ▍</Text> : null}
      <TextInput accessibilityLabel="Message your agent" multiline value={draft} onChangeText={setDraft} placeholder="Ask, steer ongoing work, or request an app change…" placeholderTextColor={muted} style={[field, { minHeight: 90 }]} />
      <Button label="Send message" disabled={busy || !draft.trim() || !!outbox} onPress={() => void send()} />
      <Text style={{ color: muted }}>Messages are saved before work completes. Speech interruptions stop playback; use Stop agent above to cancel work.</Text>
    </>}
    {tab === 'Activity' && <>
      {(workspace?.runs || []).slice(0, 20).map((item: any) => <View key={item.id} style={{ gap: 7, padding: 14, borderRadius: 12, backgroundColor: '#2e2340' }}><Text style={{ color: ink }}>{item.parentRunId ? '↳ ' : ''}{item.title} · {item.status}</Text>{item.wait && <Text style={{ color: '#ffb36b' }}>{item.wait.label || item.wait.reason}</Text>}{item.error && <Text selectable style={{ color: '#ff8585' }}>{item.error.message}</Text>}{item.usage && <Text style={{ color: muted }}>{item.usage.total} tokens</Text>}{rows(<>{item.sessionId && <Button label="Open conversation" onPress={() => void act(async () => { await request('session/select', { sessionId: item.sessionId }); setTab('Conversation'); })} />}{['queued', 'claimed', 'running', 'waiting'].includes(item.status) && <Button label="Cancel this run" onPress={() => void act(() => action({ _: 'CancelRun', runId: item.id }))} />}</>)}</View>)}
      <Text style={{ color: rose, fontWeight: '600' }}>Tool activity and results</Text>
      {events.filter(event => ['tool_call', 'tool_result', 'tool_spawn', 'error'].includes(event.event.type)).slice(-35).map(event => <View key={event.id} style={{ gap: 6 }}><Button label={`${event.event.type} · ${event.event.name || event.event.message || 'event'}${event.event.error ? ' · FAILED' : ''}`} onPress={() => setExpanded(expanded === event.id ? '' : event.id)} />{expanded === event.id && <Text selectable style={{ color: ink, fontFamily: 'Menlo', fontSize: 12 }}>{JSON.stringify(event.event, null, 2)}</Text>}</View>)}
    </>}
    {tab === 'Sessions' && <><Button label="New conversation" onPress={() => void act(async () => { await request('sessions', {}); await selectTab('Sessions'); })} />{sessions.map(item => <Button key={item.id} label={`${item.parentSessionId ? '↳ ' : ''}${item.title || 'Conversation'} · ${item.status}${item.id === session?.id ? ' · active' : ''}`} onPress={() => void act(async () => { await request('session/select', { sessionId: item.id }); setTab('Conversation'); })} />)}</>}
    {tab === 'Tools' && <>{(catalog.tools || []).map((tool: any) => <View key={tool.name} style={{ gap: 7 }}><Button label={`${tool.name} · ${tool.enabled && tool.granted ? 'enabled' : 'disabled'}`} onPress={() => { setExpanded(expanded === tool.name ? '' : tool.name); setToolInput('{}'); setToolOutput(''); }} /><Text style={{ color: muted }}>{tool.summary}</Text>{expanded === tool.name && <><Text selectable style={{ color: ink }}>{tool.description}</Text><Text selectable style={{ color: muted, fontFamily: 'Menlo', fontSize: 12 }}>{JSON.stringify(tool.input, null, 2)}</Text><TextInput accessibilityLabel="Tool input JSON" multiline value={toolInput} onChangeText={setToolInput} style={field} /><Button label="Run this tool" onPress={() => void act(async () => setToolOutput(JSON.stringify(await action({ _: 'InvokeSessionTool', sessionId: session.id, verb: 'call', input: { tool: tool.name, input: JSON.parse(toolInput) } }), null, 2)))} /><Text selectable style={{ color: ink }}>{toolOutput}</Text></>}</View>)}</>}
    {tab === 'Memory' && <><Text style={{ color: muted }}>Agent memory is available to every conversation.</Text>{(catalog.memory || []).filter((entry: any) => entry.type === 'file').map((entry: any) => <Button key={entry.path} label={entry.path} onPress={() => void act(async () => { const result = await action({ _: 'ReadAgentMemoryFile', path: entry.path }); setMemoryPath(entry.path); setMemoryText(result.file?.content || ''); })} />)}<TextInput accessibilityLabel="Memory path" value={memoryPath} onChangeText={setMemoryPath} placeholder="notes.md" placeholderTextColor={muted} style={field} /><TextInput accessibilityLabel="Memory contents" multiline value={memoryText} onChangeText={setMemoryText} style={[field, { minHeight: 180 }]} /><Button label="Save memory file" disabled={!memoryPath} onPress={() => void act(async () => { await action({ _: 'WriteAgentMemoryFile', path: memoryPath, content: memoryText }); setCatalog(await request('catalog')); })} /></>}
    {tab === 'Automation' && <>{!(catalog.triggers || []).length && <Text style={{ color: muted }}>No automations yet. Ask the agent to create a schedule or activity trigger; it will appear here.</Text>}{(catalog.triggers || []).map((item: any) => <View key={item.id} style={{ gap: 8 }}><Text style={{ color: ink }}>{item.name} · {item.enabled ? 'enabled' : 'paused'}</Text><Text selectable style={{ color: muted }}>{JSON.stringify(item.source || item.schedule || item, null, 2)}</Text><Button label={item.enabled ? 'Pause automation' : 'Enable automation'} onPress={() => void act(async () => { await action({ _: 'UpdateAgentTrigger', triggerId: item.id, expectedUpdatedAt: item.updatedAt, patch: { enabled: !item.enabled } }); setCatalog(await request('catalog')); })} /></View>)}</>}
    {tab === 'Model' && <><Text style={{ color: ink }}>Current: {session?.modelOverride?.model || agent?.definition?.model}</Text>{rows((catalog.providers || []).map((item: any) => <Button key={item.name} label={item.name} onPress={() => void act(async () => { setProvider(item.name); setModels((await action({ _: 'ListProviderModels', provider: item.name })).models || []); })} />))}{models.map(model => <Button key={model.id} label={model.name || model.id} onPress={() => void act(() => action({ _: 'UpdateSession', sessionId: session.id, modelOverride: { provider, model: model.id, reasoningLevel: 'medium' } }))} />)}<Button label="Use agent default model" onPress={() => void act(() => action({ _: 'UpdateSession', sessionId: session.id, modelOverride: null }))} /><Text style={{ color: muted }}>Applies to the next run. Active work keeps its model.</Text></>}
  </View>;
}
