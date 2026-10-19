import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

type Spectrum = {
  available: boolean;
  source: "local-output-monitor";
  at: number;
  rms: number;
  peak: number;
  bands: number[];
  reason?: string;
};
const quiet = new Float32Array(16);
const clamp = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;

const vertex = `attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
const fragment = `precision highp float;
uniform vec2 resolution;
uniform float clock;
uniform float rms;
uniform float peak;
uniform float bands[16];
#define PI 3.14159265359
mat2 rot(float a) { float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
float bandAt(float index) {
  float value = 0.0;
  for (int j=0; j<16; j++) { if (index >= float(j) && index < float(j+1)) value = bands[j]; }
  return value;
}
float field(vec3 p) {
  p.xz *= rot(-0.25 + clock*0.11);
  p.xy *= rot(0.3);
  float a = atan(p.z,p.x);
  float b = (a + PI) * (8.0 / PI);
  float energy = bandAt(clamp(floor(b), 0.0, 15.0));
  float wave = sin(a*24.0 + clock*0.8) * (0.012 + energy*0.085);
  float torus = length(vec2(length(p.xz)-1.08-wave, p.y)) - (0.085 + energy*0.14 + rms*0.05);
  vec3 q = p;
  q.xy *= rot(0.83);
  q.yz *= rot(-0.42);
  float ring = length(vec2(length(q.xz)-0.76, q.y)) - (0.025 + bands[5]*0.11);
  vec3 r = p;
  r.yz *= rot(1.12);
  r.xz *= rot(-0.42);
  float ring2 = length(vec2(length(r.xz)-1.31, r.y)) - (0.018 + bands[11]*0.095);
  return min(torus,min(ring,ring2));
}
vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.003,0.0);
  return normalize(vec3(field(p+e.xyy)-field(p-e.xyy),field(p+e.yxy)-field(p-e.yxy),field(p+e.yyx)-field(p-e.yyx)));
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5*resolution) / resolution.y;
  vec3 ro = vec3(0.0,0.0,3.5);
  vec3 rd = normalize(vec3(uv,-1.85));
  float t = 0.0, glow = 0.0, hit = 0.0;
  for (int i=0; i<56; i++) {
    vec3 p = ro+rd*t;
    float d = field(p);
    glow += 0.007 / (0.035 + abs(d)*abs(d)*20.0);
    if (d < 0.003) { hit = 1.0; break; }
    t += max(d*0.75,0.018);
    if (t > 7.0) break;
  }
  float haze = exp(-length(uv)*2.5);
  vec3 col = mix(vec3(0.012,0.024,0.033),vec3(0.027,0.064,0.069),haze);
  col += min(glow,2.0)*vec3(0.015,0.064,0.054)*(0.35+peak);
  if (hit > 0.5) {
    vec3 p = ro+rd*t;
    vec3 n = normalAt(p);
    float rim = pow(1.0-max(dot(n,-rd),0.0),2.2);
    float diffuse = max(dot(n,normalize(vec3(-0.6,0.9,1.7))),0.0);
    float az = (atan(p.z,p.x)+PI)/(2.0*PI);
    float e = bandAt(clamp(floor(az*16.0),0.0,15.0));
    vec3 jade = vec3(0.22,0.68,0.55);
    vec3 gold = vec3(0.91,0.72,0.35);
    col = mix(jade,gold,clamp(e*2.0 + 0.18,0.0,1.0)) * (0.22+diffuse*0.65+rim*1.1+e*0.55);
    col += pow(max(dot(reflect(rd,n),normalize(vec3(-0.5,0.8,1.0))),0.0),18.0)*vec3(0.8,0.94,0.67);
  }
  col = pow(col,vec3(0.86));
  gl_FragColor = vec4(col,1.0);
}`;

function compile(gl: WebGLRenderingContext, kind: number, source: string) {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error("WebGL shader unavailable");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || "WebGL shader compilation failed");
  }
  return shader;
}

/** Only local output-monitor samples move the sculpture. Never infer a beat from track metadata. */
export function SpotifyVisualizer({ active, device }: { active: boolean; device: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const signal = useRef({ bands: new Float32Array(16), rms: 0, peak: 0, live: false });
  const [frame, setFrame] = useState<Spectrum | null>(null);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [glError, setGlError] = useState(false);
  const running = active && pageVisible;
  useEffect(() => {
    const visibility = () => setPageVisible(!document.hidden);
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(preference.matches);
    document.addEventListener("visibilitychange", visibility);
    preference.addEventListener("change", motion);
    return () => { document.removeEventListener("visibilitychange", visibility); preference.removeEventListener("change", motion); };
  }, []);

  useEffect(() => {
    if (!running) { signal.current.live = false; setFrame(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller = new AbortController();
      try {
        const data = await api<Spectrum>("/api/music/visualizer", { signal: controller.signal, cache: "no-store" });
        if (cancelled) return;
        const fresh = data.available && data.source === "local-output-monitor" &&
          Number.isFinite(data.at) && Math.abs(Date.now() - data.at) < 1200 &&
          Array.isArray(data.bands) && data.bands.length === 16;
        signal.current.live = fresh;
        signal.current.rms = fresh ? clamp(data.rms) : 0;
        signal.current.peak = fresh ? clamp(data.peak) : 0;
        for (let i = 0; i < 16; i++) signal.current.bands[i] = fresh ? clamp(data.bands[i]) : 0;
        setFrame(fresh ? data : { ...data, available: false, reason: data.reason || "Waiting for fresh local audio" });
      } catch {
        if (!cancelled) {
          signal.current.live = false;
          signal.current.rms = signal.current.peak = 0;
          signal.current.bands.fill(0);
          setFrame({ available: false, source: "local-output-monitor", at: 0, rms: 0, peak: 0, bands: Array(16).fill(0), reason: "Local output monitor unavailable" });
        }
      } finally { if (!cancelled) timer = setTimeout(poll, 125); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); controller?.abort(); signal.current.live = false; signal.current.bands.fill(0); };
  }, [running]);

  useEffect(() => {
    const node = canvas.current;
    if (!running || reduced || !node || glError) return;
    const gl = node.getContext("webgl", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (!gl) { setGlError(true); return; }
    let raf = 0;
    let vertexShader: WebGLShader | null = null, fragmentShader: WebGLShader | null = null;
    let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null;
    let observer: ResizeObserver | null = null;
    let disposed = false;
    const lost = (event: Event) => { event.preventDefault(); cancelAnimationFrame(raf); setGlError(true); };
    node.addEventListener("webglcontextlost", lost);
    try {
      vertexShader = compile(gl, gl.VERTEX_SHADER, vertex);
      fragmentShader = compile(gl, gl.FRAGMENT_SHADER, fragment);
      program = gl.createProgram();
      if (!program) throw new Error("WebGL program unavailable");
      gl.attachShader(program, vertexShader); gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "WebGL link failed");
      buffer = gl.createBuffer();
      if (!buffer) throw new Error("WebGL buffer unavailable");
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
      gl.useProgram(program);
      const pos = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
      const res = gl.getUniformLocation(program, "resolution");
      const time = gl.getUniformLocation(program, "clock");
      const rms = gl.getUniformLocation(program, "rms");
      const peak = gl.getUniformLocation(program, "peak");
      const bands = gl.getUniformLocation(program, "bands[0]");
      const resize = () => {
        const rect = node.getBoundingClientRect();
        const scale = Math.min(devicePixelRatio || 1, 1.5, 1400 / Math.max(rect.width, 1));
        node.width = Math.max(1, Math.round(rect.width * scale));
        node.height = Math.max(1, Math.round(rect.height * scale));
        gl.viewport(0, 0, node.width, node.height);
      };
      observer = new ResizeObserver(resize);
      observer.observe(node); resize();
      const current = new Float32Array(16);
      let level = 0, transient = 0, phase = 0, last = performance.now();
      const draw = (now: number) => {
        if (disposed) return;
        const dt = Math.min((now - last) / 1000, 0.05); last = now;
        const target = signal.current;
        const easing = 1 - Math.exp(-dt * 13);
        for (let i = 0; i < 16; i++) current[i] += ((target.live ? Math.min(1, Math.sqrt(target.bands[i]) * 2.2) : 0) - current[i]) * easing;
        level += ((target.live ? Math.min(1, target.rms * 3) : 0) - level) * easing;
        transient += ((target.live ? Math.min(1, target.peak * 2) : 0) - transient) * easing;
        if (target.live && (target.rms > 0.002 || target.peak > 0.004)) phase += dt;
        gl.uniform2f(res, node.width, node.height);
        gl.uniform1f(time, phase);
        gl.uniform1f(rms, level);
        gl.uniform1f(peak, transient);
        gl.uniform1fv(bands, current);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    } catch (error) {
      console.warn("Spotify visualizer WebGL unavailable", error);
      setGlError(true);
    }
    return () => {
      disposed = true; cancelAnimationFrame(raf); observer?.disconnect();
      node.removeEventListener("webglcontextlost", lost);
      if (!gl.isContextLost()) {
        if (buffer) gl.deleteBuffer(buffer);
        if (program) gl.deleteProgram(program);
        if (vertexShader) gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
      }
    };
  }, [running, reduced, glError]);

  if (!active) return null;
  const live = !!frame?.available;
  const sound = live && (frame!.rms > 0.002 || frame!.peak > 0.004);
  return (
    <section className="music-visualizer" aria-label="Live local audio visualizer" data-testid="spotify-visualizer">
      <div className="music-visualizer-top"><span>OUTPUT / SPECTRUM</span><span>{sound ? "LIVE · 16 BANDS" : "LOCAL OUTPUT ONLY"}</span></div>
      {!reduced && !glError && <canvas ref={canvas} aria-hidden="true" />}
      {(reduced || glError) && <div className="music-spectrum" aria-hidden="true">{Array.from(live ? frame!.bands : quiet).map((value, i) => <span key={i} style={{ height: `${Math.max(4, clamp(value) * 100)}%` }} />)}</div>}
      <div className="music-visualizer-bottom">
        <span>{sound ? "Sound sculpted in real time" : glError ? "WebGL unavailable · spectrum view" : reduced ? "Reduced motion · spectrum view" : "Waiting for local audio"}</span>
        {!sound && <small>{frame?.reason || "The sculpture responds only to audio playing on this Cyberdeck."} {device && `If ${device} plays elsewhere, its audio cannot be visualized here.`}</small>}
      </div>
    </section>
  );
}
