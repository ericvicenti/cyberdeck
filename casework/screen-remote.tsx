// Uses the WebView already shipped in Casework; no native update required.
import React, { useState } from 'react';
import { Modal, View, Text, Pressable } from 'react-native';
import { WebView } from 'react-native-webview';
import { useRuntime } from '@remote/runtime';
export default function ScreenRemote() {
  const { connection, revision } = useRuntime();
  const [open, setOpen] = useState(true);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const origin = connection.pairing.url.replace(/\/$/, '');
  const bootstrap = `if(location.origin === ${JSON.stringify(origin)}) localStorage.setItem('cyberdeck-token', ${JSON.stringify(connection.pairing.token)}); true;`;
  const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" onPress={action} style={{ padding: 14 }}><Text style={{ color: '#22d3ee', fontSize: 16 }}>{label}</Text></Pressable>;
  return <View>{button('Control enuc', () => setOpen(true))}<Modal visible={open} presentationStyle="fullScreen" supportedOrientations={['portrait', 'landscape-left', 'landscape-right']} onRequestClose={() => setOpen(false)}>
    <View style={{ flex: 1, backgroundColor: '#09090b', paddingTop: 30, paddingBottom: 20 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>{button('Casework', () => setOpen(false))}{button('Reconnect', () => { setFailed(false); setRetry(n => n + 1); })}</View>
      {failed ? <Text style={{ color: '#fff', padding: 24 }}>Cannot reach enuc. Check its connection, then tap Reconnect.</Text> : <WebView key={`${revision}-${retry}`} source={{ uri: `${origin}/#/remote` }} style={{ flex: 1, backgroundColor: '#09090b' }} injectedJavaScriptBeforeContentLoaded={bootstrap} onMessage={() => {}} onError={() => setFailed(true)} originWhitelist={[origin]} onShouldStartLoadWithRequest={r => r.url === 'about:blank' || r.url.startsWith(origin + '/')} />}
    </View>
  </Modal></View>;
}
