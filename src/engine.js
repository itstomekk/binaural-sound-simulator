// Binaural Room — audio engine (Web Audio API, no DOM, no Three.js).
//
// Coordinates follow Web Audio / Three.js: +X right, +Y up, -Z forward (the direction
// the listener faces). Units are metres. The listener is fixed at the origin.
//
// Signal chain per speaker:
//   source -> trim -> [air absorption lowpass] -> [propagation delay] -> PannerNode(HRTF) -> master
// The PannerNode handles direction (HRTF), distance attenuation and the sound cone.
// The delay node adds the distance/speed-of-sound travel time, the lowpass approximates
// high-frequency loss in air and off-axis loss of a directional speaker.

export const SPEED_OF_SOUND = 343; // m/s
export const MIN_DISTANCE = 0.25; // closest a speaker may be to the head centre
export const MAX_DISTANCE = 100;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const len = (x, y, z) => Math.hypot(x, y, z);

/** Listener-relative spherical coords. azimuth 0 = front, +90 = right, 180 = behind. */
export function toSpherical(x, y, z) {
  const d = len(x, y, z);
  if (d < 1e-9) return { azimuth: 0, elevation: 0, distance: 0 };
  return {
    azimuth: (Math.atan2(x, -z) * 180) / Math.PI,
    elevation: (Math.asin(clamp(y / d, -1, 1)) * 180) / Math.PI,
    distance: d,
  };
}
export function fromSpherical(azimuth, elevation, distance) {
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  return [
    distance * Math.cos(el) * Math.sin(az),
    distance * Math.sin(el),
    -distance * Math.cos(el) * Math.cos(az),
  ];
}

/** Gain the Web Audio inverse distance model applies (for UI read-outs). */
export function inverseGain(distance, refDistance = 1, rolloff = 1) {
  const d = Math.max(distance, refDistance);
  return refDistance / (refDistance + rolloff * (d - refDistance));
}

/** Web Audio cone gain for a given off-axis angle (degrees, 0 = aimed straight at listener). */
export function coneGain(offAxisDeg, innerDeg, outerDeg, outerGain) {
  const a = Math.abs(offAxisDeg) * 2; // spec compares full angles
  const inner = innerDeg, outer = outerDeg;
  if (a <= inner) return 1;
  if (a >= outer) return outerGain;
  const t = (a - inner) / (outer - inner);
  return 1 + (outerGain - 1) * t;
}

