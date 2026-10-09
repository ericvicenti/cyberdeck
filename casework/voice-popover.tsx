import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useRuntime } from '@remote/runtime';

const ink = '#f3effa';
const violet = '#bda4e8';
const panel = '#292139';

/** Mounted above the scene so changing screens never tears down the call controls. */
export default function VoicePopover() {
  const { call, log, run, status, voiceConfigured } = useRuntime();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const active = ['connected', 'connecting', 'reconnecting'].includes(call.status);
  const transcript = log.find(item => item.name === 'voice.transcript' && typeof item.data?.speaker === 'string' && item.data.speaker.startsWith('user-'))?.data?.text;
  const phase = call.agentState?.toLowerCase();
  const label = call.status === 'reconnecting' ? 'Reconnecting' : call.status === 'connecting' ? 'Connecting' : call.muted ? 'Muted' : phase === 'speaking' ? 'Speaking' : phase === 'thinking' ? 'Thinking' : active ? 'Listening' : 'Voice';
  const color = error || call.error ? '#ff8585' : active ? violet : '#9888ad';
  useEffect(() => { if (call.error) setOpen(true); }, [call.error]);
  async function action(name: string, args?: Record<string, unknown>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await run({ name, args }); }
    catch (cause) { setError(String(cause)); setOpen(true); }
    finally { pending.current = false; setBusy(false); }
  }
  return <View style={{ position: 'relative' }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Voice controls, ${label}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 22, borderWidth: 1, borderColor: active ? violet : '#554660', backgroundColor: '#30263f' }}>
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
      <Text style={{ color: ink, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <Text style={{ color: violet, fontSize: 14 }}>{open ? '⌃' : '⌄'}</Text>
    </Pressable>
    {open && <View style={{ position: 'absolute', right: 0, top: 46, width: Math.min(350, width - 44), padding: 18, borderRadius: 18, borderWidth: 1, borderColor: '#615073', backgroundColor: panel, gap: 13, elevation: 14, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 15, shadowOffset: { width: 0, height: 8 } }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={{ color: ink, fontSize: 17, fontWeight: '600' }}>Voice · {label}</Text><Pressable accessibilityRole="button" accessibilityLabel="Close voice controls" onPress={() => setOpen(false)}><Text style={{ color: violet, fontSize: 15 }}>Close</Text></Pressable></View>
      {active && <Text accessibilityLabel="Recent speech" numberOfLines={3} style={{ color: '#cbbdd9', fontSize: 14 }}>{transcript || 'Your words appear here as you speak.'}</Text>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={active ? 'End call' : 'Start voice call'} disabled={busy || (!active && (status !== 'connected' || !voiceConfigured))} onPress={() => void action(active ? 'call.stop' : 'voice.start')} style={{ paddingHorizontal: 17, paddingVertical: 11, borderRadius: 22, backgroundColor: active ? '#493858' : violet, opacity: busy || (!active && (status !== 'connected' || !voiceConfigured)) ? 0.5 : 1 }}><Text style={{ color: active ? ink : '#21162f', fontWeight: '600' }}>{active ? 'End call' : 'Start call'}</Text></Pressable>
        {active && <Pressable accessibilityRole="button" accessibilityLabel={call.muted ? 'Unmute microphone' : 'Mute microphone'} disabled={busy} onPress={() => void action('call.mute', { muted: !call.muted })} style={{ paddingHorizontal: 17, paddingVertical: 11, borderRadius: 22, backgroundColor: '#493858' }}><Text style={{ color: ink }}>{call.muted ? 'Unmute' : 'Mute'}</Text></Pressable>}
      </View>
      {!voiceConfigured && <Text style={{ color: '#ffb36b' }}>Voice is not configured on this server.</Text>}
      {(error || call.error) && <Text accessibilityRole="alert" style={{ color: '#ff8585' }}>{error || call.error}</Text>}
    </View>}
  </View>;
}
