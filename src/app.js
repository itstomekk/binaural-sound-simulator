// Binaural Room — app: wires engine, sound library, 3D view and the control panel together.
import { SpatialEngine, toSpherical, fromSpherical, MIN_DISTANCE } from './engine.js';
import { SoundLibrary } from './sounds.js';
import { RoomView } from './scene.js';

const COLORS = ['#ff7a59', '#4fc3f7', '#9ccc65', '#ffd54f', '#ba68c8', '#4db6ac', '#f06292', '#90a4ae'];
const D_MIN = MIN_DISTANCE, D_MAX = 50;
const STORAGE_KEY = 'binaural-room-v1';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const distToSlider = (d) => Math.round((Math.log(Math.max(d, D_MIN) / D_MIN) / Math.log(D_MAX / D_MIN)) * 1000);
const sliderToDist = (s) => D_MIN * Math.pow(D_MAX / D_MIN, s / 1000);
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-4));
const fmt = (v, n = 1) => (Math.abs(v) < 0.05 && n === 1 ? '0.0' : v.toFixed(n));

const PRESETS = {
  welcome: {
    label: 'Welcome (voice + bell)', stagger: 0,
    speakers: [
      { name: 'Hello', snd: 'voice-hello-en', az: 40, el: 0, d: 3 },
      { name: 'Bell', snd: 'bell', az: -70, el: 35, d: 5 },
    ],
  },
  axis: {
    label: 'Axis test: front, behind, above, below, left, right', stagger: 0.45,
    speakers: [
      { name: 'Front', snd: 'voice-front', az: 0, el: 0, d: 2.5 },
      { name: 'Right', snd: 'voice-right', az: 90, el: 0, d: 2.5 },
      { name: 'Behind', snd: 'voice-behind', az: 180, el: 0, d: 2.5 },
      { name: 'Left', snd: 'voice-left', az: -90, el: 0, d: 2.5 },
      { name: 'Above', snd: 'voice-above', az: 0, el: 80, d: 2.5 },
      { name: 'Below', snd: 'voice-below', az: 0, el: -80, d: 2.5 },
    ],
  },
  circle: {
    label: 'Circle of 8 (rotating bursts)', stagger: 0.15,
    speakers: Array.from({ length: 8 }, (_, i) => ({ name: `${i * 45}°`, snd: 'noise-bursts', az: i * 45 > 180 ? i * 45 - 360 : i * 45, el: 0, d: 3 })),
  },
  distance: {
    label: 'Distance ladder (1, 2, 4, 8, 16 m)', stagger: 0.24,
    speakers: [1, 2, 4, 8, 16].map((d, i) => ({ name: `${d} m`, snd: 'noise-bursts', az: -60 + i * 30, el: 0, d })),
  },
  party: {
    label: 'Cocktail party (4 sources, 2 directional)', stagger: 0.3,
    speakers: [
      { name: 'Hello', snd: 'voice-hello-en', az: -50, el: 0, d: 2.5, directional: true },
      { name: 'Cześć', snd: 'voice-hello-pl', az: 50, el: 0, d: 3, directional: true },
      { name: 'Bird', snd: 'bird', az: 0, el: 40, d: 6 },
      { name: 'Steps', snd: 'footsteps', az: 160, el: -5, d: 4 },
    ],
  },
};

