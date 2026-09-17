# Design — PoCabinet UI Layout Concepts

Ten distinct layout concepts covering PoCabinet's six UI surfaces. Each can be picked standalone or combined with others. ASCII sketches are conceptual — the actual three.js scene + Blazor components will refine these.

---

## Concept 1: First-Person Cockpit + Full Telemetry HUD (Recommended Default)

The cockpit dominates the viewport (≈ 65% width × 60% height). HUD strips top + bottom + left side. Information-dense without clutter.

```
┌─────────────────────────────────────────────────────────────────┐
│ P1  CAPITOL SPEEDWAY  LAP 1/3  POS 2/4   ⏱ 0:42.18   GAP +1.20   │ ← Top strip
├─────────────────────────────────────────────────────────────────┤
│ ╭───────╮  ╭───────────╮  ╭───────────╮                         │
│ │ RPM   │  │   SPEED   │  │   GEAR    │   ← Left gauges          │
│ │ 6500  │  │   187     │  │    4      │                         │
│ │ ▓▓▓░░ │  │   km/h    │  │           │                         │
│ ╰───────╯  ╰───────────╯  ╰───────────╯                         │
│                                                                 │
│              ╭─────────────────────────────╮                     │
│              │                             │                     │
│              │     three.js scene          │                     │
│              │     (cockpit frame +        │  ← 65% × 60%       │
│              │      road ahead)            │                     │
│              │                             │                     │
│              ╰─────────────────────────────╯                     │
│  ── steering wheel ──  ── dashboard hood ──  ── rear-view ──    │ ← Cockpit chrome
├─────────────────────────────────────────────────────────────────┤
│ [Steve B. ahead] "Taking the inside line!"     B. EST +0:01.20   │ ← Dialogue + deltas
└─────────────────────────────────────────────────────────────────┘
```

**Tradeoffs**: Information-rich, supports hardcore racers. Wheel + dashboard chrome adds immersion. Left gauges consume ~20% width but don't block the road. Best fit for "cockpit-view" promise.

---

## Concept 2: First-Person Cockpit + Minimal HUD (iRacing-style)

Just the wheel, hood, and the road. Speed + gear only. Position info appears as a small badge that fades out after 5s.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│              ╭─────────────────────────────╮                     │
│              │                             │                     │
│              │     three.js scene          │                     │
│              │                             │  ← 95% × 90%       │
│              │     (full cockpit frame)    │                     │
│              │                             │                     │
│              ╰─────────────────────────────╯                     │
│  ── steering wheel ──  ── hood ──  ── rear-view ──               │
│                                              ┌─────┐             │
│                                              │ 187 │             │
│                                              │  4  │             │
│                                              └─────┘             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Tradeoffs**: Maximum immersion, minimal chrome. Position/rank visible only on race events. Bad for multiplayer (you can't see who's nearby).

---

## Concept 3: Hood Cam + Mid HUD (Need for Speed-style)

Camera sits just above the hood; you see the front of your car + the road. Mid-density HUD.

```
┌─────────────────────────────────────────────────────────────────┐
│ CAPITOL SPEEDWAY   LAP 1/3   POS 2/4   B.LAP 0:42.18            │ ← Top
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│              ╭─────────────────────────────╮                     │
│              │                             │                     │
│              │     three.js scene          │                     │
│              │     (hood in foreground,    │  ← 90% × 70%       │
│              │      road + traffic ahead)  │                     │
│              │                             │                     │
│              ╰─────────────────────────────╯                     │
│                                                                 │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌──────┐                │
│ │RPM │  │SPD │  │GEAR│  │LAP │  │POS │  │ DELTA│ ← Bottom strip │
│ │6500│  │187 │  │ 4  │  │1/3 │  │2/4 │  │+1.20 │                │
│ └────┘  └────┘  └────┘  └────┘  └────┘  └──────┘                │
└─────────────────────────────────────────────────────────────────┘
```

