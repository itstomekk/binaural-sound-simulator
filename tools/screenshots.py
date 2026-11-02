"""Takes the README screenshots into docs/screenshots/ (Firefox via Playwright).

Run from a clean directory:  C:\\Python314\\python.exe tools/screenshots.py [url]
Default url is the local index.html.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "docs" / "screenshots"
out.mkdir(parents=True, exist_ok=True)
url = sys.argv[1] if len(sys.argv) > 1 else (root / "index.html").as_uri()

def setrange(page, k, v):
    page.evaluate("""([k, v]) => { const el = document.querySelector('.card.open [data-k="'+k+'"]'); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); }""", [k, v])

with sync_playwright() as p:
    b = p.firefox.launch(firefox_user_prefs={"media.autoplay.default": 0, "media.autoplay.blocking_policy": 0})
    page = b.new_page(viewport={"width": 1400, "height": 860})
    page.goto(url)
    page.wait_for_selector("#loading", state="detached", timeout=30000)
    page.evaluate("localStorage.clear()")

    def preset(key):
        page.select_option("#preset", key)
        page.wait_for_timeout(500)

    # 1. axis test, 3D view
    preset("axis")
    page.evaluate("window.__app.select(window.__app.order[1])")
    page.click("#play-all"); page.wait_for_timeout(900)
    page.screenshot(path=str(out / "01-axis-test.png"))
    page.click("#stop-all")

    # 2. directional speakers: one faces the listener, one faces away
    page.evaluate("""() => {
      const a = window.__app; a.stopAll(); a.clearAll();
      a.addSpeaker({ name: 'Facing you', snd: 'voice-hello-en', az: -45, el: 0, d: 4, directional: true, innerAngle: 40, outerAngle: 140, autoAim: true });
      const p = window.__app.engine.speakers.values().next().value;
      a.addSpeaker({ name: 'Facing away', snd: 'voice-hello-pl', az: 55, el: 0, d: 4, directional: true, innerAngle: 40, outerAngle: 140, autoAim: false, aim: [4.6 * Math.sin(55 * Math.PI / 180), 0, -4.6 * Math.cos(55 * Math.PI / 180)] });
      a.select(a.order[0]); a.renderList();
    }""")
    page.click('[data-view="top"]')
    page.click('[data-mode="rotate"]')
    page.wait_for_timeout(500)
    page.screenshot(path=str(out / "02-directional-speaker.png"))
    page.click('[data-mode="translate"]')

    # 3. top view of the distance ladder
    preset("distance")
    page.click('[data-view="top"]')
    page.click("#play-all"); page.wait_for_timeout(700)
    page.screenshot(path=str(out / "03-distance-top-view.png"))
    page.click("#stop-all")

    # 4. circle of 8 from the side + sound settings open
    preset("circle")
    page.evaluate("document.querySelector('details').open = true")
    page.click('[data-view="perspective"]')
    page.evaluate("window.__app.select(window.__app.order[2])")
    page.wait_for_timeout(400)
    page.screenshot(path=str(out / "04-circle-and-settings.png"))
    b.close()
print("done", out)
