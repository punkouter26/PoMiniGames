# build-marble-track-2.py — generator for the PoMarbleRace map-3 course, "Grand Spiral".
#
#   Run inside Blender (the repo drives it over the Blender MCP add-on):
#       exec(open(r"<repo>/scripts/build-marble-track-2.py").read())   then   run()
#
# Writes two files, and BOTH are inputs to the bake:
#   src/PoMiniGames.Client/wwwroot/models/marble_track_2.glb   — the geometry
#   scripts/marble_track_2.course.json                         — the sidecar (see below)
# then `node scripts/bake-marble-track.mjs course2` turns those into the centerline and the
# collision shell the game loads.
#
# WHY THIS FILE EXISTS AT ALL. marble_track.glb (map 2) has no source in the repo — it survives
# only as its exported GLB, so nobody can adjust a slope or widen a lane without re-modelling the
# whole course by hand. This course is defined by the script instead: the .blend is a build
# artifact, this is the source. Re-run it to change the geometry.
#
# WHY THE SIDECAR. Three things the baker needs are facts about the COURSE, not about the mesh:
# the order of the segments, the hand-authored links that bridge a free fall (where there is no
# swept geometry to read a centerline from), and the zones that decide which stretches of floor
# collide as rumble or washboard. Hard-coding those in the baker means two files that have to
# agree about station numbers and drop heights, and they will not stay in agreement. The
# generator knows all of it exactly, so it writes it out and the baker reads it.
#
# ── THE EXPORT CONTRACT (read before touching build_channel) ─────────────────────────────────
# scripts/bake-marble-track.mjs recovers the racing line straight out of the vertex buffer, and
# it ASSERTS the layout rather than fitting to it. Every Track-* channel must export as a swept
# U-section, ring-major, with exactly 8 unique positions per ring in this slot order:
#
#     0 = A-underside   2 = A-outer-top   3 = A-inner-top   4 = A-floor-top
#     1 = B-underside   7 = B-outer-top   6 = B-inner-top   5 = B-floor-top
#
# so the baker reads floor centre = mid(v4,v5), width = |v4-v5|, and the banked up axis =
# mid(v3,v6) - centre. Two construction details make Blender's glTF exporter actually emit that
# order, and both are load-bearing:
#
#   * vertices are appended ring by ring, in slot order, via from_pydata;
#   * faces are a quad strip walking the CLOSED cross-section outline 0,2,3,4,5,6,7,1 — which is
#     the U traced from A's outer top, down A's inner wall, across the floor, up B's inner wall,
#     over B's outer top and back along the underside.
#
# There are deliberately NO end caps. A cap polygon at ring 0 would emit that ring's vertices in
# the cap's winding order instead of slot order and break the decode.
#
# NAME PREFIXES ARE THE INTERFACE. track-glb.js keys entirely off them:
#   Track-*   swept channel — baked into the centerline and the collision shell
#   Track-Bowl2   the ONE funnel; collides against its own geometry, upward faces only. It must
#                 FAIL the ring decode or the baker would treat it as a channel — see build_bowl.
#   Obs-Peg*      -> world-Y cylinder collider     Obs-Gate*   -> box collider
#   Obs-Paddle*   -> crossed kinematic blades, counter-rotating on a trailing -1
#   Deco-*        rendered only. No collider, invisible to the baker. Boost pads and the rumble /
#                 washboard markings are Deco, because those surfaces are a PREDICATE or a
#                 MATERIAL, not a shape.
#
# ── THE PHYSICS CONTRACT ─────────────────────────────────────────────────────────────────────
# From js/pomarblerace/physics.js: GRAVITY 72 world u/s^2, marble<->surface friction 0.09.
# That brackets the slope of every descending stretch from BOTH sides:
#   * slope > 0.09          or gravity stops winning and the pack can settle and stall;
#   * slope < 0.315         (= friction * 7/2) or marbles skid instead of rolling.
# Nothing on this course rises, so the non-trapping property map 2 gave up when it grew its two
# uphill loops holds here by construction. run() prints the per-section slopes; the baker prints
# the authoritative table including the worst LOCAL slope, which is what the washboard ripple
# could break if its amplitude were raised.
#
# Units are RAW GLB units; the game multiplies by SCALE = 4. A marble is radius 0.25 raw.
import bpy
import bmesh
import json
import math
import os

# ── constants shared with the runtime ───────────────────────────────────────────────────────
SCALE = 4.0
GRAVITY_WORLD = 72.0
MAX_SPEED_WORLD = 85.0

DS = 1.0                 # arclength per ring; the baker asserts ring-to-ring step <= 6
BANK_FRAC = 0.85         # fraction of the full design-speed bank for the local radius
BLUR = 25                # stations either side of a boundary over which curvature/bank/slope blend

WALL_H = 2.5
WALL_T = 0.5
FLOOR_T = 0.5
PROP_SINK = 0.25         # props are pushed this far into the floor so none can float

MODEL_REL = "src/PoMiniGames.Client/wwwroot/models/marble_track_2.glb"
SIDECAR_REL = "scripts/marble_track_2.course.json"

# Fallback repo root, used when this file is run via exec() over the MCP bridge (which leaves
# __file__ undefined). Override it before calling run() if the checkout lives elsewhere.
REPO_ROOT = r"c:\Users\punko\Downloads\PoMiniGames"

# Closed cross-section outline. See THE EXPORT CONTRACT above — do not reorder.
OUTLINE = (0, 2, 3, 4, 5, 6, 7, 1)

