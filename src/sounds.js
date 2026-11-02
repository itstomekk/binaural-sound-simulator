// Sound library: synthesised built-ins, bundled voice clips, and user uploads.
// Every sound is a mono AudioBuffer made to loop cleanly (silence is baked into the buffer).
import { VOICES } from './voices.generated.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function pinkNoise(n, rand) {
  // Paul Kellet's economy pink filter
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

function make(ctx, seconds, fill) {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.floor(seconds * sr), sr);
  fill(buf.getChannelData(0), sr);
  return buf;
}

const env = (t, attack, decay) => (t < 0 ? 0 : Math.min(1, t / attack) * Math.exp(-t / decay));

export const BUILTINS = [
  {
    id: 'noise-bursts', label: 'Noise bursts',
    build: (ctx) => make(ctx, 1.2, (d, sr) => {
      const rand = rng(1), noise = pinkNoise(d.length, rand);
      for (const start of [0, 0.3]) {
        const n0 = Math.floor(start * sr), len = Math.floor(0.12 * sr);
        for (let i = 0; i < len; i++) d[n0 + i] = noise[n0 + i] * Math.min(1, i / (0.004 * sr)) * Math.min(1, (len - i) / (0.01 * sr)) * 2.2;
      }
    }),
  },
  {
    id: 'clicks', label: 'Clicks',
    build: (ctx) => make(ctx, 1.0, (d, sr) => {
      const rand = rng(2);
      for (let k = 0; k < 5; k++) {
        const n0 = Math.floor(k * 0.2 * sr);
        for (let i = 0; i < 0.006 * sr; i++) d[n0 + i] = (rand() * 2 - 1) * Math.exp(-i / (0.0012 * sr)) * 0.9;
      }
    }),
  },
  {
    id: 'bell', label: 'Bell',
    build: (ctx) => make(ctx, 3.0, (d, sr) => {
      const partials = [[1, 1], [2.0, 0.6], [2.76, 0.5], [5.4, 0.35], [8.93, 0.2]];
      for (let i = 0; i < d.length; i++) {
        const t = i / sr; let v = 0;
        for (const [m, a] of partials) v += a * Math.sin(2 * Math.PI * 660 * m * t) * Math.exp(-t * (1.6 + m * 0.9));
        d[i] = v * 0.35 * Math.min(1, t / 0.002);
      }
    }),
  },
  {
    id: 'footsteps', label: 'Footsteps',
    build: (ctx) => make(ctx, 1.0, (d, sr) => {
      const rand = rng(3); let lp = 0;
      for (const start of [0, 0.5]) {
        const n0 = Math.floor(start * sr);
        for (let i = 0; i < 0.18 * sr; i++) {
          lp += 0.12 * ((rand() * 2 - 1) - lp);
          const t = i / sr;
          d[n0 + i] = (lp * 3.2 + Math.sin(2 * Math.PI * 70 * t) * 0.6) * env(t, 0.002, 0.035);
        }
      }
    }),
  },
  {
    id: 'bird', label: 'Bird tweets',
    build: (ctx) => make(ctx, 1.6, (d, sr) => {
      for (const [start, f0, f1] of [[0, 3200, 4600], [0.18, 3500, 5200], [0.36, 3000, 5000], [0.54, 3800, 5600]]) {
        const n0 = Math.floor(start * sr); let phase = 0;
        for (let i = 0; i < 0.13 * sr; i++) {
          const t = i / (0.13 * sr);
          const f = f0 + (f1 - f0) * t + 250 * Math.sin(2 * Math.PI * 28 * t);
          phase += (2 * Math.PI * f) / sr;
          d[n0 + i] = Math.sin(phase) * Math.sin(Math.PI * t) * 0.5;
        }
      }
    }),
  },
  {
    id: 'sweep', label: 'Sweep 200 Hz to 12 kHz',
    build: (ctx) => make(ctx, 2.0, (d, sr) => {
      let phase = 0; const dur = 1.2 * sr;
      for (let i = 0; i < dur; i++) {
        const f = 200 * Math.pow(60, i / dur);
        phase += (2 * Math.PI * f) / sr;
        d[i] = Math.sin(phase) * Math.min(1, i / (0.01 * sr)) * Math.min(1, (dur - i) / (0.02 * sr)) * 0.5;
      }
    }),
  },
  {
    id: 'beep', label: 'Beep 1 kHz',
    build: (ctx) => make(ctx, 0.9, (d, sr) => {
      for (let i = 0; i < 0.15 * sr; i++) d[i] = Math.sin((2 * Math.PI * 1000 * i) / sr) * Math.min(1, i / (0.005 * sr)) * Math.min(1, (0.15 * sr - i) / (0.005 * sr)) * 0.5;
    }),
  },
];

/** Downmix any decoded buffer to mono. */
export function toMono(ctx, buf) {
  if (buf.numberOfChannels === 1) return buf;
  const out = ctx.createBuffer(1, buf.length, buf.sampleRate);
  const o = out.getChannelData(0);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < o.length; i++) o[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

function b64ToArrayBuffer(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

export class SoundLibrary {
  constructor(ctx) {
    this.ctx = ctx;
    this.items = new Map(); // id -> {id,label,buffer,kind}
    this.uploadCounter = 0;
  }
  async init() {
    for (const b of BUILTINS) this.items.set(b.id, { id: b.id, label: b.label, buffer: b.build(this.ctx), kind: 'built-in' });
    await Promise.all(VOICES.map(async (v) => {
      try {
        const buf = await this.ctx.decodeAudioData(b64ToArrayBuffer(v.mp3));
        this.items.set(v.id, { id: v.id, label: v.label, buffer: toMono(this.ctx, buf), kind: 'voice' });
      } catch (e) { console.error('voice decode failed', v.id, e); }
    }));
    // keep a stable, friendly order: built-ins first, then voices
    const order = [...BUILTINS.map((b) => b.id), ...VOICES.map((v) => v.id)];
    const sorted = new Map();
    for (const id of order) if (this.items.has(id)) sorted.set(id, this.items.get(id));
    this.items = sorted;
  }
  async addFile(file) {
    const data = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(data);
    const id = `file-${++this.uploadCounter}`;
    const item = { id, label: `File: ${file.name}`, buffer: toMono(this.ctx, buf), kind: 'upload' };
    this.items.set(id, item);
    return item;
  }
  get(id) { return this.items.get(id); }
}
