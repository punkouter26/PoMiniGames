"""One-shot spec fix: promote the four legs to macro level with sled-curve tube geometry.

Run from anywhere:  py .img2threejs/fix_legs.py
"""
from pathlib import Path

P = Path(r"C:\Users\punko\Downloads\pominigames\.img2threejs\patch_spec.py")
c = P.read_text(encoding="utf-8")

Q = '"'  # quote helper for readable replacements

# --- front-left: promote to macro + sled tube ---
old_fl = (
    f'id={Q}frame-leg-fl{Q}, parent={Q}frame{Q}, level={Q}meso{Q},'
    '\n            topologyClass="assembled-solid",'
    '\n            topologyRationale="Front-left leg of the sled-base frame: vertical tube from the front cross-rail down to the floor glide.",'
    '\n            transform={"position": [-0.25, 0.21, 0.25], "rotation": [0, 0, 0]},'
    '\n            geometry={"primitive": "cylinder", "size": [0.044, 0.42, 0.044]},'
)
new_fl = (
    f'id={Q}frame-leg-fl{Q}, parent={Q}frame{Q}, level={Q}macro{Q},'
    '\n            topologyClass="assembled-solid",'
    '\n            topologyRationale="Front-left sled leg: single tube curving from the seat rail down and back to the floor runner (cantilever approximation).",'
    '\n            transform={"position": [0, 0, 0], "rotation": [0, 0, 0]},'
    '\n            geometry={"primitive": "tube", "size": [1, 1, 1]},'
    '\n            geometryDescriptor={'
    '\n                "tubePath": {'
    '\n                    "points": [[-0.25, 0.42, 0.25], [-0.25, 0.40, 0.18], [-0.25, 0.24, -0.02], [-0.25, 0.06, -0.18], [-0.25, -0.01, -0.22]],'
    '\n                    "radius": 0.022,'
    '\n                    "closed": False,'
    '\n                }'
    '\n            },'
)
assert old_fl in c, "front-left pattern not found"
c = c.replace(old_fl, new_fl)

# --- front-right ---
old_fr = (
    f'id={Q}frame-leg-fr{Q}, parent={Q}frame{Q}, level={Q}meso{Q},'
    '\n            topologyClass="assembled-solid",'
    '\n            topologyRationale="Front-right leg of the sled-base frame: mirror of frame-leg-fl across the chair centerline.",'
    '\n            transform={"position": [0.25, 0.21, 0.25], "rotation": [0, 0, 0]},'
    '\n            geometry={"primitive": "cylinder", "size": [0.044, 0.42, 0.044]},'
)
new_fr = (
    f'id={Q}frame-leg-fr{Q}, parent={Q}frame{Q}, level={Q}macro{Q},'
    '\n            topologyClass="assembled-solid",'
    '\n            topologyRationale="Front-right sled leg: mirror of frame-leg-fl across the chair centerline.",'
    '\n            transform={"position": [0, 0, 0], "rotation": [0, 0, 0]},'
    '\n            geometry={"primitive": "tube", "size": [1, 1, 1]},'
    '\n            geometryDescriptor={'
    '\n                "tubePath": {'
    '\n                    "points": [[0.25, 0.42, 0.25], [0.25, 0.40, 0.18], [0.25, 0.24, -0.02], [0.25, 0.06, -0.18], [0.25, -0.01, -0.22]],'
    '\n                    "radius": 0.022,'
    '\n                    "closed": False,'
    '\n                }'
    '\n            },'
)
assert old_fr in c, "front-right pattern not found"
c = c.replace(old_fr, new_fr)

# --- rear-left ---
old_rl = (
    f'id={Q}frame-leg-rl{Q}, parent={Q}frame{Q}, level={Q}meso{Q},'
    '\n            topologyClass="assembled-solid",'
    '\n            topologyRationale="Rear-left leg of the sled-base frame: hidden behind seat, mirrored from frame-leg-rr (low confidence).",'
    '\n            transform={"position": [-0.25, 0.21, -0.25], "rotation": [0, 0, 0]},'
    '\n            geometry={"primitive": "cylinder", "size": [0.044, 0.42, 0.044]},'
)
new_rl = (
    f'id={Q}frame-leg-rl{Q}, parent={Q}frame{Q}, level={Q}macro{Q},'
    '\n            topologyClass="assembled-solid",'
    '\n            topologyRationale="Rear-left sled leg: hidden behind seat, mirrored from frame-leg-rr (low confidence, single view).",'
    '\n            transform={"position": [0, 0, 0], "rotation": [0, 0, 0]},'
    '\n            geometry={"primitive": "tube", "size": [1, 1, 1]},'
    '\n            geometryDescriptor={'
    '\n                "tubePath": {'
    '\n                    "points": [[-0.25, 0.42, -0.15], [-0.25, 0.24, -0.24], [-0.25, 0.06, -0.24], [-0.25, -0.01, -0.22]],'
    '\n                    "radius": 0.022,'
    '\n                    "closed": False,'
    '\n                }'
    '\n            },'
)
assert old_rl in c, "rear-left pattern not found"
c = c.replace(old_rl, new_rl)

# --- rear-right ---
old_rr = (
    f'id={Q}frame-leg-rr{Q}, parent={Q}frame{Q}, level={Q}meso{Q},'
    '\n            topologyClass="assembled-solid",'
    '\n            topologyRationale="Rear-right leg of the sled-base frame: visible glimpse through the rear-right of the seat.",'
    '\n            transform={"position": [0.25, 0.21, -0.25], "rotation": [0, 0, 0]},'
    '\n            geometry={"primitive": "cylinder", "size": [0.044, 0.42, 0.044]},'
)
new_rr = (
    f'id={Q}frame-leg-rr{Q}, parent={Q}frame{Q}, level={Q}macro{Q},'
    '\n            topologyClass="assembled-solid",'
    '\n            topologyRationale="Rear-right sled leg: visible glimpse through the rear-right of the seat.",'
    '\n            transform={"position": [0, 0, 0], "rotation": [0, 0, 0]},'
    '\n            geometry={"primitive": "tube", "size": [1, 1, 1]},'
    '\n            geometryDescriptor={'
    '\n                "tubePath": {'
    '\n                    "points": [[0.25, 0.42, -0.15], [0.25, 0.24, -0.24], [0.25, 0.06, -0.24], [0.25, -0.01, -0.22]],'
    '\n                    "radius": 0.022,'
    '\n                    "closed": False,'
    '\n                }'
    '\n            },'
)
assert old_rr in c, "rear-right pattern not found"
c = c.replace(old_rr, new_rr)

# Leg glides move to the sled-runner end (rear, z=-0.22), sitting on the floor.
glide_fixes = [
    ('"position": [-0.25, -0.01, 0.25]', '"position": [-0.25, -0.01, -0.22]'),
    ('"position": [0.25, -0.01, 0.25]', '"position": [0.25, -0.01, -0.22]'),
]
for old, new in glide_fixes:
    if old in c:
        c = c.replace(old, new)

P.write_text(c, encoding="utf-8")
print("OK: 4 legs promoted to macro sled tubes; glides moved to runner ends")