**Tradeoffs**: Less immersive than full cockpit, but HUD reads cleanly. Hood cam is forgiving for crashes (camera doesn't penetrate walls as easily).

---

## Concept 4: Third-Person Chase + Arcade HUD (Mario Kart-style)

Camera behind the car, you see your own car. Power-up-style item boxes above the steering wheel. Pickups (out of scope for v1) would slot here.

```
┌─────────────────────────────────────────────────────────────────┐
│  [1] Sean S.  [2] YOU  [3] Steve B.  [4] Mike P.                 │ ← Position bar
├─────────────────────────────────────────────────────────────────┤
│              ╭─────────────────────────────╮                     │
│              │                             │                     │
│              │     three.js scene          │                     │
│              │     (your car + 3 AI cars   │  ← 95% × 75%       │
│              │      visible, chase cam)    │                     │
│              │                             │                     │
│              ╰─────────────────────────────╯                     │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  ┌────┐  ┌────┐  ┌──────┐                                       │
│  │SPD │  │GEAR│  │ DELTA│                                       │
│  │187 │  │ 4  │  │+1.20 │                                       │
│  └────┘  └────┘  └──────┘                                       │
└─────────────────────────────────────────────────────────────────┘
```

**Tradeoffs**: Most accessible; players see themselves. Loses the "cockpit-view" promise that the user explicitly asked for. Rejected for v1 unless the user overrides.

---

## Concept 5: First-Person + Documentary News-Broadcast Theme

The cockpit is overlaid with a TV-broadcast frame: lower-third ticker, chyron banner, klieg-light border. Satirical "press briefing" framing of the race.

```
┌══════════════════════════════════════════════════════════════════┐
│ ╔═══════ BREAKING NEWS ═══════╗                                  │
│ ║  POOL REPORT — LAP 1/3      ║                                  │
│ ╚══════════════════════════════╝                                  │
│              ╭─────────────────────────────╮                     │
│              │     three.js scene          │                     │
│              ╰─────────────────────────────╯                     │
│ ┌─────────────────────────────────────────────────────────────┐  │
│ │ POOL: Steve B.   Takes the inside line at T2                 │  │
│ │ DOW: Sean S.    "I'm not taking questions right now"        │  │
│ └─────────────────────────────────────────────────────────────┘  │
└══════════════════════════════════════════════════════════════════┘
```

**Tradeoffs**: Strongest thematic fit (news-broadcast = press briefing satire). Themed chrome can feel cluttered. Klieg-light border is decorative.

---

## Concept 6: First-Person Cockpit + Press Briefing Podium Backdrop

The cockpit sits in front of a podium-shaped backdrop (Press Briefing 500 themed). Stars-and-stripes trim. Camera angle is low, looking up.

```
         ╔═══════════════════════════════╗
         ║ ★ ★ ★   PRESS BRIEFING ★ ★ ★   ║  ← Podium arch
         ╚═══════════════════════════════╝
                ╭─────────────────────╮
                │   three.js scene    │
                │   (cockpit + road   │
                │    ahead, low angle)│
                ╰─────────────────────╯
            ── steering wheel ──  ── hood ──
        ┌────┐  ┌────┐  ┌────┐  ┌────────┐
        │SPD │  │RPM │  │GEAR│  │ POS 2/4│
        └────┘  └────┘  └────┘  └────────┘
```

**Tradeoffs**: Strong thematic resonance on Press Briefing 500 specifically. Less thematic on Capitol Speedway / Mar-a-Lago (the backdrop varies by track — that's the design).

---

## Concept 7: Split-Screen 2P (Same Device)

Two cockpits side-by-side, each with its own HUD. Players alternate turns OR play hot-seat.

```
┌─────────────────────────────┬─────────────────────────────┐
│ P1  CAPITOL   LAP 1/3        │ P2  CAPITOL   LAP 1/3        │
│ ┌────┐  ┌────┐  ┌────┐       │ ┌────┐  ┌────┐  ┌────┐       │
│ │SPD │  │RPM │  │GEAR│       │ │SPD │  │RPM │  │GEAR│       │
│ └────┘  └────┘  └────┘       │ └────┘  └────┘  └────┘       │
│                             │                             │
│   ╭───────────────────╮     │   ╭───────────────────╮     │
│   │   three.js P1     │     │   │   three.js P2     │     │
│   ╰───────────────────╯     │   ╰───────────────────╯     │
└─────────────────────────────┴─────────────────────────────┘
```

**Tradeoffs**: Best for hot-seat 2P on a wide monitor. Each player gets ~50% width. Doesn't work on portrait / phone.

---

## Concept 8: Multiplayer Lobby Cards (Among Us-style)

Lobby UI: 8 player cards in a 4×2 grid, host in the top-left. Each card shows the player's name + chosen livery. Join code in a banner at the top.

```
┌─────────────────────────────────────────────────────────────────┐
│             LOBBY CODE:  CAB-7XQ2    [ COPY ]                    │
├─────────────────────────────────────────────────────────────────┤
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐                 │
│  │  HOST  │  │  P2    │  │  P3    │  │  P4    │                 │
│  │ You    │  │ Mike P.│  │ Sean S.│  │ (open) │                 │
│  │ ★ gold │  │ blue   │  │ red    │  │        │                 │
│  └────────┘  └────────┘  └────────┘  └────────┘                 │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐                 │
│  │  P5    │  │  P6    │  │  P7    │  │  P8    │                 │
│  │ (open) │  │ (open) │  │ (open) │  │ (open) │                 │
│  └────────┘  └────────┘  └────────┘  └────────┘                 │
│                                                                 │
│     Track: [ Capitol Speedway ▾ ]   [ READY ]  [ START ]         │
└─────────────────────────────────────────────────────────────────┘
```

**Tradeoffs**: Clear at-a-glance roster, easy to spot empty seats. Card grid takes vertical space; needs ≥ 800px viewport height. Standard for lobby UIs.

---

## Concept 9: Championship Bracket View (3-Track Career)

Career progress shown as a racing-themed bracket: 3 tracks as a horizontal "stages" line, with current stage highlighted and previous stages marked completed.

```
┌─────────────────────────────────────────────────────────────────┐
│              THE CAMPAIGN                                       │
│                                                                 │
│   ┌──────────┐         ┌──────────┐         ┌──────────┐        │
│   │ CAPITOL  │ ──────► │ MAR-A-   │ ──────► │ PRESS    │        │
│   │ SPEEDWAY │  DONE   │ LAGO GP  │ ACTIVE  │ BRIEFING │        │
│   │  ★ Podium│         │  ━━━━━   │         │   🔒     │        │
│   │ 1st: 1'23│         │ Best: -- │         │          │        │
│   └──────────┘         └──────────┘         └──────────┘        │
│                                                                 │
│   🏆 Trophy: Locked (win Press Briefing to unlock)               │
│   🎨 Gold Livery: Locked                                        │
└─────────────────────────────────────────────────────────────────┘
```

**Tradeoffs**: Visualizes the 3-stage career at a glance. Doesn't show partial state well. Each stage is a card with metadata.

---

## Concept 10: Demo Showcase Multi-Cam (Picture-in-Picture AI Race)

Demo mode shows the AI race primarily, with a small PiP window cycling through close-ups of individual cars. Elo ladder floats on the right.

```
┌─────────────────────────────────────────────────────────────────┐
│ DEMO — Press Briefing 500                                       │
│                                                  ┌──────────┐  │
│                                                  │  ELO     │  │
│         ╭───────────────────────╮                │  Sean    │  │
│         │                       │                │  1480 ▲  │  │
│         │   three.js primary    │                │  Steve   │  │
│         │   AI race view        │                │  1520 ─  │  │
│         │                       │                │  Bill    │  │
│         ╰───────────────────────╯                │  1440 ▼  │  │
│                                                  │  Mike    │  │
│     ╭────────╮                                   │  1560 ▲  │  │
│     │ PiP:   │                                   └──────────┘  │
│     │ Steve  │                                                   │
│     ╰────────╯                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Tradeoffs**: Best for spectating AI races. PiP cycling needs camera switching logic. Elo ladder is a strong thematic element.

---

## Recommended Combination (Default Pick)

If you don't want to micromanage, the recommended combination is:

- **Concept 1** for the race page (full cockpit + full telemetry HUD)
- **Concept 8** for the lobby
- **Concept 9** for the championship view
- **Concept 10** for the demo mode
- A simpler card-grid for the track selector (3 cards, like Concept 8's player cards)
- A 4×4 grid for the paint shop

---

## Component Hierarchy (Auto-derived once concepts are chosen)

```
PoCabinetPage.razor (route: /pocabinet/{mode})
├── PoCabinetPreRaceOverlay.razor   ← mode == 1player / 2player / multi
│   ├── PoCabinetTrackSelector.razor
│   ├── PoCabinetPaintShop.razor
│   └── PoCabinetChampionshipView.razor  ← only if mode == 1player
├── PoCabinetLobby.razor            ← mode == multi
│   └── PoCabinetLobbySeatGrid.razor
├── PoCabinetDemoView.razor         ← mode == demo
│   ├── PoCabinetDemoSelector.razor
│   └── PoCabinetEloLadder.razor
└── PoCabinetRaceScene.razor        ← in-race (all modes)
    ├── PoCabinetCockpitCanvas.razor (mounts three.js scene + cockpit)
    ├── PoCabinetRaceHud.razor      (speed, RPM, gear, lap, position, deltas)
    └── PoCabinetDialogueOverlay.razor (race-event dialogue bubbles)
```

Native Blazor throughout. No Radzen.