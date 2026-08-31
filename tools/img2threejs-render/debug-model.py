#!/usr/bin/env python3
"""Debug variant - directly load the harness + chair model and dump console."""
from pathlib import Path
import http.server, socketserver, threading, time
from playwright.sync_api import sync_playwright

WORKSPACE = Path(r"C:\Users\punko\Downloads\pominigames").resolve()

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WORKSPACE), **k)
    def log_message(self, *a, **k):
        pass

httpd = socketserver.TCPServer(("127.0.0.1", 4714), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.2)

with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 800, "height": 800})
    page = ctx.new_page()
    msgs = []
    page.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: msgs.append(f"[pageerror] {e}"))
    page.on("requestfailed", lambda r: msgs.append(f"[reqfail] {r.url}"))
    url = "http://127.0.0.1:4714/tools/img2threejs-render/index.html?model=/src/PoMiniGames.Client/wwwroot/games/pogallery/models/chair/index.js"
    print("navigating to:", url)
    try:
        page.goto(url, wait_until="load", timeout=20000)
    except Exception as e:
        print("goto:", e)
    time.sleep(4)
    print("ready:", page.evaluate("window.__modelReady"))
    err = page.evaluate("document.getElementById('err') ? document.getElementById('err').textContent : 'no err div'")
    print("err:", err)
    print("--- console ---")
    for m in msgs[-40:]:
        print(m)
    page.screenshot(path=".img2threejs/debug-model.png")
    b.close()
httpd.shutdown()
httpd.server_close()