# ── course layout ───────────────────────────────────────────────────────────────────────────
# The course is marched in three RUNS. A run is a continuous swept descent; the gaps between them
# are the two features that have no swept geometry at all — the funnel and the free fall — and
# those are bridged by hand-authored link samples written into the sidecar.
#
# Section fields:
#   name        segment name, becomes Track-<Name>
#   len         stations, = raw units of centerline
#   slope       dy/ds. None means "ramp", handled in _raw_profiles
#   radius      SIGNED turn radius: positive winds left, negative right. The course reverses
#               several times rather than screwing down one way, so a race reads as a descending
#               weave instead of one long corkscrew. Reversing is safe only because every section
#               drops far more than the channel is deep, so where the path crosses back over its
#               own footprint the two passes are tens of units apart — check_overlap asserts it.
#
#               A REVERSAL MUST NOT LAND ON A SPLIT, and this is not a stylistic rule. An
#               off-centre lane's floor sits at height `lateral * sin(bank)` relative to the
#               spine, so when the bank swings from +28 to -28 degrees through a reversal, a lane
#               offset 5.5 units to one side RISES about 0.1 raw per station. Measured with
#               SplitA across the HelixA reversal, that ate the section's 0.26 descent down to a
#               local 0.05 — under the 0.09 stall floor — and the baker flagged it. Every split
#               here therefore continues the sign of the section feeding it, and the reversals
#               happen on single full-width channels where there is no lateral offset to tilt.
#   bank        scale on the design-speed bank. Terraces run near-level so their PROPS work:
#               track-glb.js builds every Obs-Peg as a world-Y cylinder and spins every
#               Obs-Paddle about world Y, so a prop only agrees with its own collider on a level
#               floor. Measured on a 28-degree banked terrace, a paddle blade floated its low tip
#               1.5 raw units — three marble diameters — and the field ran underneath it.
#   width       channel width, or a (from, to) pair to taper across the section
#   split       lane table, see SPLITS
#   camber      -1 flips the bank the WRONG way for an off-camber turn
#   ripple      washboard amplitude in raw units, 0 for none
RUNS = [
    {
        "name": "run1",
        "sections": [
            {"name": "Start",     "len": 50,  "slope": None, "radius": +90.0, "bank": 0.35, "width": (22.0, 20.0)},
            {"name": "HelixA",    "len": 140, "slope": 0.28, "radius": +44.0, "bank": 1.00, "width": 20.0, "pinch": True},
            {"name": "SplitA",    "len": 85,  "slope": 0.26, "radius": +40.0, "bank": 1.00, "width": 20.0, "split": "SplitA"},
            {"name": "Washboard", "len": 40,  "slope": 0.22, "radius": +90.0, "bank": 0.30, "width": 20.0, "ripple": 0.08},
            # WALL OF DEATH. A tight radius with the bank scale pushed past 1 stands the channel
            # up near vertical, so marbles ride the wall instead of the floor. bank 2.2 at R 26
            # gives ~62 degrees. This is the one section whose geometry depends on marbles
            # ARRIVING FAST — the same property that forces map 2's MAX_SPEED floor of ~75 — so it
            # is placed straight after the washboard run rather than after anything that scrubs
            # speed, and it is kept short so a slow marble sags to the floor rather than stalling.
            {"name": "Loop",      "len": 60,  "slope": 0.29, "radius": -26.0, "bank": 2.20, "width": 16.0},
            {"name": "HelixB",    "len": 110, "slope": 0.30, "radius": -38.0, "bank": 1.00, "width": 20.0, "camber": True},
            # CROSSOVER. Two lanes trade sides, one of them over a bridge — see the Weave entry in
            # SPLITS for why the bridge has to be there at all.
            # bank 0.5, not 1.0. A bowing lane's floor height is lateral*sin(bank), so the bow
            # itself bleeds slope: at full bank (32 deg, sin 0.53) a +-5 bow over 120 stations ate
            # this section down to a local 0.08 and the baker flagged it. Halving the bank halves
            # sin, and halving the bow halves the lateral rate — together they cut the loss by 4x.
            {"name": "Weave",     "len": 120, "slope": 0.31, "radius": -34.0, "bank": 0.50, "width": 20.0, "split": "Weave"},
            # Same sign as the Weave feeding it. A reversal here would land on the split's exit,
            # and an off-centre lane tilting through a bank swing loses slope — the rule recorded
            # under `radius` above. Putting TerraceB at +90 cost the Weave 0.08 local slope and
            # the baker flagged it; the reversal lives at Washboard -> Loop instead, between two
            # full-width channels.
            {"name": "TerraceB",  "len": 75,  "slope": 0.16, "radius": -90.0, "bank": 0.20, "width": 22.0},
        ],
    },
    {
        "name": "run2",
        "sections": [
            # LowerA opens as a 40-wide CATCH PAN and tapers back to a normal channel. That width
            # is not styling: a marble leaving the funnel's throat has been spiralling, so it
            # exits with real tangential speed and flies sideways, not straight down. Simulated
            # with an 18-wide mouth, nine of sixteen marbles shot clean past the channel and fell
            # out of the world — measured 23 raw units off the centerline while dropping 22. The
            # pan has to be wider than that sideways throw.
            {"name": "LowerA", "len": 65, "slope": 0.26, "radius": -40.0, "bank": 1.00, "width": (40.0, 30.0)},
            {"name": "SplitC", "len": 75, "slope": 0.25, "radius": -42.0, "bank": 1.00, "width": 20.0, "split": "SplitC"},
        ],
    },
    {
        "name": "run3",
        "sections": [
            # Catch basin AND single-file finish: it opens at 32 to take the whole spread coming
            # off the drop, then squeezes to 9 at the line so the pack has to queue and the
            # photo-finish director has something to shoot. The taper is late and after the last
            # hazard on purpose — this is the shape that jammed map 2 when it happened early and
            # over a splitter.
            {"name": "Finish", "len": 65, "slope": 0.20, "radius": +90.0, "bank": 0.30, "width": (32.0, 9.0)},
        ],
    },
]

# Splits. Lane `offset` is the lateral centre at the mouth and `bow` is how far it swings away at
# mid-section and back; a lane's ARCLENGTH therefore follows from its bow, and since every lane
# drops the same height as the spine, a shorter lane is automatically a STEEPER one. That is the
# whole gamble: the inside line is quicker and narrower and steeper, and it throws marbles.
#
# Lanes must tile the feeding channel at the mouth or the baker has to bridge a hole — it does
# that automatically (see bridgeSplitMouth) but the smaller the hole the better the nose.
SPLITS = {
    # Two lanes: a wide safe outside and a narrow, short, steep inside.
    "SplitA": [
        {"tag": "safe", "offset": -5.5, "bow": -7.0, "width": 8.0},
        {"tag": "risk", "offset": +5.5, "bow": +1.0, "width": 4.5},
    ],
    # Three lanes, symmetric fan.
    "SplitB": [
        {"tag": "left",  "offset": -6.5, "bow": -5.0, "width": 6.0},
        {"tag": "mid",   "offset": 0.0,  "bow": 0.0,  "width": 6.0},
        {"tag": "right", "offset": +6.5, "bow": +5.0, "width": 6.0},
    ],
    # WEAVE — a two-lane fan, NOT the crossover it was meant to be. Recording why, because the
    # obvious fix does not work.
    #
    # A true crossover needs the lanes to swap sides, so they must pass through each other, so one
    # needs a bridge. The bridge has to clear the other lane's COLLISION wall, which the baker
    # lofts at WALL_GAIN = 2.6, i.e. 6.5 raw units — not the 2.5 that is drawn. Clearing 6.5 costs
    # 9 units of rise, and the rise has to be paid back out of the section's slope: 9 over 60
    # stations is 0.15, which already forces this section to 0.30 and 120 long just to stay above
    # the 0.09 stall floor.
    #
    # That much was buildable. What is not is the approach: with lanes 7 wide and centres 11 apart
    # they overlap laterally for most of the crossing, and the bridge is only at full height in
    # the middle — so the two collision envelopes interfere either side of the crossing point,
    # where the bridge is still low. Measured: 9 of 16 marbles stopped in the weave. Making the
    # bridge rise fast enough to clear the interference makes the ramp into it steep enough to
    # stall marbles instead, and widening the lane spacing enough to avoid the overlap needs more
    # width than the channel has.
    #
    # A real crossover needs the collision wall height to be per-segment so the under-lane can be
    # lofted low, which is a change to the BAKER, not to this file. Until then this is an honest
    # two-lane fan: two routes of different length that split and merge, with no bridge.
    "Weave": [
        {"tag": "under", "offset": -6.5, "bow": -3.0, "width": 6.0},
        {"tag": "over", "offset": +6.5, "bow": +3.0, "width": 6.0},
    ],
    # Five lanes. The baker's mouth bridging takes any lane count; three was only ever what it
    # had been fed.
    # Five lanes at 5.4 wide, fed by a 30-wide channel — NOT 3.6 fed by 20. At 3.6 raw a lane is
    # 14.4 world, about seven marbles abreast, and on a banked turn the field simply rode over the
    # walls: six of sixteen marbles were lost across this fan in simulation. Lane count is not the
    # problem, lane WIDTH is, so the feeding channel was widened to pay for it. Bows are small for
    # the same reason SplitA's are — a bowing lane bleeds slope through the bank tilt.
    "SplitC": [
        {"tag": "l2", "offset": -11.0, "bow": -3.0, "width": 5.4},
        {"tag": "l1", "offset": -5.5,  "bow": -1.5, "width": 5.4},
        {"tag": "m",  "offset": 0.0,   "bow": 0.0,  "width": 5.4},
        {"tag": "r1", "offset": +5.5,  "bow": +1.5, "width": 5.4},
        {"tag": "r2", "offset": +11.0, "bow": +3.0, "width": 5.4},
    ],
}

