"""Add generator-readable palette fields (top-level albedo + colorVariation.palette)
to each material in patch_spec.py. The material-pass gate requires
'reference-derived albedo palette or secondary color zones' as read by
generate_threejs_factory.materialPalette(): spec.colorVariation.palette or
spec.albedo.secondary — both at the material's TOP level.

Run: py .img2threejs/fix_palettes.py
"""
from pathlib import Path

P = Path(r"C:\Users\punko\Downloads\pominigames\.img2threejs\patch_spec.py")
c = P.read_text(encoding="utf-8")

# upholstery: add palette keys inside its existing colorVariation block
old_up = (
    '"colorVariation": {\n'
    '                "range": ["#1c2c52", "#14203c"],\n'
    '                "amplitude": 0.05,'
)
new_up = (
    '"colorVariation": {\n'
    '                "range": ["#1c2c52", "#14203c"],\n'
    '                "palette": ["#1c2c52", "#14203c", "#233a6b"],\n'
    '                "amplitude": 0.05,'
)
assert old_up in c, "upholstery colorVariation not found"
c = c.replace(old_up, new_up)

# frame
old_fr = (
    '"colorVariation": {\n'
    '                "range": ["#b8b8b8", "#d4d4d4", "#9c9c9c"],\n'
    '                "amplitude": 0.08,'
)
new_fr = (
    '"colorVariation": {\n'
    '                "range": ["#b8b8b8", "#d4d4d4", "#9c9c9c"],\n'
    '                "palette": ["#b8b8b8", "#d4d4d4", "#9c9c9c"],\n'
    '                "amplitude": 0.08,'
)
assert old_fr in c, "frame colorVariation not found"
c = c.replace(old_fr, new_fr)

# glides
old_gl = (
    '"colorVariation": {\n'
    '                "range": ["#1a1a1a", "#262626"],\n'
    '                "amplitude": 0.03,'
)
new_gl = (
    '"colorVariation": {\n'
    '                "range": ["#1a1a1a", "#262626"],\n'
    '                "palette": ["#1a1a1a", "#262626"],\n'
    '                "amplitude": 0.03,'
)
assert old_gl in c, "glides colorVariation not found"
c = c.replace(old_gl, new_gl)

P.write_text(c, encoding="utf-8")
print("OK: palette arrays added to all three materials")