class App {
  constructor() {
    this.meta = new Map(); // id -> {id,name,color,soundId,solo,orbit:{on,speed},autoAim,sph:{az,el,d}}
    this.order = [];
    this.selectedId = null;
    this.counter = 0;
    this.global = { master: 0.8, model: 'HRTF', delay: true, air: true, rolloff: 1, stagger: 0, rings: true };
  }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.engine = new SpatialEngine(this.ctx);
    this.lib = new SoundLibrary(this.ctx);
    await this.lib.init();
    this.view = new RoomView($('#view'), {
      onSelect: (id) => this.select(id, true),
      onChange: (id, pos, aim) => this.onViewChange(id, pos, aim),
    });
    this.view.onFrame = (dt) => this.tick(dt);
    this.bindGlobalUi();
    this.loadSaved() || this.loadPreset('welcome', false);
    this.applyGlobal();
    this.renderGlobalUi();
    this.refreshAudioState();
    $('#loading').remove();
    window.__app = this; // handy for debugging and tests
  }

  // ---- speakers ---------------------------------------------------------------------
  addSpeaker(opts = {}) {
    const id = opts.id || `sp${++this.counter}`;
    this.counter = Math.max(this.counter, Number(String(id).replace(/\D/g, '')) || 0);
    const color = opts.color || COLORS[this.order.length % COLORS.length];
    const sph = { az: opts.az ?? 0, el: opts.el ?? 0, d: opts.d ?? 3 };
    const sp = this.engine.addSpeaker(id);
    const meta = {
      id, name: opts.name || `Speaker ${this.order.length + 1}`, color,
      soundId: this.lib.get(opts.snd) ? opts.snd : 'noise-bursts',
      solo: false, orbit: { on: !!opts.orbit?.on, speed: opts.orbit?.speed ?? 30 },
      autoAim: opts.autoAim ?? true, sph,
    };
    this.meta.set(id, meta);
    this.order.push(id);
    const pos = opts.position || fromSpherical(sph.az, sph.el, sph.d);
    sp.setPosition(...pos);
    if (opts.position) { const s = toSpherical(...sp.state.position); Object.assign(sph, { az: s.azimuth, el: s.elevation, d: s.distance }); }
    sp.setVolume(opts.volume ?? 1);
    sp.setMuted(!!opts.muted);
    sp.setLoop(opts.loop ?? true);
    sp.setDirectional(!!opts.directional, opts.innerAngle ?? 60, opts.outerAngle ?? 200, opts.outerGain ?? dbToGain(-22));
    if (opts.aim && !meta.autoAim) sp.setAim(...opts.aim); else sp.aimAtListener();
    sp.setBuffer(this.lib.get(meta.soundId).buffer);
    sp.onended = () => { this.view.setPlaying(id, false); this.renderList(); };
    this.view.addSpeaker(id, sp.state, color, meta.name);
    return id;
  }

  removeSpeaker(id) {
    this.engine.removeSpeaker(id);
    this.view.removeSpeaker(id);
    this.meta.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.updateSolo();
    this.renderList(); this.save();
  }

  clearAll() { for (const id of [...this.order]) { this.engine.removeSpeaker(id); this.view.removeSpeaker(id); } this.meta.clear(); this.order = []; this.selectedId = null; }

  loadPreset(key, render = true) {
    const p = PRESETS[key]; if (!p) return;
    this.clearAll();
    this.global.stagger = p.stagger;
    for (const s of p.speakers) this.addSpeaker(s);
    this.select(this.order[0] ?? null);
    if (render) { this.renderGlobalUi(); this.save(); }
  }

  select(id, fromView = false) {
    this.selectedId = id;
    if (!fromView) this.view.select(id, true);
    this.renderList();
  }

  sp(id) { return this.engine.speakers.get(id); }

  setFromSph(id) {
    const m = this.meta.get(id), sp = this.sp(id);
    sp.setPosition(...fromSpherical(m.sph.az, m.sph.el, m.sph.d));
    if (m.autoAim) sp.aimAtListener();
    this.view.updateSpeaker(id, sp.state);
  }

  onViewChange(id, pos, aim) {
    const m = this.meta.get(id), sp = this.sp(id);
    if (!m || !sp) return;
    if (this.view.mode === 'rotate') {
      sp.setAim(...aim); m.autoAim = false;
    } else {
      sp.setPosition(...pos);
      const s = toSpherical(...sp.state.position);
      Object.assign(m.sph, { az: s.azimuth, el: s.elevation, d: s.distance });
      if (m.autoAim) { sp.aimAtListener(); }
      this.view.updateSpeaker(id, sp.state);
    }
    this.syncControls(id); this.scheduleSave();
  }

  updateSolo() {
    const any = [...this.meta.values()].some((m) => m.solo);
    for (const [id, m] of this.meta) this.sp(id).setSoloSilenced(any && !m.solo);
  }

  // ---- playback ---------------------------------------------------------------------
  async resume() { if (this.ctx.state !== 'running') await this.ctx.resume(); this.refreshAudioState(); }
  async togglePlay(id) {
    await this.resume();
    const sp = this.sp(id);
    if (sp.playing) { sp.stop(); this.view.setPlaying(id, false); } else { sp.play(); this.view.setPlaying(id, true); }
    this.renderList();
  }
  async playAll() {
    await this.resume();
    const t0 = this.ctx.currentTime + 0.06;
    this.order.forEach((id, i) => { this.sp(id).play(t0 + i * this.global.stagger); this.view.setPlaying(id, true); });
    this.renderList();
  }
  stopAll() { this.engine.stopAll(); for (const id of this.order) this.view.setPlaying(id, false); this.renderList(); }
  refreshAudioState() {
    const s = this.ctx.state;
    $('#audio-state').textContent = s === 'running' ? 'audio on' : 'audio off (press Play)';
    $('#audio-state').dataset.on = s === 'running' ? '1' : '0';
  }

  tick(dt) {
    let moved = false;
    for (const [id, m] of this.meta) {
      if (m.orbit.on) {
        m.sph.az += m.orbit.speed * dt;
        if (m.sph.az > 180) m.sph.az -= 360; if (m.sph.az < -180) m.sph.az += 360;
        this.setFromSph(id); moved = true;
      }
    }
    this._acc = (this._acc || 0) + dt;
    if (this._acc > 0.1) {
      this._acc = 0;
      if (this.selectedId) this.syncReadout(this.selectedId);
      if (moved && this.selectedId) this.syncControls(this.selectedId);
      this.refreshAudioState();
    }
  }

  // ---- global UI ----------------------------------------------------------------------
  bindGlobalUi() {
    $('#play-all').onclick = () => this.playAll();
    $('#stop-all').onclick = () => this.stopAll();
    $('#add').onclick = () => {
      const az = ((this.order.length * 67) % 360) - 180;
      const id = this.addSpeaker({ az, el: 0, d: 3 });
      this.select(id); this.view.select(id, true); this.save();
    };
    $('#preset').innerHTML = '<option value="">Load a preset…</option>' + Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
    $('#preset').onchange = (e) => { if (e.target.value) { this.stopAll(); this.loadPreset(e.target.value); e.target.value = ''; this.applyGlobal(); } };
    const bind = (id, key, conv = (v) => v, ev = 'input') => {
      $(id).addEventListener(ev, (e) => { this.global[key] = conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value); this.applyGlobal(); this.renderGlobalLabels(); this.scheduleSave(); });
    };
    bind('#master', 'master', Number); bind('#model', 'model'); bind('#delay', 'delay'); bind('#air', 'air');
    bind('#rolloff', 'rolloff', Number); bind('#stagger', 'stagger', (v) => Math.max(0, Number(v) || 0), 'input'); bind('#rings', 'rings');
    for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => {
      this.view.setView(b.dataset.view);
      for (const o of document.querySelectorAll('[data-view]')) o.classList.toggle('active', o === b);
    };
    for (const b of document.querySelectorAll('[data-mode]')) b.onclick = () => this.setMode(b.dataset.mode);
    window.addEventListener('keydown', (e) => {
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox') return;
      if (e.key === 'w' || e.key === 'W') this.setMode('translate');
      else if (e.key === 'e' || e.key === 'E') this.setMode('rotate');
      else if (e.key === ' ') { e.preventDefault(); this.order.some((id) => this.sp(id).playing) ? this.stopAll() : this.playAll(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) this.removeSpeaker(this.selectedId);
    });
    // unlock audio on first interaction
    window.addEventListener('pointerdown', () => this.resume(), { once: true });
    // file upload + drag and drop
    const fileInput = $('#file');
    fileInput.onchange = () => this.handleFiles(fileInput.files).then(() => (fileInput.value = ''));
    window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging-file'); });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging-file'); });
    window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dragging-file'); this.handleFiles(e.dataTransfer.files); });
  }

  setMode(mode) {
    this.view.setMode(mode);
    for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
  }

  applyGlobal() {
    const g = this.global, e = this.engine;
    e.setMasterVolume(g.master); e.setPanningModel(g.model); e.setPropagationDelay(g.delay);
    e.setAirAbsorption(g.air); e.setRolloff(g.rolloff); this.view.setRingsVisible(g.rings);
  }
  renderGlobalUi() {
    const g = this.global;
    $('#master').value = g.master; $('#model').value = g.model; $('#delay').checked = g.delay; $('#air').checked = g.air;
    $('#rolloff').value = g.rolloff; $('#stagger').value = g.stagger; $('#rings').checked = g.rings;
    this.setMode(this.view.mode || 'translate');
    this.renderGlobalLabels();
  }
  renderGlobalLabels() {
    $('#master-v').textContent = `${Math.round(this.global.master * 100)}%`;
    $('#rolloff-v').textContent = this.global.rolloff.toFixed(1);
  }

  async handleFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|opus|aac)$/i.test(f.name));
    if (!list.length) { this.toast('No audio files found'); return; }
    for (const f of list) {
      try {
        const item = await this.lib.addFile(f);
        let id = this.selectedId;
        if (!id) { id = this.addSpeaker({ name: f.name.replace(/\.[^.]+$/, ''), snd: item.id, az: 0, el: 0, d: 3 }); this.select(id); this.view.select(id, true); }
        else this.assignSound(id, item.id);
        this.toast(`Loaded ${f.name}`);
      } catch (e) { this.toast(`Could not decode ${f.name}`); console.error(e); }
    }
    this.renderList(); this.save();
  }

  assignSound(id, soundId) {
    const m = this.meta.get(id); if (!m) return;
    m.soundId = soundId;
    this.sp(id).setBuffer(this.lib.get(soundId).buffer);
    this.view.setPlaying(id, this.sp(id).playing);
  }

  toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(this._toast); this._toast = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---- speaker list UI --------------------------------------------------------------
  renderList() {
    const root = $('#speakers');
    if (!this.order.length) { root.innerHTML = '<p class="empty">No speakers yet. Press “Add speaker” or load a preset.</p>'; return; }
    root.innerHTML = this.order.map((id) => this.cardHtml(id)).join('');
    this.bindCards(root);
    if (this.selectedId) this.syncControls(this.selectedId);
  }

  cardHtml(id) {
    const m = this.meta.get(id), sp = this.sp(id), st = sp.state, open = id === this.selectedId;
    const sounds = [...this.lib.items.values()];
    const group = (kind, title) => `<optgroup label="${title}">${sounds.filter((s) => s.kind === kind).map((s) => `<option value="${s.id}" ${s.id === m.soundId ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`;
    const body = open ? `
      <div class="body">
        <label class="row"><span>Sound</span>
          <select data-k="sound">${group('built-in', 'Built-in')}${group('voice', 'Voices')}${sounds.some((s) => s.kind === 'upload') ? group('upload', 'Your files') : ''}</select>
        </label>
        <div class="row"><span></span><button data-act="upload" class="small">Upload your own audio…</button> <label class="chk"><input type="checkbox" data-k="loop" ${st.loop ? 'checked' : ''}> loop</label></div>
        <label class="row"><span>Volume</span><input type="range" data-k="volume" min="0" max="1.5" step="0.01"><b data-v="volume"></b></label>
        <h4>Position around you</h4>
        <label class="row"><span>Azimuth</span><input type="range" data-k="az" min="-180" max="180" step="1"><b data-v="az"></b></label>
        <label class="row"><span>Elevation</span><input type="range" data-k="el" min="-90" max="90" step="1"><b data-v="el"></b></label>
        <label class="row"><span>Distance</span><input type="range" data-k="dist" min="0" max="1000" step="1"><b data-v="dist"></b></label>
        <div class="hint">Azimuth: 0° front, 90° right, ±180° behind. Elevation: +90° straight up.</div>
        <h4>Direction it faces</h4>
        <div class="row"><label class="chk"><input type="checkbox" data-k="directional" ${st.directional ? 'checked' : ''}> directional speaker</label>
          <label class="chk"><input type="checkbox" data-k="autoAim" ${m.autoAim ? 'checked' : ''}> always face me</label></div>
        <div class="dir ${st.directional ? '' : 'off'}">
          <label class="row"><span>Full-level cone</span><input type="range" data-k="inner" min="10" max="180" step="1"><b data-v="inner"></b></label>
          <label class="row"><span>Fade-out cone</span><input type="range" data-k="outer" min="20" max="360" step="1"><b data-v="outer"></b></label>
          <label class="row"><span>Level outside</span><input type="range" data-k="outerDb" min="-60" max="0" step="1"><b data-v="outerDb"></b></label>
        </div>
        <div class="row"><span></span><button data-act="aim-me" class="small">Aim at me</button><button data-act="aim-away" class="small">Face away</button></div>
        <h4>Motion</h4>
        <div class="row"><label class="chk"><input type="checkbox" data-k="orbit" ${m.orbit.on ? 'checked' : ''}> orbit around me</label></div>
        <label class="row"><span>Orbit speed</span><input type="range" data-k="orbitSpeed" min="-180" max="180" step="5"><b data-v="orbitSpeed"></b></label>
        <div class="readout" data-readout></div>
      </div>` : '';
    return `<section class="card ${open ? 'open' : ''}" data-id="${id}" style="--c:${m.color}">
      <header><span class="dot"></span><input class="name" data-k="name" value="${esc(m.name)}" aria-label="speaker name">
        <button data-act="play" title="Play / stop" class="${sp.playing ? 'on' : ''}">${sp.playing ? '■' : '▶'}</button>
        <button data-act="mute" title="Mute" class="${st.muted ? 'on' : ''}">M</button>
        <button data-act="solo" title="Solo" class="${m.solo ? 'on' : ''}">S</button>
        <button data-act="del" title="Delete speaker">✕</button></header>${body}</section>`;
  }

  bindCards(root) {
    for (const card of root.querySelectorAll('.card')) {
      const id = card.dataset.id;
      card.querySelector('header').addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        this.select(id); this.view.select(id, true);
      });
      card.querySelector('.name').addEventListener('focus', () => { if (this.selectedId !== id) { this.select(id); this.view.select(id, true); } });
      card.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
        this.onAct(id, act);
      });
      card.addEventListener('input', (e) => this.onInput(id, e.target));
      card.addEventListener('change', (e) => { if (e.target.dataset.k === 'sound') this.onInput(id, e.target); });
    }
  }

  onAct(id, act) {
    const m = this.meta.get(id), sp = this.sp(id);
    if (act === 'play') this.togglePlay(id);
    else if (act === 'mute') { sp.setMuted(!sp.state.muted); this.renderList(); }
    else if (act === 'solo') { m.solo = !m.solo; this.updateSolo(); this.renderList(); }
    else if (act === 'del') this.removeSpeaker(id);
    else if (act === 'upload') $('#file').click();
    else if (act === 'aim-me') { sp.aimAtListener(); m.autoAim = false; this.view.updateSpeaker(id, sp.state); this.syncControls(id); }
    else if (act === 'aim-away') { const [x, y, z] = sp.state.position; sp.setAim(x, y, z); m.autoAim = false; this.view.updateSpeaker(id, sp.state); this.syncControls(id); }
    this.scheduleSave();
  }

  onInput(id, el) {
    const k = el.dataset.k; if (!k) return;
    const m = this.meta.get(id), sp = this.sp(id), st = sp.state;
    const num = Number(el.value);
    switch (k) {
      case 'name': m.name = el.value; this.view.renameSpeaker(id, el.value); break;
      case 'sound': this.assignSound(id, el.value); break;
      case 'loop': sp.setLoop(el.checked); break;
      case 'volume': sp.setVolume(num); break;
      case 'az': m.sph.az = num; this.setFromSph(id); break;
      case 'el': m.sph.el = num; this.setFromSph(id); break;
      case 'dist': m.sph.d = sliderToDist(num); this.setFromSph(id); break;
      case 'directional': sp.setDirectional(el.checked); this.view.updateSpeaker(id, sp.state); $('.dir', el.closest('.card'))?.classList.toggle('off', !el.checked); break;
      case 'autoAim': m.autoAim = el.checked; if (m.autoAim) { sp.aimAtListener(); this.view.updateSpeaker(id, sp.state); } break;
      case 'inner': sp.setDirectional(st.directional, num, Math.max(st.outerAngle, num + 1), null); this.view.updateSpeaker(id, sp.state); break;
      case 'outer': sp.setDirectional(st.directional, null, num, null); this.view.updateSpeaker(id, sp.state); break;
      case 'outerDb': sp.setDirectional(st.directional, null, null, dbToGain(num)); break;
      case 'orbit': m.orbit.on = el.checked; break;
      case 'orbitSpeed': m.orbit.speed = num; break;
      default: return;
    }
    this.syncControls(id, el); this.scheduleSave();
  }

  /** Write current state into the controls of the open card (skipping the one being edited). */
  syncControls(id, skip) {
    const card = $(`.card[data-id="${id}"]`); if (!card || !card.classList.contains('open')) return;
    const m = this.meta.get(id), sp = this.sp(id), st = sp.state;
    const set = (k, value, label) => {
      const input = card.querySelector(`[data-k="${k}"]`);
      if (input && input !== skip) input.value = value;
      const v = card.querySelector(`[data-v="${k}"]`); if (v) v.textContent = label;
    };
    set('volume', st.volume, `${Math.round(st.volume * 100)}%`);
    set('az', Math.round(m.sph.az), `${Math.round(m.sph.az)}°`);
    set('el', Math.round(m.sph.el), `${Math.round(m.sph.el)}°`);
    set('dist', distToSlider(m.sph.d), `${m.sph.d.toFixed(m.sph.d < 10 ? 2 : 1)} m`);
    set('inner', st.innerAngle, `${Math.round(st.innerAngle)}°`);
    set('outer', st.outerAngle, `${Math.round(st.outerAngle)}°`);
    set('outerDb', Math.round(gainToDb(st.outerGain)), `${Math.round(gainToDb(st.outerGain))} dB`);
    set('orbitSpeed', m.orbit.speed, `${m.orbit.speed}°/s`);
    const aim = card.querySelector('[data-k="autoAim"]'); if (aim) aim.checked = m.autoAim;
    this.syncReadout(id);
  }
  syncReadout(id) {
    const r = $(`.card[data-id="${id}"] [data-readout]`); if (!r) return;
    const i = this.sp(id).info;
    r.innerHTML = `<span>delay <b>${i.delayMs.toFixed(1)} ms</b></span><span>distance level <b>${fmt(i.distanceGainDb)} dB</b></span>`
      + `<span>off-axis <b>${Math.round(i.offAxis)}°</b></span><span>cone level <b>${fmt(i.coneGainDb)} dB</b></span>`;
  }

  // ---- persistence ------------------------------------------------------------------
  scheduleSave() { clearTimeout(this._saveT); this._saveT = setTimeout(() => this.save(), 400); }
  save() {
    try {
      const speakers = this.order.map((id) => {
        const m = this.meta.get(id), st = this.sp(id).state;
        return { id, name: m.name, color: m.color, snd: m.soundId, position: st.position, aim: st.aim, autoAim: m.autoAim, directional: st.directional,
          innerAngle: st.innerAngle, outerAngle: st.outerAngle, outerGain: st.outerGain, volume: st.volume, muted: st.muted, loop: st.loop, orbit: m.orbit };
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ global: this.global, speakers }));
    } catch { /* storage unavailable */ }
  }
  loadSaved() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!data?.speakers?.length) return false;
      Object.assign(this.global, data.global);
      for (const s of data.speakers) this.addSpeaker(s);
      this.select(this.order[0]);
      return true;
    } catch { return false; }
  }
}

new App().init().catch((e) => { console.error(e); document.getElementById('loading').textContent = `Failed to start: ${e.message}`; });
