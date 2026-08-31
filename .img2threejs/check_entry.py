"""Dump the last review entry's keys and visualEvidence. Run: py .img2threejs/check_entry.py"""
import json
from pathlib import Path

spec = json.loads(Path(r"C:\Users\punko\Downloads\pominigames\.img2threejs\object-sculpt-spec.json").read_text(encoding="utf-8"))
entry = spec["reviewHistory"][-1]
print("keys:", sorted(entry.keys()))
ve = entry.get("visualEvidence")
print("visualEvidence:", json.dumps(ve, indent=1)[:800] if ve else None)
for k in ("renderScreenshot", "render-screenshot", "mapStrippedRender", "aiVisionScore", "action", "passId"):
    print(k, "->", str(entry.get(k))[:100])
