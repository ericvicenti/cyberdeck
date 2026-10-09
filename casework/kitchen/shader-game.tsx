import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Pressable, Text, View } from 'react-native';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useRuntime } from '@remote/runtime';
import { advanceDrift, createDrift, hazardsAt, steer } from './drift-model';

const fragment = `precision highp float;
uniform vec2 resolution, player, velocity, target, hazardA, hazardB;
uniform float time, flash, danger;
float ring(vec2 p, float r, float width) { return 1.0 - smoothstep(width, width + 0.007, abs(length(p)-r)); }
void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - resolution) / resolution.y;
  vec2 q = uv - player;
  float d = length(q);
  vec2 warped = uv + 0.025 * sin(d * 18.0 - time * 3.0) * q / (d + 0.1);
  float flow = sin(warped.x * 5.0 + sin(warped.y * 4.0 + time * 0.35) + time * 0.3);
  float contours = pow(0.5 + 0.5 * sin(flow * 9.0 + warped.y * 7.0), 14.0);
  vec3 color = vec3(0.014, 0.025, 0.065) + vec3(0.025, 0.09, 0.14) * contours;
  color += vec3(0.03, 0.12, 0.16) * exp(-d * 2.0);
  vec2 grid = abs(fract(warped * 4.0 + 0.5) - 0.5);
  color += vec3(0.07, 0.18, 0.24) * (1.0 - smoothstep(0.008, 0.022, min(grid.x, grid.y))) * 0.28;
  vec2 t = uv - target;
  float pulse = 0.084 + 0.009 * sin(time * 3.0);
  color += vec3(0.22, 1.0, 0.68) * (ring(t, pulse, 0.008) + 0.012 / (length(t) + 0.025));
  color += vec3(0.52, 1.0, 0.84) * ring(t, pulse + 0.035, 0.001) * 0.3;
  for (int i=0; i<2; i++) {
    vec2 h = uv - (i == 0 ? hazardA : hazardB);
    float a = atan(h.y, h.x);
    float r = 0.078 + sin(a * 5.0 + time * 2.0) * 0.013;
    color += vec3(1.0, 0.16, 0.32) * (ring(h, r, 0.009) + 0.012 / (length(h) + 0.045));
  }
  for (int i=1; i<7; i++) {
    float f = float(i);
    vec2 trail = q + velocity * f * 0.04;
    color += vec3(0.16, 0.46, 0.95) * (1.0 - smoothstep(0.0, 0.045 - f * 0.004, length(trail))) * (1.0-f/8.0);
  }
  color += mix(vec3(0.46, 0.8, 1.0), vec3(1.0, 0.3, 0.4), danger) * (0.018 / (d + 0.025));
  color += vec3(0.85, 0.97, 1.0) * (1.0 - smoothstep(0.026, 0.041, d));
  color += vec3(0.18, 0.8, 0.58) * ring(q, (1.0-flash) * 0.8, 0.008) * flash;
  color *= 0.88 + 0.12 * cos(uv.y * 0.8);
  gl_FragColor = vec4(color, 1.0);
}`;