# The MAIN lane of each split — the one carrying the progress line. Everything else is an `alt`:
# collidable and rendered, but measured by projecting onto this one.
SPLIT_MAIN = {"SplitA": "safe", "Weave": "under", "SplitC": "m"}

# Pinch-and-flare on HelixA: squeeze the channel to compress the pack, then release it. This is
# exactly the shape that BROKE map 2 — a 40->24 world taper jammed the field and lost 53 marbles
# down the splitter holes — so it is deliberately gentle here (20 -> 15 raw, i.e. 80 -> 60 world,
# still thirty marbles abreast) and it happens on a wide channel with nothing to fall into.
PINCH = {"from": 0.55, "to": 0.95, "width": 15.0}

# Washboard: a ripple in the floor, collided as `bump` (restitution 0.12, tuned low so ridges
# jostle without launching). AMPLITUDE IS BOUNDED BY THE STALL THRESHOLD, not by taste: the ripple
# adds +-A*2*pi/period to the local slope, so at A=0.08 / period=8 it swings the section's 0.22
# by 0.063, bottoming out at 0.157 — still comfortably over the 0.09 friction floor. Raising A or
# shortening the period can put a trough BELOW it, which is a place the pack parks.
RIPPLE_PERIOD = 8.0

# Zones, as (segment, from, to, material) over each segment's own length. `rumble` is friction
# 0.3 and `bump` is the low-restitution washboard contact — both already defined in physics.js
# and, before this course, used by nothing but the procedural chute.
ZONES = [
    {"segments": ["Track-Washboard"], "from": 0.04, "to": 0.96, "material": "bump"},
    # RUMBLE IS A STRIP, NOT A STRETCH, and the length is a physics constraint. Its friction is
    # 0.3, which is higher than the tan(slope) of EVERY section on this course (the steepest is
    # HelixB at 0.30) — physics.js's rule is that a drag surface must stay under the local slope
    # or gravity stops winning. Kept short, a marble crosses it on momentum and only loses speed;
    # made long, it becomes somewhere the pack can come to rest and never restart. Widening this
    # band means lowering the rumble coefficient, which is shared with the procedural chute.
    {"segments": ["Track-TerraceB"], "from": 0.16, "to": 0.30, "material": "rumble"},
    # ICE, placed on the run INTO the crossover. Friction 0.02 is far below the (2/7)*tan(slope)
    # needed to roll, so a marble stops rolling and skids: it keeps its speed but loses the grip
    # to pick a line, and arrives at the weave carrying momentum it cannot steer. Being far under
    # tan(slope) it can never trap — on ice gravity always wins.
    {"segments": ["Track-HelixB"], "from": 0.55, "to": 0.90, "material": "ice"},
]

# Boost pads. No collider — game.js reads inBoost(s) each frame and accelerates whatever is on
# top, so these are a predicate plus a Deco ribbon. Placed on the two stretches where a marble is
# travelling straightest, because BOOST_ACCEL fires along the track tangent.
BOOST = [
    {"segments": ["Track-TerraceB"], "from": 0.62, "to": 0.92},
    {"segments": ["Track-Finish"], "from": 0.10, "to": 0.40},
]

# Kicker bands: telegraphed, push-only shoves. game.js owns the whole behaviour (_applyKickers
# brightens the pad over the last third of each cycle as a TELL, then _fireKicker punches marbles
# sideways, alternating direction by index so the pack SPLITS rather than slides). The course only
# supplies the band and a Deco ribbon to light up.
#
# ORDER IS THE CONTRACT: the Nth entry here pairs with Deco-Kicker-N, because track-glb.js zips
# the sorted kicker meshes against the baked KICKER_BANDS array. Placed on wide, near-level
# stretches — a sideways punch on a narrow banked lane just deletes marbles.
KICKERS = [
    {"segments": ["Track-Washboard"], "from": 0.30, "to": 0.62},
    {"segments": ["Track-TerraceB"], "from": 0.44, "to": 0.60},
]


# ── small vector helpers ────────────────────────────────────────────────────────────────────
def _add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _mul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _len(a):
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def _norm(a):
    L = _len(a) or 1.0
    return (a[0] / L, a[1] / L, a[2] / L)


def _lerp(a, b, t):
    return a + (b - a) * t


def to_gltf(p):
    """
    Blender Z-up -> glTF Y-up, the same conversion export_yup performs on the mesh.

    The sidecar's link samples are read by the baker in GLB space, so they MUST go through this.
    Authoring them in Blender space and forgetting the swap puts the funnel's throat somewhere
    off in +Z and the centerline threads a link through empty air.
    """
    return [p[0], p[2], -p[1]]


# ── profiles ────────────────────────────────────────────────────────────────────────────────
def _flat_sections():
    """All sections across all runs, in course order, with absolute station ranges per run."""
    out = []
    for run in RUNS:
        lo = 0
        for sec in run["sections"]:
            out.append((run["name"], sec, lo, lo + sec["len"]))
            lo += sec["len"]
    return out


