# chair.png — image analysis (Layer 1-8)

Reference image: `wwwroot/games/pogallery/refs/chair.png` (750x1020, single front-right isometric view).
Per `grimoire/intake/image_analysis.md`. Visual observation only; no code yet.

## Layer 1 — Identification & classification
- **Work type:** upholstered armless side chair (guest / office / stackable class).
- **Broad classification:** furnishing / seating.
- **primaryDomain:** `object`.
- **Confidence:** 0.95 (unambiguous silhouette, no occlusion of identity-defining parts in the visible profile).

## Layer 2 — Overall form & silhouette
- **Bounding volume:** roughly cuboid seat+back envelope (~1.0W x 0.9H x 0.7D units relative), with a four-leg cantilever frame extending below and slightly outside the seat footprint.
- **Symmetry:** bilateral (mirror plane through the seat's vertical centerline).
- **Shape language:** geometric — a single padded cuboid back+seat form sits on a tubular metal frame.
- **Aspect:** taller than wide (back-height ≈ 1.5× seat-depth), narrow footprint, legs splay slightly outward from the seat.
- **Reference dimensions:** seat-depth ≈ 1.0 unit (relative); seat-height above floor ≈ 0.5 unit; back-height above seat ≈ 0.55 unit.

## Layer 3 — Macro → meso → micro decomposition
- **Macro:**
  1. Backrest
  2. Seat
  3. Frame (4 legs + cross-rails as one welded assembly)
- **Meso:**
  - Backrest: upper padded panel (large rectangle), horizontal seam strip at mid-height.
  - Seat: top cushion (rounded front bevel), side panel (visible left and partial right), front edge.
  - Frame: 2 fully-visible front legs, 1 partially-visible rear-right leg, glides on bottom of each leg, top horizontal rail connecting leg tops (the visible front rail running under the seat front edge).
- **Micro:**
  - Seat fabric: woven/canvas weave texture, slight pilling visible at the cushion front.
  - Single horizontal seam across the backrest at mid-height (gap of ~3-5% of backrest height).
  - Cantilever (sled-base) curve where each leg bends back from the floor to under the seat.
  - Brushed metal grain running vertically on the legs.

## Layer 4 — Spatial relationships (scene-graph)
- `<backrest, attached-to, seat>` — flush-mounted, no visible gap between backrest bottom and seat rear.
- `<seat, attached-to, frame-top-rail>` — sits on the frame's upper cross-rail; the rail is visible at the front.
- `<frame-legs, attached-to, frame-rails>` — single welded sled-base assembly, each leg curves from the floor up to the cross-rail.
- `<seam-strip, embedded-in, backrest>` — the strip is sewn into the backrest at mid-height (a horizontal parting line).
- `<glides, embedded-in, leg-bottoms>` — small dark feet at each leg end, ~5% of leg height.

## Layer 5 — Materials & surface (PBR)
- **Upholstery (backrest + seat panels + seam strip):**
  - albedo: deep navy blue, ≈ #1c2c52 / rgb(28, 44, 82)
  - metalness: 0.0 (dielectric)
  - roughness: ~0.85 (matte cloth)
  - normal/relief: low-amplitude woven weave (canvas / hopsack)
- **Frame:**
  - albedo: light grey, ≈ #b8b8b8 / rgb(184, 184, 184)
  - metalness: ~0.85
  - roughness: ~0.4 (brushed)
  - normal/relief: vertical brush lines, slight rounded corner bevel at the front rail
- **Glides:**
  - albedo: near-black, ≈ #1a1a1a
  - metalness: 0.0
  - roughness: ~0.9

## Layer 6 — Color & finish
- Navy upholstery: vivid blue, mid-low value, uniform across all fabric parts (no per-region gradient — single dyed fabric).
- Brushed metal: monochromatic light grey with subtle anisotropic vertical brushing.
- Glides: dark matte plastic.
- No specular highlights on the upholstery (matte cloth); a soft sheen along the seat front edge reads as the front-bevel curving toward the light, not a glossy finish.

## Layer 7 — Identity-defining features
1. **Single horizontal seam at mid-back** — the most distinguishing geometric feature; this is the chair's "fingerprint".
2. **Cantilever sled-base frame** with splayed legs and visible front cross-rail — a sled base, not four individual straight legs.
3. **No arms** — armless silhouette is the chair's class.
4. **Rounded front bevel on the seat cushion** — the seat front has a softer curve than the rear.
5. **Brushed metal frame finish** — visible anisotropic brushing on the legs.

## Layer 8 — Uncertainty & single-image limits
- **Occluded:** back face of backrest (will be approximated as same panel flat).
- **Hidden:** underside of seat; the inside faces of the frame legs (the side facing the chair center); rear-left leg (only front-right and a glimpse of rear-right visible).
- **Uncertain:** the cantilever curve continuity on the side facing away; exact leg cross-section (likely rounded-rectangular tubing but could be round); rear-leg glide size vs front.
- **Speculative:** the seam strip is the same fabric as the backrest, not a contrasting band — assumed from the matching color in the image.

These unknowns feed `preSpecAssessment.unknownsToResolveBeforeImplementation`. None are blocking — the chair can be modeled with reasonable assumptions and the back/inside faces flagged as low-confidence.

## Mapping to spec fields
- Layer 1 → `objectClass.primaryType = "upholstered-side-chair"`, `primaryDomain = "object"`.
- Layer 2 → complexity `moderate`, bilateral symmetry, cuboid+frame geometry strategy.
- Layer 3 → `componentTree`: backrest / seat / frame, with frame as a parent of legs+rails+glides.
- Layer 4 → `attachment` triples for backrest-seat, seat-frame, frame-rails, seam-strip-backrest, glides-legs.
- Layer 5 → three materials: upholstery (fabric), frame (brushed metal), glides (matte plastic).
- Layer 6 → one color recipe per material.
- Layer 7 → five identity features, each becoming a `detailInventory` entry and at least one `featureReviewTarget`.
- Layer 8 → four unknowns at low/medium confidence; no `request-input` (single view accepted, per skill default for moderate complexity).
