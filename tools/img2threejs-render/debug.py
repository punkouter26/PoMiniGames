#!/usr/bin/env python3
"""Debug variant of render.py — dumps page content, console, and error state on timeout."""
from __future__ import annotations
import http.server
import socketserver
import sys
import threading
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
HARNESS = ROOT / "index.html"
PORT = 4712

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=str(ROOT), **k)
    def log_message(self, *a, **k): pass

httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.2)

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 800, "height": 800})
    page = ctx.new_page()
    msgs = []
    page.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: msgs.append(f"[pageerror] {e}"))
    page.on("requestfailed", lambda r: msgs.append(f"[reqfail] {r.url} {r.failure}"))
    page.on("response", lambda r: msgs.append(f"[resp {r.status}] {r.url}") if r.status >= 400 else None)

    target = f"http://127.0.0.1:{PORT}/index.html?model=http://127.0.0.1:{PORT}/examples/placeholder-cube.js"
    print("navigating to:", target)
    try:
        page.goto(target, wait_until="load", timeout=15000)
    except Exception as e:
        print("goto error:", e)
    time.sleep(3)  # let everything settle

    print("\n=== console / errors ===")
    for m in msgs:
        print(m)
    print("\n=== ready flag ===")
    print("__modelReady =", page.evaluate("window.__modelReady"))
    print("\n=== err div ===")
    print(page.evaluate("document.getElementById('err')?.textContent || ''"))
    print("\n=== head of body ===")
    print(page.evaluate("document.body.innerText.slice(0, 500)"))
    print("\n=== screenshot ===")
    page.screenshot(path=".img2threejs/debug.png")
    print("OK")

    browser.close()
httpd.shutdown()
httpd.server_close()