def _run_profiles(run):
    """Per-station curvature / bank-scale / slope for one run, before smoothing."""
    total = sum(s["len"] for s in run["sections"])
    kappa, bank_scale, slope = [], [], []
    lo = 0
    for sec in run["sections"]:
        hi = lo + sec["len"]
        for i in range(lo, hi):
            sl = sec["slope"]
            if sl is None:
                # Ease the grid off the line instead of dropping it down a ramp: a start already
                # at full pitch scatters the field before the first turn.
                sl = _lerp(0.13, 0.22, (i - lo) / float(sec["len"]))
            kappa.append(1.0 / sec["radius"])
            bank_scale.append(sec["bank"] * (-1.0 if sec.get("camber") else 1.0))
            slope.append(sl)
        lo = hi
    # one extra station so a run of N sections yields N+1 rings at its joins
    kappa.append(kappa[-1]); bank_scale.append(bank_scale[-1]); slope.append(slope[-1])
    return kappa, bank_scale, slope, total


def _blur(values, radius):
    """
    Box blur with clamped edges — smooths the step at every section boundary.

    Curvature is blended as 1/R and NOT as R: averaging a +44 radius against a -40 one would
    sweep the radius through zero, which is an infinitely tight turn. In curvature space the same
    transition passes through 0 — dead straight — which is what a change of direction actually is.
    """
    n = len(values)
    out = []
    for i in range(n):
        lo, hi = max(0, i - radius), min(n - 1, i + radius)
        out.append(sum(values[lo:hi + 1]) / float(hi - lo + 1))
    return out


def bank_from_curvature(k, scale, i, total):
    """
    Bank angle in radians for local signed curvature `k`.

    Magnitude is the design-speed bank for the radius (tan(phi) = v^2/(g*R)), scaled by
    BANK_FRAC; the SIGN follows the turn direction so the OUTER edge lifts. A straight stretch has
    k = 0 and banks not at all, which falls out of the formula rather than needing a case. A
    negative `scale` (see `camber`) lifts the INSIDE edge instead — an off-camber turn that throws
    the pack outward exactly where they are leaning on grip.
    """
    phi = math.atan(BANK_FRAC * abs(scale) * (MAX_SPEED_WORLD ** 2) * abs(k) / (GRAVITY_WORLD * SCALE))
    phi = math.copysign(phi, k * (1.0 if scale >= 0 else -1.0))
    # Flat under the starting grid and flat again at the line. The grid is laid out along the
    # local right axis, so banking at station 0 would tip the whole field sideways before the
    # lights go out; and a banked finish keeps marbles rolling when they should be settling.
    if i < 60:
        phi *= i / 60.0
    if i > total - 40:
        phi *= max(0.0, (total - i) / 40.0)
    return phi


def march_run(run, start_pos, start_heading):
    """
    March one run's centerline at a fixed DS per step, in Blender Z-up space.

    Marching by ARCLENGTH rather than by angle is what makes the section table mean what it says:
    a 110-station section is exactly 110 raw units of racing line, and its drop is exactly the sum
    of its slopes. It is also what lets the course change direction at all — the marcher carries a
    heading and turns it by h/R each step, so a sign flip in R is simply a turn the other way.
    """
    k_raw, b_raw, s_raw, total = _run_profiles(run)
    kappa, bank_scale, slope = _blur(k_raw, BLUR), _blur(b_raw, BLUR), _blur(s_raw, BLUR)

    pts = []
    x, y, z = start_pos
    psi = start_heading
    turned = 0.0
    for i in range(total + 1):
        pts.append((x, y, z))
        sl = slope[i]
        horiz = DS * math.sqrt(max(0.0, 1.0 - sl * sl))
        x += horiz * math.cos(psi)
        y += horiz * math.sin(psi)
        z -= DS * sl
        dpsi = horiz * kappa[i]
        psi += dpsi
        turned += abs(dpsi)

    ups, rights, tans = [], [], []
    for i in range(len(pts)):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        t = _norm(_sub(b, a))
        rt = _norm(_cross(t, (0.0, 0.0, 1.0)))
        up = _norm(_cross(rt, t))
        phi = bank_from_curvature(kappa[i], bank_scale[i], i, total)
        c, s = math.cos(phi), math.sin(phi)
        up_b = _norm(_sub(_mul(up, c), _mul(rt, s)))
        rt_b = _norm(_add(_mul(rt, c), _mul(up, s)))
        tans.append(t)
        ups.append(up_b)
        rights.append(rt_b)
    return {"pts": pts, "ups": ups, "rights": rights, "tans": tans,
            "end_pos": (x, y, z), "end_heading": psi, "turned": turned, "total": total}


# ── mesh construction ───────────────────────────────────────────────────────────────────────
def ring_verts(centre, right, up, half_w):
    """The 8 cross-section points for one ring, in the slot order the baker decodes."""
    o = half_w + WALL_T

    def P(lat, vert):
        return _add(centre, _add(_mul(right, lat), _mul(up, vert)))

    return [
        P(-o, -FLOOR_T),     # 0 A-underside
        P(+o, -FLOOR_T),     # 1 B-underside
        P(-o, WALL_H),       # 2 A-outer-top
        P(-half_w, WALL_H),  # 3 A-inner-top
        P(-half_w, 0.0),     # 4 A-floor-top
        P(+half_w, 0.0),     # 5 B-floor-top
        P(+half_w, WALL_H),  # 6 B-inner-top
        P(+o, WALL_H),       # 7 B-outer-top
    ]


