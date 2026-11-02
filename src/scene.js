// Binaural Room — 3D view (Three.js). Draws the listener and speakers, lets you drag and aim them.
// Knows nothing about audio; talks to the app through callbacks.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

const FORWARD = new THREE.Vector3(0, 0, -1);

function textSprite(text, { color = '#ffffff', size = 0.5, bg = false } = {}) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(size * 4, size, 1);
  s.renderOrder = 10;
  s.userData.canvas = c;
  setSpriteText(s, text, color, bg);
  return s;
}
function setSpriteText(sprite, text, color = '#ffffff', bg = false) {
  const c = sprite.userData.canvas, g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.font = '600 56px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (bg) { g.fillStyle = 'rgba(10,12,18,0.65)'; g.beginPath(); g.roundRect(8, 16, 496, 96, 24); g.fill(); }
  g.fillStyle = color;
  g.fillText(text.length > 16 ? text.slice(0, 15) + '…' : text, 256, 66);
  sprite.material.map.needsUpdate = true;
}

export class RoomView {
  /**
   * @param {HTMLElement} container
   * @param {{onSelect:(id:string|null)=>void, onChange:(id:string, position:number[], aim:number[])=>void}} cb
   */
  constructor(container, cb) {
    this.cb = cb;
    this.container = container;
    this.speakers = new Map();
    this.selectedId = null;
    this.mode = 'translate';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1018);
    this.scene.fog = new THREE.Fog(0x0d1018, 40, 90);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 300);
    this.camera.position.set(6.5, 5, 9);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.minDistance = 1.2;
    this.orbit.maxDistance = 60;

    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a1d29, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 8, 5);
    this.scene.add(sun);

    this._buildStage();
    this._buildListener();

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.8);
    this.transform.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !e.value; this.dragging = e.value; });
    this.transform.addEventListener('objectChange', () => this._emitChange());
    this.scene.add(this.transform.getHelper());

    this.raycaster = new THREE.Raycaster();
    this._pointerDown = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this._pointerDown = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => this._onPointerUp(e));

    this.clock = new THREE.Clock();
    this.playing = new Set();
    this.onFrame = null;
    this._resize();
    new ResizeObserver(() => this._resize()).observe(container);
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _buildStage() {
    const stage = new THREE.Group();
    this.rings = stage;
    const ringMat = new THREE.LineBasicMaterial({ color: 0x3a4766, transparent: true, opacity: 0.8 });
    for (const r of [1, 2, 4, 8, 16]) {
      const pts = [];
      for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
      stage.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
      const label = textSprite(`${r} m`, { color: '#7f8db0', size: 0.28 });
      label.position.set(r * 0.7071, 0.02, r * 0.7071);
      stage.add(label);
    }
    const axisMat = new THREE.LineBasicMaterial({ color: 0x2c3652 });
    for (const [a, b] of [[[-18, 0, 0], [18, 0, 0]], [[0, 0, -18], [0, 0, 18]]]) {
      stage.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), axisMat));
    }
    stage.add(new THREE.Mesh(new THREE.SphereGeometry(2, 24, 16), new THREE.MeshBasicMaterial({ color: 0x2b3a66, wireframe: true, transparent: true, opacity: 0.18 })));
    const mk = (t, x, y, z, color) => { const s = textSprite(t, { color, size: 0.5 }); s.position.set(x, y, z); stage.add(s); };
    mk('FRONT', 0, 0.15, -4.6, '#9fe3b0'); mk('BEHIND', 0, 0.15, 4.6, '#e3a39f');
    mk('LEFT', -4.6, 0.15, 0, '#9fc4ff'); mk('RIGHT', 4.6, 0.15, 0, '#ffb29f');
    mk('UP', 0, 4.2, 0, '#e6e6a0');
    stage.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 4, 0)]), new THREE.LineBasicMaterial({ color: 0x4a5a85, transparent: true, opacity: 0.6 })));
    this.scene.add(stage);
  }

  _buildListener() {
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9b38c, roughness: 0.7 });
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 24), skin));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 16), skin);
    nose.rotation.x = -Math.PI / 2; nose.position.set(0, -0.01, -0.26);
    g.add(nose);
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 20), new THREE.MeshStandardMaterial({ color: side < 0 ? 0x4b8bff : 0xff6b4b, roughness: 0.5 }));
      ear.rotation.z = Math.PI / 2; ear.position.set(side * 0.225, 0, 0);
      g.add(ear);
      const t = textSprite(side < 0 ? 'L' : 'R', { color: side < 0 ? '#7fb0ff' : '#ff9a82', size: 0.25 });
      t.position.set(side * 0.5, 0.05, 0);
      g.add(t);
    }
    const you = textSprite('YOU', { color: '#f3e3cf', size: 0.3 });
    you.position.set(0, 0.55, 0);
    g.add(you);
    this.scene.add(g);
    this.listener = g;
  }

  addSpeaker(id, state, color, name) {
    const group = new THREE.Group();
    group.userData.id = id;
    const col = new THREE.Color(color);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.3), new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, metalness: 0.15 }));
    body.userData.pick = id;
    group.add(body);
    const dark = new THREE.MeshStandardMaterial({ color: 0x15171f, roughness: 0.8 });
    const woofer = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24), dark);
    woofer.rotation.y = Math.PI; woofer.position.set(0, -0.06, -0.151);
    group.add(woofer);
    const tweeter = new THREE.Mesh(new THREE.CircleGeometry(0.045, 20), dark);
    tweeter.rotation.y = Math.PI; tweeter.position.set(0, 0.16, -0.151);
    group.add(tweeter);
    const pulse = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.31, 40), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    pulse.visible = false;
    group.add(pulse);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.38, 0.54, 0.34)), new THREE.LineBasicMaterial({ color: 0xffffff }));
    edges.visible = false;
    group.add(edges);
    const cones = new THREE.Group(); cones.visible = false; group.add(cones);
    const label = textSprite(name, { size: 0.3, bg: true });
    label.position.set(0, 0.85, 0);
    group.add(label);

    // guide lines live in world space: drop line to the floor, dot on the floor, line to listener
    const guide = new THREE.Group();
    const vLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.45 }));
    const lLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: col, transparent: true, opacity: 0.35, dashSize: 0.12, gapSize: 0.1 }));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.1, 20), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    dot.rotation.x = -Math.PI / 2;
    guide.add(vLine, lLine, dot);
    this.scene.add(guide);
    this.scene.add(group);

    this.speakers.set(id, { group, body, pulse, edges, cones, label, guide, vLine, lLine, dot, color: col, name, coneKey: '' });
    this.updateSpeaker(id, state);
  }

  removeSpeaker(id) {
    const e = this.speakers.get(id);
    if (!e) return;
    if (this.selectedId === id) this.select(null, true);
    this.scene.remove(e.group); this.scene.remove(e.guide);
    for (const root of [e.group, e.guide]) root.traverse((o) => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
    this.speakers.delete(id);
    this.playing.delete(id);
  }

  renameSpeaker(id, name) {
    const e = this.speakers.get(id);
    if (!e) return;
    e.name = name; setSpriteText(e.label, name, '#ffffff', true);
  }

  /** Push position/aim/directionality from state into the mesh. */
  updateSpeaker(id, st) {
    const e = this.speakers.get(id);
    if (!e) return;
    e.group.position.set(...st.position);
    e.group.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(...st.aim).normalize());
    this._updateCones(e, st);
    this._updateGuides(e);
    if (this.selectedId === id) this.transform.updateMatrixWorld?.();
  }

  _updateCones(e, st) {
    e.cones.visible = !!st.directional;
    if (!st.directional) return;
    const key = `${st.innerAngle}|${st.outerAngle}`;
    if (key === e.coneKey) return;
    e.coneKey = key;
    while (e.cones.children.length) { const c = e.cones.children[0]; c.geometry.dispose(); c.material.dispose(); e.cones.remove(c); }
    const L = 2.2;
    const mk = (fullAngle, color, opacity) => {
      const half = (Math.min(fullAngle / 2, 85) * Math.PI) / 180;
      const geo = new THREE.ConeGeometry(Math.tan(half) * L, L, 40, 1, true);
      geo.translate(0, -L / 2, 0); geo.rotateX(Math.PI / 2); // apex at origin, opening toward -Z
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
      m.position.z = -0.15;
      return m;
    };
    e.cones.add(mk(st.outerAngle, 0xffc857, 0.08), mk(st.innerAngle, 0x6dffb0, 0.16));
  }

  _updateGuides(e) {
    const p = e.group.position;
    e.vLine.geometry.setFromPoints([new THREE.Vector3(p.x, 0, p.z), p.clone()]);
    e.lLine.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), p.clone()]);
    e.lLine.computeLineDistances();
    e.dot.position.set(p.x, 0.005, p.z);
  }

  select(id, silent = false) {
    this.selectedId = id;
    for (const [sid, e] of this.speakers) e.edges.visible = sid === id;
    if (id && this.speakers.has(id)) this.transform.attach(this.speakers.get(id).group);
    else this.transform.detach();
    if (!silent) this.cb.onSelect(id);
  }

  setMode(mode) { // 'translate' | 'rotate'
    this.mode = mode;
    this.transform.setMode(mode);
    this.transform.setSpace(mode === 'rotate' ? 'local' : 'world');
  }

  setPlaying(id, on) { on ? this.playing.add(id) : this.playing.delete(id); }
  setRingsVisible(v) { this.rings.visible = v; }

  _emitChange() {
    const e = this.speakers.get(this.selectedId);
    if (!e) return;
    const p = e.group.position;
    const aim = FORWARD.clone().applyQuaternion(e.group.quaternion);
    this.cb.onChange(this.selectedId, [p.x, p.y, p.z], [aim.x, aim.y, aim.z]);
    this._updateGuides(e);
  }

  _onPointerUp(ev) {
    const d = this._pointerDown;
    this._pointerDown = null;
    if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4 || this.dragging) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects([...this.speakers.values()].map((s) => s.body), false)[0];
    if (hit) this.select(hit.object.userData.pick);
  }

  setView(name) {
    const views = {
      perspective: [[6.5, 5, 9], [0, 0, 0]],
      top: [[0, 22, 0.001], [0, 0, 0]],
      side: [[20, 1, 0], [0, 0, 0]],
      behind: [[0, 1.4, 9], [0, 0, 0]],
    };
    const v = views[name] || views.perspective;
    this.camera.position.set(...v[0]);
    this.orbit.target.set(...v[1]);
    this.orbit.update();
  }

  /** Project a world point to screen pixels (for tests). */
  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _frame() {
    const dt = this.clock.getDelta(), t = this.clock.elapsedTime;
    this.orbit.update();
    for (const [id, e] of this.speakers) {
      const on = this.playing.has(id);
      e.pulse.visible = on;
      if (on) {
        const k = (t * 1.6) % 1;
        e.pulse.scale.setScalar(1 + k * 1.4);
        e.pulse.material.opacity = 0.7 * (1 - k);
        e.pulse.quaternion.copy(e.group.quaternion).invert().multiply(this.camera.quaternion);
      }
    }
    this.onFrame?.(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
