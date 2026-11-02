# Binaural Sound Simulator: development notes

## Layout

- `src/engine.js`: audio engine (Web Audio API). No DOM, no Three.js. Takes any `BaseAudioContext`, so it also runs offline for tests.
- `src/sounds.js`: sound library. Synthesised built-ins, bundled voice clips, user uploads. All buffers are mono.
- `src/scene.js`: Three.js view with OrbitControls and TransformControls. No audio code.
- `src/app.js`: wiring, control panel, presets, localStorage persistence.
- `src/voices.generated.js`: base64 mp3 voice clips. Generated, do not edit.
- `dist/app.js`: esbuild bundle (classic script), so `index.html` works from `file://`.
- `tests/`: engine test (offline audio rendering) and UI test (Playwright, Firefox).
- `tools/`: voice clip generation (Windows SAPI voices to mp3).

## Commands

```
npm install
npm run build          # node build.mjs, rebuild dist/app.js after editing src/
npm test               # engine tests; run from a clean directory with C:\Python314\python.exe
C:\Python314\python.exe tests\ui_test.py    # UI test, screenshots in tests/out/
C:\Python314\python.exe tools\gen_voices.ps1 # see below
```

Screenshots for the README: `python tools/screenshots.py` (writes `docs/screenshots/`).

Deploy: GitHub Pages serves the repo root from `main`, so commit the rebuilt `dist/app.js` with every change to `src/`.

Voices: `powershell -File tools/gen_voices.ps1`, then `python tools/build_voices.py` (needs ffmpeg).

## Audio engine

Coordinates: +X right, +Y up, -Z forward (Web Audio convention). Metres. Listener fixed at the origin.

Per speaker: `source -> trim gain -> lowpass -> delay -> PannerNode(HRTF) -> master`.

- `PannerNode` gives HRTF direction, inverse-distance gain (`refDistance` 1 m) and the sound cone.
- Delay node adds distance / 343 m/s. Changing it while playing causes a Doppler-like glide.
- Lowpass models air absorption (cutoff = 20 kHz * exp(-d/50 m)) and, for directional speakers, off-axis loss. This is an approximation, not a measured curve.
- Directional off sets cone angles to 360/360. On uses the speaker's inner/outer angle and outer gain.
- The `trim` node forces mono input, so stereo files are downmixed before HRTF processing.

HRTF data is the browser's built-in set and is not personalised. Chrome and Firefox sound slightly different.

## Tests

`tests/engine.test.html` renders noise through `OfflineAudioContext` and measures: level and timing difference between ears, high-frequency balance for front/behind and above/below (plus an equal-power control that must not show it), inverse-distance gain, travel-time delay, air absorption, cone behaviour.

## Roadmap

1. Walls and reflections (image-source or ray-based early reflections, reverb tail).
2. Possibly a dedicated spatial-audio library or custom HRTF (SOFA) loading.
3. Listener head rotation or head tracking.
4. Moving sources along paths, saved scenes, export to a binaural WAV.