def build_channel(name, centres, ups, half_widths, material):
    """
    Emit one swept U-section channel as its own object.

    Tangents are recovered from the centre polyline by central difference and the frame is
    re-squared against them, so a lane that bows away from the spine still gets rings normal to
    its OWN travel rather than to the spine's.
    """
    n = len(centres)
    verts = []
    for i in range(n):
        a = centres[max(0, i - 1)]
        b = centres[min(n - 1, i + 1)]
        t = _norm(_sub(b, a))
        rt = _norm(_cross(t, ups[i]))
        up = _norm(_cross(rt, t))
        verts.extend(ring_verts(centres[i], rt, up, half_widths[i] * 0.5))

    faces = []
    for i in range(n - 1):
        a, b = i * 8, (i + 1) * 8
        for k in range(len(OUTLINE)):
            p = OUTLINE[k]
            q = OUTLINE[(k + 1) % len(OUTLINE)]
            faces.append((a + p, a + q, b + q, b + p))

    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()

    # ── UVs ──
    # V runs along the sweep and U around the cross-section, BOTH measured in real raw units and
    # divided by TEX_TILE, so the tread is the same physical size everywhere: it does not stretch
    # where the channel widens into a catch pan (40 units) or squeezes to the single-file finish
    # (9). Building UVs from the outline's own edge lengths is what buys that — a naive
    # index-based U would smear the pattern across a wide floor and bunch it on a narrow one.
    #
    # Faces were appended in (ring, outline-edge) order as quads, so loop index is
    # face*4 + corner and the corners follow the same (a+p, a+q, b+q, b+p) order used above.
    uvl = me.uv_layers.new(name="UVMap").data
    sweep = [0.0]
    for i in range(1, n):
        sweep.append(sweep[-1] + _len(_sub(centres[i], centres[i - 1])))
    fi = 0
    for i in range(n - 1):
        ring_a = verts[i * 8:(i + 1) * 8]
        perim = [0.0]
        for k in range(len(OUTLINE)):
            a = ring_a[OUTLINE[k]]
            b = ring_a[OUTLINE[(k + 1) % len(OUTLINE)]]
            perim.append(perim[-1] + _len(_sub(b, a)))
        v0, v1 = sweep[i] / TEX_TILE, sweep[i + 1] / TEX_TILE
        for k in range(len(OUTLINE)):
            u0, u1 = perim[k] / TEX_TILE, perim[k + 1] / TEX_TILE
            for c, uv in enumerate(((u0, v0), (u1, v0), (u1, v1), (u0, v1))):
                uvl[fi * 4 + c].uv = uv
            fi += 1

    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_ribbon(name, centres, ups, half_widths, material, lift=0.06, inset=0.75):
    """
    A thin Deco strip laid on the floor — the boost pads and the rumble / washboard markings.

    Deco-* is rendered and nothing else: no collider, and the baker's ^Track- filter never sees
    it. That is the right shape for these features because a boost pad IS a predicate (game.js
    accelerates whatever is on top of it) and a rumble band IS a contact material — neither is a
    thing to bump into.
    """
    verts, faces = [], []
    n = len(centres)
    for i in range(n):
        a = centres[max(0, i - 1)]
        b = centres[min(n - 1, i + 1)]
        t = _norm(_sub(b, a))
        rt = _norm(_cross(t, ups[i]))
        up = _norm(_cross(rt, t))
        hw = half_widths[i] * 0.5 * inset
        base = _add(centres[i], _mul(up, lift))
        verts.append(_add(base, _mul(rt, -hw)))
        verts.append(_add(base, _mul(rt, +hw)))
    for i in range(n - 1):
        a = i * 2
        faces.append((a, a + 1, a + 3, a + 2))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_bowl(name, centre, rim_r, throat_r, rim_z, throat_z, material, segs=18, rings=10,
               slots=((0.0, 2), (math.pi, 2)), slot_rings=(6, 8)):
    """
    The funnel. Marbles arrive over the rim, spiral, and drop through the open throat.

    TWO CONSTRAINTS, both load-bearing:
      * `segs` is 18, deliberately NOT a multiple of 8. The baker discovers swept channels by
        trying its ring decode on every Track-* mesh and skipping whatever throws; a funnel that
        happened to decode would be spliced into the centerline as if it were a channel. Map 2's
        bowl escapes on the smoothness assertion instead, which is luck rather than design.
      * it is a SOLID, walled inside and out, not a single sheet. track-glb.js collides this mesh
        against its own geometry keeping only upward-facing triangles, so the surface a marble
        rides has to exist as an upward-facing triangle. A one-sided sheet passes or fails that
        test wholesale depending on which way its winding happens to run; a solid always has an
        inner face pointing up into the cavity.
    """
    verts, faces = [], []
    for r in range(rings + 1):
        t = r / float(rings)
        rad = _lerp(rim_r, throat_r, t)
        z = _lerp(rim_z, throat_z, t)
        for s in range(segs):
            a = 2.0 * math.pi * s / segs
            verts.append((centre[0] + rad * math.cos(a), centre[1] + rad * math.sin(a), z))
    inner = len(verts)
    for r in range(rings + 1):
        t = r / float(rings)
        rad = _lerp(rim_r, throat_r, t) + WALL_T
        z = _lerp(rim_z, throat_z, t) - FLOOR_T
        for s in range(segs):
            a = 2.0 * math.pi * s / segs
            verts.append((centre[0] + rad * math.cos(a), centre[1] + rad * math.sin(a), z))

    def quad(base, r, s, flip):
        s2 = (s + 1) % segs
        p00 = base + r * segs + s
        p01 = base + r * segs + s2
        p10 = base + (r + 1) * segs + s
        p11 = base + (r + 1) * segs + s2
        return (p00, p10, p11, p01) if flip else (p00, p01, p11, p10)

    # MULTIPLE THROATS. `slots` opens gaps in the cone wall at given angles over the `slot_rings`
    # band, so marbles spiralling down drop through whichever gap they reach first rather than all
    # funnelling to one exit — the funnel becomes a randomiser, which is what a funnel is for.
    # Both the inner surface AND the outer shell are skipped, or the hole would be capped from
    # below by the solid's underside and nothing would fall through.
    def in_slot(r, sg):
        if not (slot_rings[0] <= r < slot_rings[1]):
            return False
        a = 2.0 * math.pi * sg / segs
        for centre_a, half in slots:
            d = abs((a - centre_a + math.pi) % (2.0 * math.pi) - math.pi)
            if d <= (2.0 * math.pi * half / segs):
                return True
        return False

    for r in range(rings):
        for s in range(segs):
            if in_slot(r, s):
                continue
            faces.append(quad(0, r, s, False))       # inner surface
            faces.append(quad(inner, r, s, True))    # outer shell
    # close the rim and the throat so the solid is sealed
    for s in range(segs):
        s2 = (s + 1) % segs
        faces.append((s, s2, inner + s2, inner + s))
        top = rings * segs
        faces.append((top + s, inner + top + s, inner + top + s2, top + s2))

    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


# Raw units per texture repeat. 4.0 puts one tread cell every 16 world units — about eight marble
# diameters — which reads as surface grain at race pace rather than as a pattern.
TEX_TILE = 4.0


def make_ramp_texture(name, tint, size=128):
    """
    A procedural tread plate, generated per tint.

    Generating one image PER MATERIAL rather than one shared image plus a tint node is deliberate:
    it keeps every material a single Image Texture wired straight to Base Color, which is the one
    shape the glTF exporter always round-trips cleanly. Mixing nodes export as baked approximations
    or not at all depending on the graph.
    """
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size)
    px = [0.0] * (size * size * 4)
    for y in range(size):
        for x in range(size):
            # transverse ridges along the direction of travel, plus a faint lengthwise seam
            ridge = 0.20 if (y % 16) < 3 else 0.0
            seam = 0.10 if (x % 32) < 2 else 0.0
            # deterministic grain — no Math.random equivalent needed, and it keeps re-runs stable
            h = math.sin((x * 12.9898 + y * 78.233)) * 43758.5453
            grain = ((h - math.floor(h)) - 0.5) * 0.10
            k = 1.0 + ridge + seam + grain
            i = (y * size + x) * 4
            px[i] = max(0.0, min(1.0, tint[0] * k))
            px[i + 1] = max(0.0, min(1.0, tint[1] * k))
            px[i + 2] = max(0.0, min(1.0, tint[2] * k))
            px[i + 3] = 1.0
    img.pixels = px
    img.pack()
    return img


