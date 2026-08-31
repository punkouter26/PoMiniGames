#!/usr/bin/env python3
"""Capture a screenshot of a running URL via Playwright."""
import argparse
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("out")
    p.add_argument("--wait-ms", type=int, default=2500)
    args = p.parse_args()
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        try:
            page.goto(args.url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(args.wait_ms)
            page.screenshot(path=args.out, full_page=True)
        finally:
            ctx.close(); b.close()
    size = Path(args.out).stat().st_size
    print(f"OK  {args.out}  ({size} bytes)")

if __name__ == "__main__":
    sys.exit(main())