export class SpatialEngine {
  /**
   * @param {BaseAudioContext} ctx  AudioContext or OfflineAudioContext
   * @param {{smoothing?: number}} [opts] smoothing = time constant (s) used when parameters
   *   change during playback. 0 = apply immediately (use for offline rendering/tests).
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.smoothing = opts.smoothing ?? 0.03;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);
    this.settings = {
      panningModel: 'HRTF', // or 'equalpower'
      propagationDelay: true,
      airAbsorption: true,
      rolloff: 1,
    };
    this.speakers = new Map();
  }

  setMasterVolume(v) { this.master.gain.value = v; }

  setPanningModel(model) {
    this.settings.panningModel = model;
    for (const s of this.speakers.values()) s.panner.panningModel = model;
  }
  setPropagationDelay(on) { this.settings.propagationDelay = on; this._refreshAll(); }
  setAirAbsorption(on) { this.settings.airAbsorption = on; this._refreshAll(); }
  setRolloff(r) {
    this.settings.rolloff = r;
    for (const s of this.speakers.values()) s.panner.rolloffFactor = r;
    this._refreshAll();
  }
  _refreshAll() { for (const s of this.speakers.values()) s._update(); }

  addSpeaker(id) {
    const s = new Speaker(this, id);
    this.speakers.set(id, s);
    return s;
  }
  removeSpeaker(id) {
    const s = this.speakers.get(id);
    if (!s) return;
    s.dispose();
    this.speakers.delete(id);
  }
  stopAll() { for (const s of this.speakers.values()) s.stop(); }
  playAll(when) {
    const t = when ?? this.ctx.currentTime + 0.05;
    for (const s of this.speakers.values()) s.play(t);
  }
}

class Speaker {
  constructor(engine, id) {
    this.engine = engine;
    this.id = id;
    const ctx = engine.ctx;
    this.trim = ctx.createGain(); // volume * mute * solo
    this.trim.channelCount = 1; // HRTF panning works on a mono signal: downmix stereo files
    this.trim.channelCountMode = 'explicit';
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 22000;
    this.filter.Q.value = 0.5;
    this.delay = ctx.createDelay(1.0);
    this.panner = ctx.createPanner();
    this.panner.panningModel = engine.settings.panningModel;
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 1;
    this.panner.maxDistance = 10000;
    this.panner.rolloffFactor = engine.settings.rolloff;
    this.trim.connect(this.filter).connect(this.delay).connect(this.panner).connect(engine.master);

    this.state = {
      position: [0, 0, -2],
      aim: [0, 0, 1], // unit vector the speaker faces
      directional: false,
      innerAngle: 60, // full angle, degrees: no attenuation inside
      outerAngle: 200, // full angle, degrees: outerGain beyond
      outerGain: 0.08,
      volume: 1,
      muted: false,
      loop: true,
    };
    this.buffer = null;
    this.source = null;
    this.playing = false;
    this._started = false; // has had a first update -> subsequent updates glide
    this._update();
  }

  // ---- state setters ------------------------------------------------------------
  setPosition(x, y, z) {
    const d = len(x, y, z);
    if (d < MIN_DISTANCE) { // keep out of the head
      const k = d < 1e-9 ? 0 : MIN_DISTANCE / d;
      [x, y, z] = d < 1e-9 ? [0, 0, -MIN_DISTANCE] : [x * k, y * k, z * k];
    } else if (d > MAX_DISTANCE) {
      const k = MAX_DISTANCE / d; x *= k; y *= k; z *= k;
    }
    this.state.position = [x, y, z];
    this._update();
  }
  setAim(x, y, z) {
    const d = len(x, y, z) || 1;
    this.state.aim = [x / d, y / d, z / d];
    this._update();
  }
  /** Aim the speaker at the listener's head. */
  aimAtListener() {
    const [x, y, z] = this.state.position;
    this.setAim(-x, -y, -z);
  }
  setDirectional(on, innerAngle, outerAngle, outerGain) {
    const st = this.state;
    st.directional = on;
    if (innerAngle != null) st.innerAngle = innerAngle;
    if (outerAngle != null) st.outerAngle = Math.max(outerAngle, st.innerAngle + 1);
    if (outerGain != null) st.outerGain = outerGain;
    this._update();
  }
  setVolume(v) { this.state.volume = v; this._update(); }
  setMuted(m) { this.state.muted = m; this._update(); }
  setSoloSilenced(silenced) { this._soloSilenced = silenced; this._update(); }
  setLoop(l) { this.state.loop = l; if (this.source) this.source.loop = l; }
  setBuffer(buf) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.stop();
    this.buffer = buf;
    if (wasPlaying) this.play();
  }

  // ---- read-outs ----------------------------------------------------------------
  get info() {
    const st = this.state, [x, y, z] = st.position;
    const sph = toSpherical(x, y, z);
    // angle between where the speaker faces and the direction to the listener
    const toL = [-x / sph.distance, -y / sph.distance, -z / sph.distance];
    const dot = clamp(st.aim[0] * toL[0] + st.aim[1] * toL[1] + st.aim[2] * toL[2], -1, 1);
    const offAxis = (Math.acos(dot) * 180) / Math.PI;
    const rolloff = this.engine.settings.rolloff;
    const dist = inverseGain(sph.distance, 1, rolloff);
    const cone = st.directional ? coneGain(offAxis, st.innerAngle, st.outerAngle, st.outerGain) : 1;
    return {
      ...sph,
      offAxis,
      delayMs: this.engine.settings.propagationDelay ? (sph.distance / SPEED_OF_SOUND) * 1000 : 0,
      distanceGainDb: 20 * Math.log10(dist),
      coneGainDb: 20 * Math.log10(Math.max(cone, 1e-4)),
    };
  }

  // ---- playback -----------------------------------------------------------------
  play(when) {
    if (!this.buffer) return;
    this.stop();
    const ctx = this.engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.state.loop;
    src.connect(this.trim);
    src.onended = () => { if (this.source === src) { this.source = null; this.playing = false; this.onended?.(); } };
    src.start(when ?? 0);
    this.source = src;
    this.playing = true;
  }
  stop() {
    if (this.source) {
      const s = this.source;
      this.source = null;
      s.onended = null;
      try { s.stop(); } catch { /* already stopped */ }
      s.disconnect();
    }
    this.playing = false;
  }
  dispose() {
    this.stop();
    this.trim.disconnect(); this.filter.disconnect(); this.delay.disconnect(); this.panner.disconnect();
  }

  // ---- parameter plumbing -------------------------------------------------------
  _set(param, value) {
    const sm = this.engine.smoothing;
    const ctx = this.engine.ctx;
    if (this._started && sm > 0 && this.playing) {
      param.setTargetAtTime(value, ctx.currentTime, sm);
    } else {
      param.cancelScheduledValues(0);
      param.value = value;
    }
  }

  _update() {
    const st = this.state;
    const p = this.panner;
    const [x, y, z] = st.position;
    this._set(p.positionX, x); this._set(p.positionY, y); this._set(p.positionZ, z);
    this._set(p.orientationX, st.aim[0]); this._set(p.orientationY, st.aim[1]); this._set(p.orientationZ, st.aim[2]);

    if (st.directional) {
      p.coneInnerAngle = st.innerAngle;
      p.coneOuterAngle = st.outerAngle;
      p.coneOuterGain = st.outerGain;
    } else {
      p.coneInnerAngle = 360; p.coneOuterAngle = 360; p.coneOuterGain = 0;
    }

    const vol = st.muted || this._soloSilenced ? 0 : st.volume;
    this._set(this.trim.gain, vol);

    const info = this.info;
    const settings = this.engine.settings;
    this._set(this.delay.delayTime, settings.propagationDelay ? clamp(info.distance / SPEED_OF_SOUND, 0, 0.99) : 0);

    // Lowpass: air absorption (grows with distance) and, for directional speakers, off-axis loss.
    let cutoff = 22000;
    if (settings.airAbsorption) cutoff = Math.min(cutoff, 20000 * Math.exp(-info.distance / 50));
    if (st.directional) {
      const off = clamp(info.offAxis / 180, 0, 1); // 0 on-axis, 1 directly behind
      cutoff = Math.min(cutoff, 20000 * Math.pow(0.12, off));
    }
    const nyq = this.engine.ctx.sampleRate / 2 - 100;
    this._set(this.filter.frequency, clamp(cutoff, 1500, nyq));
    this._started = true;
  }
}