def make_textured_material(name, tint, rough=0.62, metal=0.0):
    """Principled BSDF with a generated tread image on Base Color."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = make_ramp_texture(name + "Tex", tint)
    tex.location = (-320, 220)
    nt.links.new(bsdf.inputs["Base Color"], tex.outputs["Color"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    return mat


def make_material(name, rgba, rough=0.55, metal=0.0, emit=None, emit_strength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = emit
        bsdf.inputs["Emission Strength"].default_value = emit_strength
    return mat


def add_peg(name, centre, material, radius=0.9, height=2.2):
    """
    A short vertical post. buildTrack turns any Obs-Peg* into a cylinder from its bbox.

    Seated along WORLD up, not the track's banked up, because the collider cannot be anything
    else: track-glb.js builds `new CANNON.Cylinder(...)`, which cannon-es orients along +Y.
    """
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=12,
                          radius1=radius, radius2=radius, depth=height)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    ob.location = (centre[0], centre[1], centre[2] + height * 0.5 - PROP_SINK)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def add_gate(name, centre, material, size=(3.0, 1.4, 2.4)):
    """
    A blocking slab. buildTrack turns any Obs-Gate* into a Box from its world bounding box.

    WORLD-AXIS-ALIGNED on purpose. The collider is built from an AABB and gets no rotation, so a
    gate modelled at the channel's angle would collide as a fatter, square-on box that does not
    match what is drawn. Aligned, the visual and the collider are the same object.
    """
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    ob.location = (centre[0], centre[1], centre[2] + size[2] * 0.5 - PROP_SINK)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def add_paddle(name, centre, material):
    """
    Two crossed blades on a vertical pivot.

    Dimensions are NOT free: track-glb.js hard-codes the collider as boxes of half-extents
    (2.9, 0.8, 0.15) raw and assumes the mesh spans 0..1.6 ABOVE the node origin, taking the node
    position as the pivot. Anything else and the visual and the collider disagree.
    """
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    for sx, sy in ((2.9, 0.15), (0.15, 2.9)):
        blade = bmesh.new()
        bmesh.ops.create_cube(blade, size=2.0)
        bmesh.ops.scale(blade, vec=(sx, sy, 0.8), verts=blade.verts)
        bmesh.ops.translate(blade, vec=(0.0, 0.0, 0.8), verts=blade.verts)
        tmp = bpy.data.meshes.new("_blade")
        blade.to_mesh(tmp)
        blade.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    ob.location = (centre[0], centre[1], centre[2] - PROP_SINK)
    bpy.context.scene.collection.objects.link(ob)
    return ob


# ── build ───────────────────────────────────────────────────────────────────────────────────
def clear_previous():
    """Remove only what this script owns, so a re-run is idempotent and leaves the scene alone."""
    for ob in list(bpy.data.objects):
        if ob.name.startswith(("Track-", "Obs-", "Deco-")):
            bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)


def section_width(sec, t):
    """Channel width at fraction `t` through a section, including the pinch-and-flare."""
    w = sec["width"]
    base = _lerp(w[0], w[1], t) if isinstance(w, tuple) else w
    if sec.get("pinch"):
        a, b, pw = PINCH["from"], PINCH["to"], PINCH["width"]
        if a <= t <= b:
            # ease in and back out so the taper is never a step
            u = (t - a) / (b - a)
            base = _lerp(base, pw, math.sin(math.pi * u))
    return base


def check_overlap(all_pts, near=26.0, skip=60):
    """
    Smallest vertical gap anywhere the course passes back over itself.

    Reversing direction means the path DOES cross its own footprint, which is fine only while the
    two passes are far enough apart in height. Anything approaching the channel depth (~3 raw)
    would be geometry poking through geometry, so this reports the worst case rather than leaving
    it to be noticed in the renderer.
    """
    worst = None
    n = len(all_pts)
    for i in range(n):
        xi, yi, zi = all_pts[i]
        for j in range(i + skip, n):
            dx, dy = all_pts[j][0] - xi, all_pts[j][1] - yi
            if dx * dx + dy * dy > near * near:
                continue
            dz = abs(all_pts[j][2] - zi)
            if worst is None or dz < worst[0]:
                worst = (dz, i, j)
    return worst


def run():
    clear_previous()

    # The RAMP surfaces are textured; props and Deco overlays stay flat colour so they read as
    # markings rather than as more track.
    mat_track = make_textured_material("TrackSurface", (0.42, 0.47, 0.56), rough=0.62)
    mat_lane = make_textured_material("TrackLane", (0.34, 0.40, 0.50), rough=0.62)
    mat_risk = make_textured_material("TrackRisk", (0.54, 0.33, 0.32), rough=0.58)
    mat_bowl = make_textured_material("TrackBowl", (0.36, 0.39, 0.50), rough=0.45, metal=0.2)
    mat_peg = make_material("ObsPeg", (0.86, 0.44, 0.18, 1.0), rough=0.40, metal=0.25)
    mat_gate = make_material("ObsGate", (0.80, 0.30, 0.42, 1.0), rough=0.45, metal=0.20)
    mat_timed = make_material("ObsTimedGate", (0.95, 0.72, 0.15, 1.0), rough=0.35, metal=0.45)
    mat_paddle = make_material("ObsPaddle", (0.22, 0.68, 0.72, 1.0), rough=0.35, metal=0.35)
    mat_boost = make_material("DecoBoost", (0.03, 0.30, 0.38, 1.0), rough=0.40,
                              emit=(0.13, 0.83, 0.93, 1.0), emit_strength=2.2)
    mat_rumble = make_material("DecoRumble", (0.36, 0.22, 0.05, 1.0), rough=0.85,
                               emit=(0.95, 0.62, 0.16, 1.0), emit_strength=0.6)
    mat_bump = make_material("DecoBump", (0.28, 0.24, 0.32, 1.0), rough=0.80,
                             emit=(0.72, 0.62, 0.95, 1.0), emit_strength=0.5)
    # Magenta so a kicker never reads as a friendly cyan boost pad. track-glb.js CLONES this per
    # band at load, because GLTFLoader would otherwise hand every ribbon the same material
    # instance and charging one would light them all.
    mat_kicker = make_material("DecoKicker", (0.23, 0.04, 0.32, 1.0), rough=0.50,
                               emit=(0.91, 0.47, 0.98, 1.0), emit_strength=1.4)
    mat_ice = make_material("DecoIce", (0.62, 0.80, 0.92, 1.0), rough=0.05, metal=0.1,
                            emit=(0.40, 0.70, 0.95, 1.0), emit_strength=0.35)

    made = []
    course = []
    all_pts = []
    section_index = {}     # name -> (run marched, lo, hi)
    extra_alts = {}        # segment -> extra alt lanes built outside the run marching

    # ── march the three runs, bridging the two gaps ──
    marched = {}
    pos, heading = (0.0, 0.0, 0.0), 0.0
    links = {}
    for ri, run_cfg in enumerate(RUNS):
        m = march_run(run_cfg, pos, heading)
        marched[run_cfg["name"]] = m
        all_pts.extend(m["pts"])
        pos, heading = m["end_pos"], m["end_heading"]
        if ri == 0:
            # ── the funnel ──
            fwd = (math.cos(heading), math.sin(heading), 0.0)
            rim_r, throat_r = 16.0, 3.0
            centre = _add(pos, _mul(fwd, rim_r * 0.85))
            rim_z = pos[2] - 1.5
            throat_z = rim_z - 14.0
            made.append(build_bowl("Track-Bowl2", centre, rim_r, throat_r, rim_z, throat_z, mat_bowl))
            exit_pos = (centre[0], centre[1], throat_z - 6.0)
            # A CATCH APRON reaching BACK under the funnel.
            #
            # Widening LowerA alone did not fix the funnel exit, and the reason is worth keeping:
            # a channel only has floor FORWARD of its first ring. Marbles come out of the throat
            # still carrying the tangential velocity of the spiral, in every direction, so the
            # half of them travelling backwards relative to LowerA's heading landed behind ring 0
            # — over nothing — and fell out of the world. Measured: 12 of 16 lost, m0 passing the
            # throat at z -211 and simply continuing to -257 and beyond.
            #
            # The apron is an ALT of LowerA: collidable and rendered, but off the progress line,
            # so it adds floor without making the centerline double back on itself. It is level in
            # bank and slopes forward at the section's own rate, so anything landing on it rolls
            # onward instead of sitting. The 6-unit throat clearance above is what makes room for
            # it to pass beneath the funnel without intersecting the cone.
            catch_back, catch_slope = 16, 0.26
            cc, cu, cw = [], [], []
            for i in range(catch_back + 1):
                back = catch_back - i
                cc.append((exit_pos[0] - fwd[0] * back,
                           exit_pos[1] - fwd[1] * back,
                           exit_pos[2] + back * catch_slope))
                cu.append((0.0, 0.0, 1.0))
                cw.append(40.0)
            made.append(build_channel("Track-Catch", cc, cu, cw, mat_track))
            extra_alts.setdefault("Track-LowerA", []).append("Track-Catch")
            # Link samples must NOT be vertical: the baker derives right = dir x up, and a dir
            # parallel to world up collapses that cross product to zero and the whole local frame
            # with it. Every sample here carries real horizontal travel.
            links["Bowl"] = [
                {"p": to_gltf(_add(pos, _mul(fwd, 3.0))), "up": [0, 1, 0], "halfWidth": 14.0},
                {"p": to_gltf(_add(centre, _mul(fwd, 6.0))[:2] + (rim_z - 7.0,)), "up": [0, 1, 0], "halfWidth": 9.0},
                {"p": to_gltf(exit_pos), "up": [0, 1, 0], "halfWidth": 4.0},
            ]
            pos = exit_pos
        elif ri == 1:
            # ── the free fall ──
            # The basin STARTS almost under the lip and runs 70 units downrange, rather than being
            # centred on where an average marble lands. A field does not leave the lip at one
            # speed: the quick ones fly 25+ raw units while the slow ones drop almost straight
            # down, and a basin placed at the middle of that spread has nothing under either end
            # of it. Anchoring it at the near end instead means fast marbles simply land further
            # along a channel that is already there. Same lesson as the funnel's catch pan.
            fwd = (math.cos(heading), math.sin(heading), 0.0)
            drop_h = 14.0
            landing = _add(pos, _mul(fwd, 6.0))
            landing = (landing[0], landing[1], pos[2] - drop_h)
            # The middle sample sits ON THE PARABOLA, at a quarter of the fall rather than half.
            # A marble in free fall has covered half the horizontal distance at half the flight
            # time, by which point it has dropped only H/4 — fall goes as t^2. Splitting the link
            # linearly instead puts the centerline well BELOW the arc the marbles actually fly,
            # and isOutOfBounds retires anything more than 24 world units under the line, so a
            # straight chord across an 18-unit drop comes close enough to start culling the field
            # in mid-air.
            links["Drop"] = [
                {"p": to_gltf(_add(pos, _mul(fwd, 2.0))), "up": [0, 1, 0], "halfWidth": 10.0},
                {"p": to_gltf((pos[0] + fwd[0] * 3.0, pos[1] + fwd[1] * 3.0, pos[2] - drop_h * 0.25)),
                 "up": [0, 1, 0], "halfWidth": 12.0},
                {"p": to_gltf(landing), "up": [0, 1, 0], "halfWidth": 14.0},
            ]
            pos = landing

    # ── channels ──
    for run_cfg in RUNS:
        m = marched[run_cfg["name"]]
        pts, ups, rights = m["pts"], m["ups"], m["rights"]
        lo = 0
        for sec in run_cfg["sections"]:
            hi = lo + sec["len"]
            name = "Track-" + sec["name"]
            section_index[name] = (run_cfg["name"], lo, hi)

            # ripple rides on the spine points, so the collision shell (lofted from the same
            # rings) carries the washboard too — the bumps are real, not painted on
            ripple = sec.get("ripple", 0.0)
            centres, sec_ups, widths = [], [], []
            for i in range(lo, hi + 1):
                t = (i - lo) / float(sec["len"])
                c = pts[i]
                if ripple:
                    c = _add(c, _mul(ups[i], ripple * math.sin(2.0 * math.pi * (i - lo) / RIPPLE_PERIOD)))
                centres.append(c)
                sec_ups.append(ups[i])
                widths.append(section_width(sec, t))

            if "split" not in sec:
                made.append(build_channel(name, centres, sec_ups, widths, mat_track))
                entry = {"main": name}
                if extra_alts.get(name):
                    entry["alt"] = list(extra_alts[name])
                course.append(entry)
            else:
                lanes = SPLITS[sec["split"]]
                main_tag = SPLIT_MAIN[sec["split"]]
                alts = []
                for lane in lanes:
                    lname = f"{name}-{lane['tag']}"
                    lc, lu, lw = [], [], []
                    for i in range(lo, hi + 1):
                        u01 = (i - lo) / float(sec["len"])
                        if lane.get("cross"):
                            lat = lane["offset"] * math.cos(math.pi * u01)
                        else:
                            lat = lane["offset"] + lane["bow"] * math.sin(math.pi * u01)
                        c = _add(pts[i], _mul(rights[i], lat))
                        rise = lane.get("height", 0.0)
                        if rise:
                            c = _add(c, _mul(ups[i], rise * math.sin(math.pi * u01)))
                        lc.append(c)
                        lu.append(ups[i])
                        lw.append(lane["width"])
                    mat = mat_track if lane["tag"] == main_tag else (
                        mat_risk if lane["tag"] == "risk" else mat_lane)
                    made.append(build_channel(lname, lc, lu, lw, mat))
                    if lane["tag"] == main_tag:
                        main_name = lname
                    else:
                        alts.append(lname)
                    section_index[lname] = (run_cfg["name"], lo, hi)
                course.append({"main": main_name, "alt": alts})

            lo = hi
        # the link that follows this run, if any
        if run_cfg["name"] == "run1":
            course.append({"link": "Bowl"})
        elif run_cfg["name"] == "run2":
            course.append({"link": "Drop"})

    # ── Deco overlays for the zones and boost pads ──
    def strip(tag, seg_name, frm, to, material, idx):
        run_name, lo, hi = section_index[seg_name]
        m = marched[run_name]
        a = lo + int((hi - lo) * frm)
        b = lo + int((hi - lo) * to)
        sec = next(s for r in RUNS for s in r["sections"] if "Track-" + s["name"] == seg_name)
        ripple = sec.get("ripple", 0.0)
        cs, us, ws = [], [], []
        for i in range(a, b + 1):
            c = m["pts"][i]
            if ripple:
                c = _add(c, _mul(m["ups"][i], ripple * math.sin(2.0 * math.pi * (i - lo) / RIPPLE_PERIOD)))
            cs.append(c)
            us.append(m["ups"][i])
            ws.append(section_width(sec, (i - lo) / float(sec["len"])))
        made.append(build_ribbon(f"Deco-{tag}-{idx}", cs, us, ws, material))

    zone_mat = {"rumble": mat_rumble, "bump": mat_bump, "ice": mat_ice}
    for i, z in enumerate(ZONES):
        for seg in z["segments"]:
            strip(z["material"].capitalize(), seg, z["from"], z["to"], zone_mat[z["material"]], i)
    for i, b in enumerate(BOOST):
        for seg in b["segments"]:
            strip("Boost", seg, b["from"], b["to"], mat_boost, i)
    for i, k in enumerate(KICKERS):
        for seg in k["segments"]:
            strip("Kicker", seg, k["from"], k["to"], mat_kicker, i)

    # ── props ──
    # Pegs and paddles only on the level terraces and the finish basin, never in a split lane: a
    # narrow lane with a post in it is a dam, a wide terrace with posts in it is a pinball table.
    peg_n = gate_n = 0
    m1 = marched["run1"]
    tb_run, tb_lo, tb_hi = section_index["Track-TerraceB"]
    for i in range(tb_lo + 58, tb_hi - 3, 7):
        for lat in (-4.5, 4.5):
            add_peg(f"Obs-Peg-{peg_n}", _add(m1["pts"][i], _mul(m1["rights"][i], lat)), mat_peg)
            peg_n += 1
    # Gates: a chicane that pinches alternately left then right, so the pack has to weave.
    # ONE static gate, not a chicane. The terrace is only 75 stations long and already carries a
    # sweeping bar, two counter-rotating paddles, a peg field and a rumble strip; adding a
    # staggered pair of fixed blockers on top of that gave the pack nowhere to go and marbles
    # piled up here in simulation. Hazards need room between them to be hazards rather than a wall.
    for k, (station, lat) in enumerate(((tb_lo + 12, -6.5),)):
        add_gate(f"Obs-Gate-{gate_n}", _add(m1["pts"][station], _mul(m1["rights"][station], lat)), mat_gate)
        gate_n += 1
    # TIMED gate: a long bar on the centreline that track-glb.js spins slowly about world Y, so it
    # rakes across the terrace and the lane behind it is open for roughly half of each turn. It
    # SWEEPS rather than rising and falling — a lifting slab pinned marbles against the floor on
    # its downstroke and stopped the field dead. See the Obs-TimedGate branch in track-glb.js.
    timed_n = 0
    for station, lat in ((tb_lo + 30, 0.0),):
        add_gate(f"Obs-TimedGate-{timed_n}",
                 _add(m1["pts"][station], _mul(m1["rights"][station], lat)), mat_timed,
                 size=(7.0, 1.2, 2.4))
        timed_n += 1
    # Counter-rotating paddles — the trailing -1 is what makes the pair sweep opposite ways.
    for idx, station in enumerate((tb_lo + 46, tb_lo + 58)):
        add_paddle(f"Obs-Paddle-{idx}", m1["pts"][station], mat_paddle)

    m3 = marched["run3"]
    f_run, f_lo, f_hi = section_index["Track-Finish"]
    for i in range(f_lo + 28, f_lo + 52, 8):
        for lat in (-5.0, 0.0, 5.0):
            add_peg(f"Obs-Peg-{peg_n}", _add(m3["pts"][i], _mul(m3["rights"][i], lat)), mat_peg)
            peg_n += 1

    # ── export ──
    for ob in bpy.data.objects:
        ob.select_set(ob.name.startswith(("Track-", "Obs-", "Deco-")))
    bpy.context.view_layer.objects.active = made[0]

    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else None
    root = os.path.abspath(os.path.join(here, "..")) if here else REPO_ROOT
    out = os.path.join(root, MODEL_REL.replace("/", os.sep))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    # export_yup=True (the default) converts Blender's Z-up to glTF's Y-up. The course is
    # authored Z-up so it stands upright in Blender; the game sees it descending in -Y, which is
    # what track-glb.js expects. The conversion is a rigid transform and does not touch vertex
    # ORDER, so the ring-major contract survives it.
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True,
                              export_apply=True, export_yup=True)

    sidecar = {
        "_comment": "GENERATED by scripts/build-marble-track-2.py. Read by bake-marble-track.mjs.",
        "scale": SCALE,
        "course": course,
        "links": links,
        "zones": ZONES,
        "boost": BOOST,
        "kickers": KICKERS,
    }
    sc_path = os.path.join(root, SIDECAR_REL.replace("/", os.sep))
    with open(sc_path, "w", encoding="utf-8") as fh:
        json.dump(sidecar, fh, indent=2)
        fh.write("\n")

    worst = check_overlap(all_pts)
    stations = sum(s["len"] for r in RUNS for s in r["sections"])
    drop = all_pts[0][2] - all_pts[-1][2]
    per_section = {}
    for run_cfg in RUNS:
        m = marched[run_cfg["name"]]
        lo = 0
        for sec in run_cfg["sections"]:
            hi = lo + sec["len"]
            per_section[sec["name"]] = round((m["pts"][lo][2] - m["pts"][hi][2]) / (sec["len"] * DS), 3)
            lo = hi
    return {
        "channels": len(made),
        "pegs": peg_n,
        "gates": gate_n,
        "timed_gates": timed_n,
        "swept_stations": stations,
        "drop_raw": round(drop, 2),
        "section_slopes": per_section,
        "links": list(links.keys()),
        "min_vertical_gap_at_crossing": None if worst is None else round(worst[0], 2),
        "glb_bytes": os.path.getsize(out) if os.path.exists(out) else 0,
        "sidecar": sc_path,
    }
