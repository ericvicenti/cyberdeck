// Local output-monitor analysis only: never expose, log, write, or retain PCM.
import type { Hono } from "hono";

export const VISUALIZER_RATE = 16000;
export const VISUALIZER_SIZE = 512;
export const VISUALIZER_BANDS = 16;
export type SpectrumFrame = { available: boolean; source: "local-output-monitor"; at: number; rms: number; peak: number; bands: number[]; reason?: string };
const empty = (reason: string): SpectrumFrame => ({ available: false, source: "local-output-monitor", at: Date.now(), rms: 0, peak: 0, bands: Array(VISUALIZER_BANDS).fill(0), reason });
const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** Analyze a mono 16 kHz window; values are linear 0..1, bands are log-spaced 31 Hz–8 kHz. */
export function analyzeWindow(samples: Int16Array): SpectrumFrame {
  if (samples.length !== VISUALIZER_SIZE) throw new RangeError("expected 512 samples");
  const re = new Float64Array(VISUALIZER_SIZE), im = new Float64Array(VISUALIZER_SIZE);
  let sum = 0, peak = 0;
  for (let i = 0; i < VISUALIZER_SIZE; i++) {
    const v = samples[i] / 32768;
    sum += v * v; peak = Math.max(peak, Math.abs(v));
    re[i] = v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (VISUALIZER_SIZE - 1)));
  }
  // Iterative radix-2 FFT; bounded to one 512-sample window.
  for (let i = 1, j = 0; i < VISUALIZER_SIZE; i++) {
    let bit = VISUALIZER_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= VISUALIZER_SIZE; len <<= 1) {
    const angle = -2 * Math.PI / len;
    for (let start = 0; start < VISUALIZER_SIZE; start += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k), wi = Math.sin(angle * k);
        const a = start + k, b = a + len / 2;
        const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  const bands = Array.from({ length: VISUALIZER_BANDS }, (_, band) => {
    const lo = Math.max(1, Math.floor(Math.pow(256, band / VISUALIZER_BANDS)));
    const hi = Math.max(lo + 1, Math.ceil(Math.pow(256, (band + 1) / VISUALIZER_BANDS)));
    let power = 0;
    for (let bin = lo; bin < Math.min(hi, 256); bin++) power += re[bin] ** 2 + im[bin] ** 2;
    return clamp(Math.sqrt(power / Math.max(1, Math.min(hi, 256) - lo)) * 4 / VISUALIZER_SIZE);
  });
  return { available: true, source: "local-output-monitor", at: Date.now(), rms: clamp(Math.sqrt(sum / VISUALIZER_SIZE)), peak: clamp(peak), bands };
}

export class LocalSpectrum {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private starting: Promise<void> | null = null;
  private lastRequest = 0;
  private retryAfter = 0;
  private generation = 0;
  private frame = empty("waiting for local output");
  private timer: ReturnType<typeof setInterval> | null = null;
  private window = new Int16Array(VISUALIZER_SIZE);
  private count = 0;
  private byte = -1;

  get(): SpectrumFrame {
    this.lastRequest = Date.now();
    if (!this.proc && !this.starting && this.lastRequest >= this.retryAfter) {
      this.starting = this.start().catch(() => {
        this.frame = empty("local output monitor unavailable");
        this.retryAfter = Date.now() + 3000;
      }).finally(() => { this.starting = null; });
    }
    return Date.now() - this.frame.at > 1500 ? empty(this.proc ? "waiting for audio" : this.frame.reason ?? "unavailable") : this.frame;
  }

  private async start() {
    // Resolve the default sink, never the default input source (microphones are forbidden).
    const lookup = Bun.spawn(["pactl", "get-default-sink"], { stdout: "pipe", stderr: "ignore" });
    const deadline = setTimeout(() => lookup.kill(), 1000);
    let name: string;
    try {
      name = (await new Response(lookup.stdout).text()).trim();
      if (await lookup.exited !== 0 || !/^[a-zA-Z0-9_.-]{1,200}$/.test(name)) throw new Error("no default sink");
    } finally { clearTimeout(deadline); }
    // PipeWire Pulse compatibility: one shared capture, 32 KB/s, mono, stdout only.
    const proc = Bun.spawn(["parec", "--raw", "--format=s16le", "--rate=16000", "--channels=1", `--device=${name}.monitor`], { stdout: "pipe", stderr: "ignore" });
    this.proc = proc;
    const generation = ++this.generation;
    this.count = 0; this.byte = -1;
    this.frame = empty("waiting for audio");
    this.timer = setInterval(() => { if (Date.now() - this.lastRequest > 5000) proc.kill(); }, 1000);
    this.timer.unref?.();
    void this.consume(proc, generation);
  }

  private async consume(proc: ReturnType<typeof Bun.spawn>, generation: number) {
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done || generation !== this.generation) break;
        for (const b of value) {
          if (this.byte < 0) { this.byte = b; continue; }
          this.window[this.count++] = (this.byte | (b << 8)) << 16 >> 16;
          this.byte = -1;
          if (this.count === VISUALIZER_SIZE) {
            if (Date.now() - this.lastRequest <= 5000) this.frame = analyzeWindow(this.window);
            this.count = 0;
          }
        }
      }
    } catch { /* device can disappear */ }
    finally {
      proc.kill();
      if (generation === this.generation) {
        if (this.timer) clearInterval(this.timer);
        this.timer = null; this.proc = null;
        this.frame = empty("local output monitor disconnected");
        this.retryAfter = Date.now() + 3000;
      }
    }
  }
}

/** Auth is supplied by /api/* middleware; polling creates no per-client capture. */
export function registerMusicVisualizerRoutes(app: Hono, spectrum = new LocalSpectrum()) {
  app.get("/api/music/visualizer", (c) => {
    c.header("cache-control", "no-store");
    return c.json(spectrum.get());
  });
}
