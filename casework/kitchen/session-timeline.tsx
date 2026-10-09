import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { displayJSON, sessionRows } from './session-rows';

export default function SessionTimeline({ events, running, openSession }: { events: any[]; running: boolean; openSession: (id: string) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return <View style={{ gap: 12 }}>{sessionRows(events).map(row => {
    const e = row.event;
    if (row.kind === 'message') return <View key={row.id} style={{ gap: 6, padding: 16, borderRadius: 12, backgroundColor: e.role === 'user' ? '#392d4b' : '#251e32' }}>
      <Text style={{ color: '#bcb0ce', fontSize: 12 }}>{e.role === 'user' ? 'YOU' : 'AGENT'} · {new Date(row.createdAt).toLocaleTimeString()}</Text>
      <Text selectable style={{ color: '#f3effa', fontSize: 17, lineHeight: 26 }}>{typeof e.content === 'string' ? e.content : displayJSON(e.content)}</Text>
    </View>;
    if (row.kind === 'error') return <Text key={row.id} accessibilityRole="alert" selectable style={{ color: '#ff8585' }}>{e.message || displayJSON(e)}</Text>;
    const status = row.result ? row.result.error ? 'Failed' : 'Completed' : running ? 'Running' : 'No result recorded';
    const color = row.result?.error ? '#ff8585' : !row.result ? '#ffb36b' : '#bda4e8';
    const toolName = row.call.input?.tool || row.call.name;
    const label = row.call.input?.description || row.call.input?.title || (row.call.input?.address ? `${toolName} · ${row.call.input.address}` : toolName);
    const isOpen = !!expanded[row.id];
    return <View key={row.id} style={{ borderWidth: 1, borderColor: '#50405f', borderRadius: 12, padding: 12, gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label} · ${status}`} accessibilityState={{ expanded: isOpen }} onPress={() => setExpanded(value => ({ ...value, [row.id]: !value[row.id] }))} style={{ paddingVertical: 8, gap: 5 }}>
        <Text style={{ color, fontWeight: '600' }}>{isOpen ? '▾' : '▸'} {label} · {status}</Text>
        <Text style={{ color: '#bcb0ce', fontSize: 12 }}>{toolName} · {new Date(row.createdAt).toLocaleTimeString()}{row.completedAt ? ` · ${Math.max(0, row.completedAt - row.createdAt) / 1000}s` : ''}</Text>
      </Pressable>
      {isOpen && <>
        <Text style={{ color: '#bcb0ce' }}>Input</Text><Text selectable style={{ color: '#f3effa', fontFamily: 'Menlo', fontSize: 12 }}>{displayJSON(row.call.input) || 'Input outside loaded history'}</Text>
        {row.result && <><Text style={{ color }}>Result</Text><Text selectable style={{ color: '#f3effa', fontFamily: 'Menlo', fontSize: 12 }}>{displayJSON(row.result.error || row.result.output)}</Text></>}
        {row.child && <Text style={{ color: '#bcb0ce' }}>Child run · {row.child.title || row.child.runId}</Text>}
      </>}
      {row.child?.sessionId && <Pressable accessibilityRole="button" onPress={() => openSession(row.child.sessionId)} style={{ padding: 10 }}><Text style={{ color: '#bda4e8' }}>Open child conversation</Text></Pressable>}
    </View>;
  })}</View>;
}
