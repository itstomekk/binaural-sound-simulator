"""End-to-end UI test: opens dist build from file:// in Firefox, drives the controls, checks the audio graph.

Run from a clean directory:  C:\\Python314\\python.exe tests/ui_test.py
Screenshots land in tests/out/.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "tests" / "out"
out.mkdir(exist_ok=True)
url = (root / "index.html").as_uri()

fails = []
def check(name, ok, detail=""):
    print("PASS " if ok else "FAIL ", name, "-", detail)
    if not ok:
        fails.append(name)

with sync_playwright() as p:
    b = p.firefox.launch(firefox_user_prefs={"media.autoplay.default": 0, "media.autoplay.blocking_policy": 0})
    page = b.new_page(viewport={"width": 1400, "height": 850})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_selector("#loading", state="detached", timeout=30000)
    page.wait_for_timeout(500)

    n = page.evaluate("window.__app.engine.speakers.size")
    check("starts with the 2 welcome speakers", n == 2, str(n))
    page.screenshot(path=str(out / "01-start.png"))

    # sound library
    n_sounds = page.evaluate("window.__app.lib.items.size")
    check("sound library has built-ins + 8 voices", n_sounds == 15, str(n_sounds))

    # add speaker
    page.click("#add")
    check("add speaker", page.evaluate("window.__app.engine.speakers.size") == 3)
    sel = page.evaluate("window.__app.selectedId")

    # azimuth/elevation/distance sliders -> engine position
    def setrange(k, v):
        page.evaluate("""([k, v]) => { const el = document.querySelector('.card.open [data-k="'+k+'"]'); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); }""", [k, v])
    setrange("az", 90); setrange("el", 0); setrange("dist", 500)  # 500/1000 on log scale => sqrt(0.25*50)=3.54 m
    pos = page.evaluate(f"window.__app.sp('{sel}').panner.positionX.value + ',' + window.__app.sp('{sel}').panner.positionY.value + ',' + window.__app.sp('{sel}').panner.positionZ.value")
    x, y, z = map(float, pos.split(","))
    check("sliders place speaker to the right at ~3.5 m", abs(x - 3.54) < 0.1 and abs(y) < 1e-6 and abs(z) < 0.1, pos)
    setrange("el", 90); setrange("dist", 400)
    pos = page.evaluate(f"[window.__app.sp('{sel}').panner.positionX.value, window.__app.sp('{sel}').panner.positionY.value]")
    check("elevation 90 puts speaker straight up", pos[1] > 2 and abs(pos[0]) < 0.01, str(pos))
    setrange("el", 30); setrange("az", -45)

    # directional toggle
    cone = lambda: page.evaluate(f"(() => {{ const p = window.__app.sp('{sel}').panner; return [p.coneInnerAngle, p.coneOuterAngle, p.coneOuterGain]; }})()")
    check("omni by default (cone 360/360)", cone()[:2] == [360, 360], str(cone()))
    page.click('.card.open [data-k="directional"]')
    c = cone()
    check("directional on sets cone 60/200", c[0] == 60 and c[1] == 200 and 0.07 < c[2] < 0.09, str(c))
    setrange("inner", 90)
    check("inner angle slider updates cone", cone()[0] == 90, str(cone()))
    page.click('.card.open [data-act="aim-away"]')
    aim = page.evaluate(f"window.__app.sp('{sel}').state.aim")
    pp = page.evaluate(f"window.__app.sp('{sel}').state.position")
    import math
    dot = sum(a * q for a, q in zip(aim, pp)) / math.hypot(*pp)
    check("'Face away' aims along outward direction", dot > 0.999, f"dot={dot:.4f}")
    check("off-axis readout ~180 deg", abs(page.evaluate(f"window.__app.sp('{sel}').info.offAxis") - 180) < 1)
    page.click('.card.open [data-act="aim-me"]')
    check("'Aim at me' off-axis ~0", page.evaluate(f"window.__app.sp('{sel}').info.offAxis") < 1)
    page.click('.card.open [data-k="directional"]')
    check("directional off restores omni", cone()[:2] == [360, 360])
    page.click('.card.open [data-k="directional"]')
    page.screenshot(path=str(out / "02-directional.png"))

    # drag speaker in the 3D view (top view): project speaker position and drag by 120px
    page.click('[data-view="top"]'); page.wait_for_timeout(300)
    page.click('[data-mode="translate"]')
    before = page.evaluate(f"window.__app.sp('{sel}').state.position")
    pt = page.evaluate(f"(() => {{ const p = window.__app.sp('{sel}').state.position; return window.__app.view.project(...p); }})()")
    page.mouse.click(pt["x"], pt["y"]); page.wait_for_timeout(200)
    check("clicking the speaker selects it", page.evaluate("window.__app.selectedId") == sel)
    # grab the X axis arrow of the gizmo: it sits to the right of the speaker
    page.mouse.move(pt["x"] + 45, pt["y"]); page.mouse.down(); page.mouse.move(pt["x"] + 110, pt["y"], steps=8); page.mouse.up()
    page.wait_for_timeout(300)
    after = page.evaluate(f"window.__app.sp('{sel}').state.position")
    check("dragging gizmo moves speaker in x", abs(after[0] - before[0]) > 0.3, f"{before} -> {after}")
    check("slider readout follows the drag", abs(page.evaluate("window.__app.meta.get('%s').sph.az" % sel)) > 0)
    page.screenshot(path=str(out / "03-top-drag.png"))

    # rotate mode
    page.click('[data-view="perspective"]'); page.click('[data-mode="rotate"]'); page.wait_for_timeout(300)
    page.screenshot(path=str(out / "04-rotate.png"))
    page.click('[data-mode="translate"]')

    # presets
    page.select_option("#preset", "axis"); page.wait_for_timeout(500)
    n = page.evaluate("window.__app.engine.speakers.size")
    check("axis preset makes 6 speakers", n == 6, str(n))
    page.click('[data-view="perspective"]')
    page.screenshot(path=str(out / "05-axis-preset.png"))
    names = page.evaluate("[...window.__app.meta.values()].map(m => m.name + ':' + Math.round(m.sph.az) + '/' + Math.round(m.sph.el))")
    print("   axis:", names)

    # playback
    page.click("#play-all"); page.wait_for_timeout(1200)
    state = page.evaluate("window.__app.ctx.state")
    playing = page.evaluate("[...window.__app.engine.speakers.values()].filter(s => s.playing).length")
    check("play all starts 6 sources", playing == 6, f"ctx={state}, playing={playing}")
    page.screenshot(path=str(out / "06-playing.png"))
    page.click("#stop-all")
    check("stop all", page.evaluate("[...window.__app.engine.speakers.values()].filter(s => s.playing).length") == 0)

    # global settings
    page.evaluate("document.querySelector('details').open = true")
    page.select_option("#model", "equalpower")
    check("model switch applies", page.evaluate("[...window.__app.engine.speakers.values()].every(s => s.panner.panningModel === 'equalpower')"))
    page.select_option("#model", "HRTF")

    # mute / solo / delete
    page.click('.card:nth-child(2) [data-act="mute"]')
    check("mute zeroes trim gain", page.evaluate("[...window.__app.engine.speakers.values()][1].trim.gain.value") == 0)
    page.click('.card:nth-child(1) [data-act="solo"]')
    check("solo silences the others", page.evaluate("[...window.__app.engine.speakers.values()][2].trim.gain.value") == 0)
    page.click('.card:nth-child(1) [data-act="solo"]')
    page.click('.card:nth-child(6) [data-act="del"]')
    check("delete removes speaker", page.evaluate("window.__app.engine.speakers.size") == 5)

    # persistence
    page.wait_for_timeout(600)
    saved = page.evaluate("JSON.parse(localStorage.getItem('binaural-room-v1')).speakers.length")
    check("scene saved to localStorage", saved == 5, str(saved))
    page.reload(); page.wait_for_selector("#loading", state="detached", timeout=30000)
    check("scene restored after reload", page.evaluate("window.__app.engine.speakers.size") == 5)

    # upload a wav
    import wave, struct
    wavp = out / "tone.wav"
    with wave.open(str(wavp), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100)
        frames = b"".join(struct.pack("<hh", int(8000 * math.sin(2 * math.pi * 440 * i / 44100)), int(8000 * math.sin(2 * math.pi * 660 * i / 44100))) for i in range(44100))
        w.writeframes(frames)
    page.set_input_files("#file", str(wavp)); page.wait_for_timeout(800)
    snd = page.evaluate("[...window.__app.lib.items.values()].filter(i => i.kind === 'upload').map(i => i.label + ' ch=' + i.buffer.numberOfChannels)")
    check("uploaded stereo file is downmixed to mono", snd == ["File: tone.wav ch=1"], str(snd))
    check("uploaded sound assigned to selected speaker", page.evaluate("window.__app.meta.get(window.__app.selectedId).soundId") == "file-1")

    check("no console errors", not errors, "; ".join(errors[:5]))
    b.close()

print(f"\n{'ALL PASS' if not fails else 'FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
