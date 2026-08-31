"""Check review-history / pipeline state. Run: py .img2threejs/check_state.py"""
import json
from pathlib import Path

spec = json.loads(Path(r"C:\Users\punko\Downloads\pominigames\.img2threejs\object-sculpt-spec.json").read_text(encoding="utf-8"))
rh = spec.get("reviewHistory", [])
print("review entries:", len(rh))
for r in rh[-3:]:
    print(" -", r.get("passId"), "| action:", r.get("action"),
          "| score:", r.get("aiVisionScore") or r.get("visionScore"))
print("completed:", spec.get("sculptPipeline", {}).get("completedPasses"))
print("currentPass:", spec.get("sculptPipeline", {}).get("currentPass"))
print("lastCompleted:", spec.get("sculptPipeline", {}).get("lastCompletedPass"))
