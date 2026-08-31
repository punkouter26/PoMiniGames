"""Add top-level normal/bump responses to each material (material-pass gate).

Run: py .img2threejs/fix_normals.py
"""
from pathlib import Path

P = Path(r"C:\Users\punko\Downloads\pominigames\.img2threejs\patch_spec.py")
c = P.read_text(encoding="utf-8")

# Anchor on each material's roughness line (top-level) and add normal+bump after it.
subs = [
    (
        '"roughness": {"base": 0.85, "variation": 0.05,\n'
        '                          "map": GENERATED_DIR + r"\\upholstery_roughness.png"},'
        .replace("\\\\", "\\"),
        '"roughness": {"base": 0.85, "variation": 0.05,\n'
        '                          "map": GENERATED_DIR + r"\\upholstery_roughness.png"},\n'
        '            "normal": {"strength": 0.4},\n'
        '            "bump": {"amplitude": 0.35, "map": GENERATED_DIR + r"\\upholstery_height.png"},',
    ),
    (
        '"roughness": {"base": 0.30, "variation": 0.05,\n'
        '                          "map": GENERATED_DIR + r"\\frame_roughness.png"},'
        .replace("\\\\", "\\"),
        '"roughness": {"base": 0.30, "variation": 0.05,\n'
        '                          "map": GENERATED_DIR + r"\\frame_roughness.png"},\n'
        '            "normal": {"strength": 0.2},\n'
        '            "bump": {"amplitude": 0.15, "map": GENERATED_DIR + r"\\frame_height.png"},',
    ),
    (
        '"roughness": {"base": 0.9, "variation": 0.02,\n'
        '                          "map": GENERATED_DIR + r"\\glides_roughness.png"}'
        .replace("\\\\", "\\"),
        '"roughness": {"base": 0.9, "variation": 0.02,\n'
        '                          "map": GENERATED_DIR + r"\\glides_roughness.png"},\n'
        '            "normal": {"strength": 0.1},\n'
        '            "bump": {"amplitude": 0.08, "map": GENERATED_DIR + r"\\glides_height.png"},',
    ),
]

for old, new in subs:
    if old in c:
        c = c.replace(old, new, 1)
        print("patched:", old.split('"')[1][:20])
    else:
        print("NOT FOUND:", old[:80].replace("\n", "\\n"))

P.write_text(c, encoding="utf-8")
print("done")
