#!/usr/bin/env python3
"""
img2threejs render driver — Playwright wrapper for the harness in index.html.

Usage:
    py tools/img2threejs-render/render.py <model.js-or-url> <out.png> [extra-query]

Exit codes:
    0   render succeeded, PNG written
    1   harness error (load fail, JS exception, ready signal never set)
    2   usage error
"""
from __future__ import annotations

import argparse
import http.server
import socketserver
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent                       # tools/img2threejs-render/
WORKSPACE = ROOT.parent.parent                               # c:/.../pominigames/
DEFAULT_PORT = 4711


def serve_once(directory: Path, port: int) -> socketserver.TCPServer:
    """Serve a directory on a free port for the duration of one render."""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, *_args, **_kwargs):
            pass  # silence stdout noise

    httpd = socketserver.TCPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def url_for(file_path: Path, port: int) -> str:
    """Map an absolute file path to a URL served by serve_once(WORKSPACE, port)."""
    rel = file_path.resolve().relative_to(WORKSPACE.resolve()).as_posix()
    return f"http://127.0.0.1:{port}/{rel}"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("model", help="Model file path or http(s) URL")
    p.add_argument("out", help="Output PNG path")
    p.add_argument("extra_query", nargs="?", default="",
                   help="Optional extra query string, e.g. 'distance=3.0&azimuth=20'")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="Local HTTP port")
    p.add_argument("--timeout-ms", type=int, default=30000, help="Render timeout")
    args = p.parse_args()

    extra = args.extra_query.strip("?&")
    model_arg = args.model

    # Always serve the workspace root so both /tools/img2threejs-render/index.html and
    # /src/.../model.js are reachable from one HTTP origin.
    httpd = serve_once(WORKSPACE, args.port)
    time.sleep(0.2)

    if model_arg.startswith("http://") or model_arg.startswith("https://"):
        model_part = model_arg
    else:
        model_path = Path(model_arg).resolve()
        if not model_path.exists():
            print(f"ERROR: model file not found: {model_path}", file=sys.stderr)
            httpd.shutdown(); httpd.server_close()
            return 2
        if WORKSPACE not in model_path.parents and model_path != WORKSPACE:
            print(f"ERROR: model must live under workspace root {WORKSPACE}", file=sys.stderr)
            httpd.shutdown(); httpd.server_close()
            return 2
        model_part = url_for(model_path, args.port)

    harness_url = url_for(ROOT / "index.html", args.port) + f"?model={model_part}"
    if extra:
        harness_url += f"&{extra}"

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--no-sandbox"])
            ctx = browser.new_context(viewport={"width": 800, "height": 800}, device_scale_factor=1)
            page = ctx.new_page()
            console_lines: list[str] = []
            page.on("console", lambda m: console_lines.append(f"[{m.type}] {m.text}"))
            page.on("pageerror", lambda e: console_lines.append(f"[pageerror] {e}"))
            try:
                page.goto(harness_url, wait_until="load", timeout=args.timeout_ms)
                # Give the harness's <script type="module"> a moment to start;
                # otherwise wait_for_function may race with module evaluation.
                page.wait_for_timeout(500)
                page.wait_for_function(
                    "window.__modelReady === true || window.__modelReady === false",
                    timeout=args.timeout_ms,
                )
                # Read the flag AFTER the function resolves, with a small settle.
                page.wait_for_timeout(200)
                ready = page.evaluate("window.__modelReady")
                if not ready:
                    err_text = page.evaluate(
                        "document.getElementById('err')?.textContent || ''"
                    )
                    print(f"ERROR: harness reported load failure: {err_text}",
                          file=sys.stderr)
                    print("--- console ---", file=sys.stderr)
                    for line in console_lines[-40:]:
                        print(line, file=sys.stderr)
                    return 1
                page.wait_for_timeout(120)  # one more frame for any post-load settle
                page.screenshot(path=str(out_path), full_page=False, omit_background=False)
            finally:
                ctx.close()
                browser.close()
    finally:
        httpd.shutdown()
        httpd.server_close()

    size = out_path.stat().st_size if out_path.exists() else 0
    print(f"OK  {out_path}  ({size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