export default function ShaderGame() {
  const { emit, bridge } = useRuntime();
  const state = useRef(createDrift());
  const input = useRef({ x: 0, y: 0 });
  const frames = useRef(0), frame = useRef(0), aspect = useRef(1);
  const active = useRef(AppState.currentState === 'active');
  const paused = useRef(false), mounted = useRef(true);
  const dispose = useRef<(() => void) | undefined>(undefined);
  const events = useRef(emit); events.current = emit;
  const [hud, setHud] = useState({ score: 0, hits: 0 });
  const [error, setError] = useState('');
  const [isPaused, setPaused] = useState(false);
  const thumb = useRef(new Animated.ValueXY()).current;
  const setInput = useCallback((dx: number, dy: number) => { input.current = steer(dx / 62, -dy / 62); }, []);
  const release = useCallback(() => { input.current = { x: 0, y: 0 }; }, []);
  const reset = useCallback(() => { state.current = createDrift(); release(); Animated.spring(thumb, { toValue: { x: 0, y: 0 }, useNativeDriver: true, speed: 24, bounciness: 6 }).start(); setHud({ score: 0, hits: 0 }); }, [release, thumb]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', next => { active.current = next === 'active'; if (!active.current) { release(); thumb.setValue({ x: 0, y: 0 }); } });
    return () => { mounted.current = false; release(); cancelAnimationFrame(frame.current); dispose.current?.(); subscription.remove(); };
  }, [release, thumb]);
  useEffect(() => bridge.register('shaderGame.status', () => ({ ...state.current, input: input.current, frames: frames.current, paused: paused.current, aspect: aspect.current, renderer: 'expo-gl', revision: 'lumen-drift-1' })), [bridge]);
  useEffect(() => bridge.register('shaderGame.input', ({ x: dx = 0, y: dy = 0 }) => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Input must be finite numbers');
    input.current = steer(dx, dy); return input.current;
  }), [bridge]);
  useEffect(() => bridge.register('shaderGame.reset', () => { reset(); return { reset: true }; }), [bridge, reset]);
  const gesture = Gesture.Pan().runOnJS(true).minDistance(0).onBegin(() => { thumb.stopAnimation(); release(); }).onUpdate(e => {
    const length = Math.max(62, Math.hypot(e.translationX, e.translationY));
    const dx = e.translationX / length * 62, dy = e.translationY / length * 62;
    thumb.setValue({ x: dx, y: dy }); setInput(dx, dy);
  }).onFinalize(() => { Animated.spring(thumb, { toValue: { x: 0, y: 0 }, useNativeDriver: true, speed: 24, bounciness: 6 }).start(); release(); });
  const puck = { transform: thumb.getTranslateTransform() };
  function start(gl: ExpoWebGLRenderingContext) {
    if (!mounted.current) return;
    cancelAnimationFrame(frame.current); dispose.current?.();
    const shaders: WebGLShader[] = []; let program: WebGLProgram | null = null; let buffer: WebGLBuffer | null = null;
    const cleanup = () => { if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program); shaders.forEach(s => gl.deleteShader(s)); };
    dispose.current = cleanup;
    try {
      const compile = (kind: number, source: string) => {
        const shader = gl.createShader(kind); if (!shader) throw new Error('GPU shader allocation failed'); shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed'); return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}');
      const pixel = compile(gl.FRAGMENT_SHADER, fragment);
      program = gl.createProgram(); if (!program) throw new Error('GPU program allocation failed');
      gl.attachShader(program, vertex); gl.attachShader(program, pixel); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader link failed');
      gl.useProgram(program); buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const uniforms = Object.fromEntries(['resolution','player','velocity','target','hazardA','hazardB','time','flash','danger'].map(name => [name, gl.getUniformLocation(program!, name)]));
      let last = 0;
      const draw = (now: number) => {
        if (!mounted.current) return;
        const dt = last ? (now - last) / 1000 : 0; last = now;
        if (active.current && !paused.current) {
          aspect.current = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight);
          const event = advanceDrift(state.current, input.current, dt, aspect.current);
          const s = state.current, hazards = hazardsAt(s.time);
          if (event) { setHud({ score: s.score, hits: s.hits }); events.current(`shaderGame.${event}`, { score: s.score, hits: s.hits }); }
          gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
          gl.clearColor(0.014, 0.025, 0.065, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(program);
          gl.uniform2f(uniforms.resolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
          for (const [name, point] of [['player', s.player], ['velocity', s.velocity], ['target', s.target], ['hazardA', hazards[0]], ['hazardB', hazards[1]]] as const) gl.uniform2f(uniforms[name], point.x, point.y);
          gl.uniform1f(uniforms.time, s.time); gl.uniform1f(uniforms.flash, s.flash); gl.uniform1f(uniforms.danger, s.cooldown > 0 ? 0.6 + 0.4 * Math.sin(s.time * 20) : 0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.flush(); gl.endFrameEXP(); frames.current += 1;
        }
        frame.current = requestAnimationFrame(draw);
      };
      setError(''); events.current('shaderGame.ready', { revision: 'lumen-drift-1', renderer: 'expo-gl' }); frame.current = requestAnimationFrame(draw);
    } catch (e) { cleanup(); dispose.current = undefined; setError(String(e)); events.current('shaderGame.error', { error: String(e) }); }
  }
  return <View style={{ gap: 16 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <View><Text style={{ color: '#87e9cf', fontSize: 11, letterSpacing: 3 }}>LUMEN DRIFT</Text><Text style={{ color: '#ecf4ff', fontSize: 26, fontWeight: '600', marginTop: 5 }}>Find a path through the current.</Text></View>
      <Text accessibilityLabel={`Collected ${hud.score}, contacts ${hud.hits}`} style={{ color: '#9cedd7', fontSize: 17, fontVariant: ['tabular-nums'] }}>{hud.score.toString().padStart(2, '0')} collected  ·  {hud.hits} contacts</Text>
    </View>
    <Text style={{ color: '#a5b8cb', lineHeight: 22 }}>Steer the white light into mint rings. Avoid the coral eddies. Hold the joystick to glide; release to brake.</Text>
    <View collapsable={false} style={{ height: 340 }}><GLView msaaSamples={0} style={{ height: 340, width: '100%' }} onContextCreate={start} />
      {(error || isPaused) ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: '#050d22bb', alignItems: 'center', justifyContent: 'center', padding: 24 }}><Text style={{ color: error ? '#ff99ab' : '#e6f4ff' }}>{error || 'Paused'}</Text></View> : null}
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 18 }}>
      <GestureDetector gesture={gesture}><View accessible accessibilityLabel="Flight joystick" accessibilityHint="Drag and hold to steer; release to brake" style={{ width: 190, height: 190, borderRadius: 95, backgroundColor: '#0b1525', borderWidth: 1, borderColor: '#29465b', alignItems: 'center', justifyContent: 'center' }}>
        <View pointerEvents="none" style={{ position: 'absolute', width: 150, height: 1, backgroundColor: '#244055' }} /><View pointerEvents="none" style={{ position: 'absolute', height: 150, width: 1, backgroundColor: '#244055' }} />
        <View pointerEvents="none" style={{ position: 'absolute', width: 124, height: 124, borderRadius: 62, borderWidth: 1, borderColor: '#29465b' }} />
        <Animated.View pointerEvents="none" style={[{ width: 52, height: 52, borderRadius: 26, backgroundColor: '#9bdfed', borderWidth: 6, borderColor: '#d9f7ff66', shadowColor: '#79dfff', shadowOpacity: 0.5, shadowRadius: 18 }, puck]} />
      </View></GestureDetector>
      <View style={{ gap: 12, flex: 1, minWidth: 180, paddingLeft: 8 }}><Text style={{ color: '#8ca4bd', lineHeight: 22 }}>Your movement bends the field and leaves a blue wake. Every ring finds a new orbit.</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>{[['Restart', reset], [isPaused ? 'Resume' : 'Pause', () => { paused.current = !paused.current; setPaused(paused.current); release(); }]].map(([label, action]) => <Pressable key={label as string} accessibilityRole="button" onPress={action as () => void} style={{ paddingHorizontal: 20, paddingVertical: 13, borderRadius: 12, backgroundColor: '#22394d' }}><Text style={{ color: '#dcf3ff', fontWeight: '600' }}>{label as string}</Text></Pressable>)}</View>
      </View>
    </View>
  </View>;
}
