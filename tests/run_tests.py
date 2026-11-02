"""Runs tests/engine.test.html in Firefox (Playwright) against a local static server.

Run from a clean directory with C:\\Python314\\python.exe (see npm run test).
"""
import functools
import http.server
import pathlib
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

with sync_playwright() as p:
    b = p.firefox.launch()
    page = b.new_page()
    page.on("console", lambda m: print("console:", m.text) if m.type == "error" else None)
    page.goto(f"http://127.0.0.1:{port}/tests/engine.test.html")
    page.wait_for_function("window.__done === true", timeout=120000)
    res = page.evaluate("window.__results")
    b.close()

bad = 0
for r in res:
    print("PASS " if r["ok"] else "FAIL ", r["name"], "-", r["detail"])
    bad += not r["ok"]
print(f"\n{len(res) - bad}/{len(res)} passed")
sys.exit(1 if bad else 0)
