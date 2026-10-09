import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, TextInput, Image, Switch } from 'react-native';
import { WebView } from 'react-native-webview';
import { useRuntime, Camera, Video, Voice, CallView, Orb } from '@remote/runtime';

import ShaderGame from './kitchen/shader-game';
import SeedCompanion from './kitchen/seed-companion';

const tabs = ['Agent', 'Overview', 'Camera + QR', 'Audio + calls', 'Video', 'Graphics', 'Device', 'Files + OS', 'Web + forms'];
const ink = '#edf3f6', muted = '#9cabbc', lime = '#b6f36a';
const sampleText = 'Hello from Cyberdeck. This entire experience arrived from the server.';
const panel = { padding: 24, borderRadius: 24, borderWidth: 1, borderColor: '#2a3949', backgroundColor: '#151f2a', gap: 16 } as const;
function Caption({ children }: { children: React.ReactNode }) { return <Text style={{ color: muted, fontSize: 15, lineHeight: 23 }}>{children}</Text>; }
function Title({ children }: { children: React.ReactNode }) { return <Text style={{ color: ink, fontSize: 26, fontWeight: '600' }}>{children}</Text>; }

// The Casework Desk kitchen sink (from ~/Code/remote-control/experiences), served by Cyberdeck as the example
// app under Applications. This whole gallery is downloaded TSX, not a screen compiled into the app; its pieces
// live in casework/kitchen/ and the web side is ui/views/CaseworkConsole.tsx.
export default function KitchenSink() {
  const { run, emit, connection, bridge, log, scene } = useRuntime();
  const [tab, setTab] = useState('Overview');
  useEffect(() => { emit('screen.context', { sceneTitle: scene?.title, section: tab }); }, [emit, scene?.title, tab]);
  const [result, setResult] = useState('Choose an action. Its actual result appears here and in Cyberdeck.');
  const [busy, setBusy] = useState('');
  const [lastOK, setLastOK] = useState<boolean>();
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [scan, setScan] = useState(true);
  const [zoom, setZoom] = useState(0);
  const [torch, setTorch] = useState(false);
  const [photo, setPhoto] = useState('');
  const [clip, setClip] = useState('');
  const [audio, setAudio] = useState('');
  const [text, setText] = useState(sampleText);
  const [enabled, setEnabled] = useState(false);
  const [proof, setProof] = useState<string[]>([]);
  const origin = connection?.pairing.url || '';
  useEffect(() => bridge.register('demo.tab', ({ name }) => {
    if (!tabs.includes(name)) throw new Error('Unknown gallery tab');
    setTab(name); return { tab: name };
  }), [bridge]);
  useEffect(() => bridge.register('demo.camera', ({ mode: nextMode, facing: nextFacing }) => {
    if (nextMode !== undefined && !['picture', 'video'].includes(nextMode)) throw new Error('mode must be picture or video');
    if (nextFacing !== undefined && !['front', 'back'].includes(nextFacing)) throw new Error('facing must be front or back');
    if (nextMode) setMode(nextMode);
    if (nextFacing) setFacing(nextFacing);
    setTab('Camera + QR');
    return { requested: true };
  }), [bridge]);
  useEffect(() => {
    const recording = log.find(event => event.name === 'camera.recorded');
    if (recording?.data?.uri) setClip(recording.data.uri);
    const capture = log.find(event => event.name === 'camera.capture');
    if (capture?.data?.uri) setPhoto(capture.data.uri);
    const audioRecording = log.find(event => event.name === 'audio.stopRecording');
    if (audioRecording?.data?.uri) setAudio(audioRecording.data.uri);
  }, [log]);
  async function act(label: string, task: () => Promise<any>) {
    setBusy(label); setLastOK(undefined);
    try { const value = await task(); setResult(JSON.stringify(value ?? { ok: true }, null, 2)); setLastOK(true); emit('demo.result', { action: label, ok: true }); }
    catch (error) { setResult(String(error)); setLastOK(false); emit('demo.result', { action: label, ok: false, error: String(error) }); }
    finally { setBusy(''); }
  }
  const command = (name: string, args?: Record<string, unknown>) => run({ name, args });
  function Button({ label, action, args, task, disabled = false }: { label: string; action?: string; args?: Record<string, unknown>; task?: () => Promise<any>; disabled?: boolean }) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={Boolean(busy) || disabled} onPress={() => void act(label, task || (() => command(action!, args)))} style={{ opacity: busy || disabled ? 0.45 : 1, backgroundColor: '#233342', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#354958' }}><Text style={{ color: lime, fontSize: 15, fontWeight: '600' }}>{label}</Text></Pressable>;
  }
  const row = (children: React.ReactNode) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{children}</View>;
  async function probe() {
    const passed: string[] = [];
    setProof([]);
    const check = (name: string) => { passed.push(name); setProof([...passed]); };
    const info = await command('device.info'); check('Native device + battery');
    const nonce = `remote-${Date.now()}`;
    await command('storage.set', { key: 'demo-proof', value: nonce });
    if (await command('storage.get', { key: 'demo-proof' }) !== JSON.stringify(nonce)) throw new Error('Storage round trip failed');
    check('Persistent storage round trip');
    const file = await command('files.write', { name: 'remote-demo-proof.txt', text: nonce }) as { uri: string };
    if (await command('files.read', { name: 'remote-demo-proof.txt' }) !== nonce) throw new Error('File round trip failed');
    check('Native filesystem round trip');
    const uploaded = await command('files.upload', { uri: file.uri, name: 'proof.txt' }); check('File uploaded to Cyberdeck');
    return { checks: passed, device: info, uploaded };
  }
  return <View style={{ gap: 22 }}>
    <Pressable accessibilityRole="button" onPress={() => { void run({ name: 'scene', args: { name: 'cyberdeck' } }).catch(() => {}); }}><Text style={{ color: '#a4bdce' }}>← Cyberdeck</Text></Pressable>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{tabs.map(name => <Pressable key={name} accessibilityRole="tab" accessibilityState={{ selected: tab === name }} onPress={() => setTab(name)} style={{ backgroundColor: tab === name ? lime : '#192735', borderRadius: 30, paddingHorizontal: 18, paddingVertical: 13 }}><Text style={{ color: tab === name ? '#172215' : '#b1c1d2', fontWeight: '600' }}>{name}</Text></Pressable>)}</View>
    {tab === 'Agent' && <SeedCompanion />}
    {tab === 'Overview' && <View style={panel}><Text style={{ color: lime, letterSpacing: 3, fontSize: 11 }}>ONE APP. MANY POSSIBILITIES.</Text><Title>Your iPad is the instrument.</Title><Caption>This gallery, its controls, and its logic are served by your Cyberdeck node. Try an experience, then change its code on the server while the app stays installed.</Caption><Orb height={210} />
      {row(<><Button label="Run live proof" task={probe} /><Button label="Make the iPad speak" action="speech.say" args={{ text: sampleText }} /></>)}
      {proof.map(name => <Text key={name} style={{ color: lime }}>✓ {name}</Text>)}
      <Caption>Camera + QR · microphone · recording · native video · WebRTC calls · Skia · GL · gestures · motion · location · files · sharing · notifications · clipboard · storage · web content.</Caption>
      <Caption>Capabilities follow the hardware and iOS permissions. This iPad has no haptic motor. AI voice connects to a Seed agent through this node; Apple push, Bluetooth/NFC, AR and background call continuity need further native integration.</Caption>
    </View>}
    {tab === 'Camera + QR' && <View style={panel}><Title>See. Scan. Capture.</Title><Caption>Point at the QR in Cyberdeck → Applications → Kitchen sink. Scan results arrive in both places. Photos and videos stay local until you tap Upload.</Caption>
      {row(<><Button label={facing === 'back' ? 'Use front camera' : 'Use back camera'} task={async () => setFacing(facing === 'back' ? 'front' : 'back')} /><Button label={mode === 'picture' ? 'Switch to video' : 'Switch to photo'} task={async () => setMode(mode === 'picture' ? 'video' : 'picture')} /><Button label={scan ? 'QR scanning on' : 'QR scanning off'} task={async () => setScan(!scan)} /><Button label={torch ? 'Torch off' : 'Torch on'} task={async () => setTorch(!torch)} /><Button label={zoom ? 'Reset zoom' : 'Zoom in'} task={async () => setZoom(zoom ? 0 : 0.15)} /></>)}
      <Camera height={360} facing={facing} mode={mode} scan={scan && mode === 'picture'} zoom={zoom} torch={torch} />
      {row(mode === 'picture' ? <><Button label="Capture photo" task={async () => { const p = await command('camera.capture') as { uri: string }; setPhoto(p.uri); return p; }} /><Button label="Upload photo to Cyberdeck" disabled={!photo} action="files.upload" args={{ uri: photo, name: 'ipad-photo.jpg' }} /><Button label="Share photo" disabled={!photo} action="share.file" args={{ uri: photo }} /></> : <><Button label="Record video (max 30s)" action="camera.record" /><Button label="Stop video" task={async () => { const p = await command('camera.stopRecording') as { uri: string }; setClip(p.uri); return p; }} /><Button label="Upload video to Cyberdeck" disabled={!clip} action="files.upload" args={{ uri: clip, name: 'ipad-video.mov' }} /></>)}
      {clip && mode === 'video' && <Video url={clip} height={240} />}
      {photo && mode === 'picture' && <Image source={{ uri: photo }} style={{ height: 140, width: 180, borderRadius: 12 }} />}
    </View>}
    {tab === 'Audio + calls' && <View style={panel}><Title>A voice, in both directions.</Title><Caption>Record your microphone, replay it, or call the Cyberdeck console. AI conversations connect to your Seed agent through this node.</Caption>
      {row(<><Button label="Speak the message" action="speech.say" args={{ text }} /><Button label="Stop speaking" action="speech.stop" /><Button label="Play Cyberdeck audio stream" action="audio.play" args={{ url: `${origin}/samples/chime.wav` }} /><Button label="Record microphone" action="audio.record" /><Button label="Stop recording" task={async () => { const r = await command('audio.stopRecording') as { uri: string }; if (r?.uri) setAudio(r.uri); return r; }} /><Button label="Replay recording" disabled={!audio} action="audio.play" args={{ url: audio }} /><Button label="Upload recording" disabled={!audio} action="files.upload" args={{ uri: audio, name: 'ipad-audio.m4a' }} /><Button label="Stop audio" action="audio.stop" /></>)}
      <TextInput accessibilityLabel="Speech message" value={text} onChangeText={setText} multiline style={{ backgroundColor: '#0d1721', padding: 16, borderRadius: 12, color: ink }} />
      {row(<><Button label="Audio call to Cyberdeck" action="call.start" /><Button label="Video call to Cyberdeck" action="call.start" args={{ video: true }} /><Button label="End call" action="call.stop" /><Button label="Read call status" action="call.status" /></>)}<CallView /><Voice />
    </View>}
    {tab === 'Video' && <View style={panel}><Title>Native streaming video.</Title><Caption>This test video and its audio are streamed from the Cyberdeck node. Use the player controls for fullscreen and picture-in-picture. The server can substitute MP4 or HLS sources.</Caption><Video url={`${origin}/samples/motion.mp4`} height={380} />{row(<><Button label="Play video" action="video.play" /><Button label="Pause video" action="video.pause" /><Button label="Seek to 3 seconds" action="video.seek" args={{ seconds: 3 }} /><Button label="Read playback status" action="video.status" /></>)}<Caption>These buttons use the same native actions Cyberdeck can send remotely. Camera clips can be replayed directly on the Camera tab.</Caption></View>}
    {tab === 'Graphics' && <View style={panel}><ShaderGame /></View>}
    {tab === 'Device' && <View style={panel}><Title>A bridge to the hardware.</Title><Caption>Location and motion request their respective iOS permissions. Brightness affects this screen; Default orientation restores normal rotation.</Caption>
      {row(<><Button label="Read device + battery" action="device.info" /><Button label="Read location" action="location.get" /><Button label="Stream motion" action="sensors.start" /><Button label="Stop motion" action="sensors.stop" /><Button label="Brightness 40%" action="brightness.set" args={{ value: 0.4 }} /><Button label="Brightness 80%" action="brightness.set" args={{ value: 0.8 }} /><Button label="Portrait" action="orientation.set" args={{ orientation: 'PORTRAIT_UP' }} /><Button label="Default orientation" action="orientation.set" args={{ orientation: 'DEFAULT' }} /></>)}
      <Caption>Live motion appears in the Cyberdeck console. Sensor streaming stops when this app goes into the background.</Caption>
    </View>}
    {tab === 'Files + OS' && <View style={panel}><Title>Useful beyond the canvas.</Title><Caption>Create a file, read it back, send it to Cyberdeck, or open the native pickers and share sheet. Clipboard writes happen only when you tap the control.</Caption>
      {row(<><Button label="File + storage proof" task={probe} /><Button label="Choose a document" action="files.pick" /><Button label="Choose photo or video" action="photos.pick" /><Button label="Copy demo message" action="clipboard.write" args={{ text: sampleText }} /><Button label="Read clipboard" action="clipboard.read" /><Button label="Share message" action="share.text" args={{ text: sampleText }} /><Button label="Local notification" action="notification.show" args={{ title: 'Remote', body: 'A native notification requested by your Cyberdeck-defined experience.' }} /></>)}
    </View>}
    {tab === 'Web + forms' && <View style={panel}><Title>Mix native and web.</Title><Caption>A native text field and switch alongside embedded HTML. Both can report events to your server.</Caption><TextInput accessibilityLabel="Server form message" value={text} onChangeText={setText} style={{ backgroundColor: '#0d1721', padding: 16, borderRadius: 12, color: ink }} /><Switch accessibilityLabel="Demo option" value={enabled} onValueChange={value => { setEnabled(value); emit('form.toggle', { value }); }} /><Button label="Submit form to Cyberdeck" task={async () => { emit('form.submit', { text, enabled }); return { text, enabled }; }} /><WebView style={{ height: 240, backgroundColor: '#102730', borderRadius: 12 }} source={{ html: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#102730;color:#b6f36a;font:22px system-ui;padding:25px"><h2>Hello from HTML.</h2><button style="padding:16px;font-size:18px" onclick="window.ReactNativeWebView.postMessage(JSON.stringify({event: &quot;web.tap&quot;,at:Date.now()}))">Send a web event ↗</button></body></html>' }} onMessage={event => { emit('web.message', event.nativeEvent.data); setResult(event.nativeEvent.data); }} /></View>}
    <View style={{ ...panel, backgroundColor: '#0d1721' }}><Text style={{ color: lastOK === false ? '#ffa0a0' : lime, fontSize: 11, letterSpacing: 2 }}>{busy ? `RUNNING · ${busy}` : lastOK === true ? 'COMPLETED ON YOUR DEVICE' : lastOK === false ? 'ACTION NEEDS ATTENTION' : 'LIVE RESULT'}</Text><Text selectable style={{ color: '#a8bdce', fontFamily: 'Menlo', fontSize: 12, lineHeight: 19 }}>{result.slice(0, 2600)}</Text></View>
  </View>;
}
