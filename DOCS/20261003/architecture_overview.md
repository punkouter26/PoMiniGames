# Core Architecture & Game Loop

Snapshot date: 2026-10-03. Part of the `DOCS/20261003` set:
[model_summary.md](model_summary.md) · [training_metrics_guide.md](training_metrics_guide.md) ·
[creatures_dashboard.html](creatures_dashboard.html) · [scene_layout.html](scene_layout.html) ·
[creature_benchmarks.html](creature_benchmarks.html)

> **Read this first.** This doc set follows a template written for Unity ML-Agents projects.
> PoMiniGames is not a Unity project and contains **no trained models**: no ONNX files, no
> training runs, no reward curves. Every computer-controlled character here is either
> hand-written rules running in the browser or on the .NET server, or a hosted language model
> called over the network. Where the template asks for a training-only fact, the docs say
> "not applicable" instead of inventing a number. A "Unity equivalent" column is included so
> readers from that world can map the ideas across.

---

## Tier 1: Quick Look (30 seconds)

PoMiniGames is a website with fourteen small games. Twelve of them contain something that
plays without a human: a board-game opponent, a boxer, a racing driver, a horde monster, a
wolf on an island. None of them learned their behaviour. Designers wrote the rules and tuned
the numbers by hand.

There are three kinds of computer player:

| Kind | What it is | Where it runs | Examples |
|---|---|---|---|
| **Rule followers** | Fixed rules plus dice rolls. Difficulty is a table of numbers. | Player's browser | PoBrawl boxers, PoVoxelStrike monsters, PoSports runners |
| **Look-ahead thinkers** | Try every move a few turns ahead and pick the best. | Player's browser | TicTacToe and ConnectFive opponents |
| **Hosted models** | A language or decision model answers a question over the internet. Opt-in only: each has a free default. | Cloud service, called by the server | Jev (battle tactics), the Fresh AI quiz writers, the couple-quiz AI judge |

Every one of them runs the same loop many times a second: **look, decide, act, check if the
round is over**.

What to know as a designer or producer:

- Changing how hard an opponent is means editing a row in a table, not retraining anything.
- Only the hosted models cost money per decision, and only when a signed-in player opts in.
  Each has a daily cap and a free fallback (question banks, free answer matching, the local
  Jev rules). Ecosystem, Brawl and Cabinet text is scripted and calls no model.
- The only stored performance data in the repo is five recorded PoCabinet laps used by tests.

---

## Tier 2: Core Mechanics

### 2.1 The Decision Loop

**High-level view.** Every agent in the project fits this shape.

```mermaid
flowchart LR
    S["LOOK<br/>read the game state"] --> D["DECIDE<br/>rules, search, or a hosted model"]
    D --> A["ACT<br/>set a velocity, play a move,<br/>press a key"]
    A --> W{"Round over?"}
    W -- "no" --> S
    W -- "yes" --> R["RESET<br/>new round, new match,<br/>or back to the menu"]
    R --> S
```

**Component-level view: a rule follower (PoBrawl boxer).** The engine asks each fighter's
controller for an "intent" 60 times a second. The controller never touches physics itself.

```mermaid
flowchart TB
    subgraph Engine["Game engine: js/pobrawl/game.js (60 ticks per second)"]
        CTX["_aiContext()<br/>distance, kick range,<br/>opponent wind-up / active / recover,<br/>energy, super meter"]
        MOVE["Kinematic mover<br/>velocity eased toward the intent,<br/>position written directly"]
        HIT["hitResolution.js<br/>capsule vs capsule hit test,<br/>damage, block, knockback"]
        END{"KO, or<br/>60 s timer up?"}
    end
    subgraph Brain["Brain: js/pobrawl/ai.js AiController"]
        L1["Layer 1: signature phrase<br/>(scripted combo per president)"]
        L2["Layer 2: frame-data reactions<br/>block, punish, bait, charge<br/>gated by reaction time"]
        L3["Layer 3: signature footwork"]
        ADAPT["Habit tracker<br/>is the player spamming<br/>or turtling?"]
    end
    TABLE[("Difficulty table<br/>15 rungs")]
    PERS[("personalities.js<br/>per-president tuning")]

    CTX --> L1 --> L2 --> L3
    ADAPT --> L2
    TABLE --> L2
    PERS --> L1
    PERS --> L3
    L3 -- "intent: move, side, punch,<br/>kick, block, super" --> MOVE
    MOVE --> HIT --> END
    END -- "no" --> CTX
    END -- "yes" --> RST["Result screen,<br/>ladder advances or run ends"]
```

**Component-level view: a look-ahead thinker (ConnectFive opponent).**

```mermaid
flowchart TB
    B["Board: 9 x 9, drop pieces,<br/>five in a row wins"] --> ELO["Player's rating picks a rung<br/>(search depth + blunder chance)"]
    ELO --> DICE{"Blunder roll"}
    DICE -- "blunder" --> RND["Random legal column"]
    DICE -- "play properly" --> Q{"Depth 1?"}
    Q -- "yes" --> MED["Win now, else block,<br/>else centre, else random"]
    Q -- "no" --> NEG["NegamaxSearch<br/>try every column 2 to 4 moves deep,<br/>score each resulting board"]
    RND --> DROP["Drop the piece"]
    MED --> DROP
    NEG --> DROP
    DROP --> CHK{"Five in a row,<br/>or board full?"}
    CHK -- "no" --> B
    CHK -- "yes" --> UPD["Game over.<br/>Player rating moves up or down,<br/>next game uses the new rung"]
```

**Component-level view: a hosted model (Jev in PoJevArena).** The browser simulates the
fight; the brain only answers "what should this unit do next?". The default brain is the free
rule-based `LocalJevClient` on the server (once per unit per second). Paid Jev answers only when
`PoMiniGames:Jev:Brain` is `Jev`, a key is set and the player picks Jev in Settings; then a unit is
asked only on a state change (target lost, HP band crossed, new threat within 6 m), at most every
2 s, and repeated situations are answered from a per-match cache. An opt-in on-device model
(`js/localAi.js`, WebLLM over WebGPU) can serve the Jev brain in the browser instead.

```mermaid
flowchart TB
    subgraph Browser["Browser: js/pojevarena"]
        SIM["sim.js<br/>20 units, 60 ticks per second"]
        MEAS["measure()<br/>hp, cooldowns, stamina, under fire,<br/>allies near, up to 5 candidate targets"]
        SCH["scheduler.js<br/>batches of units every 250 ms"]
        APPLY["applyDecision()<br/>store the unit's new intent"]
    end
    subgraph Server["Server: Features/PoJevArena"]
        VAL["Validate every number,<br/>charge the daily allowance"]
        PB["JevPromptBuilder<br/>writes the state text"]
        JC["JevClient<br/>1.5 s timeout, no retries"]
    end
    JEV(["Jev decision model<br/>typesafe/jev-1.13 via OpenRouter"])

    SIM --> MEAS --> SCH --> VAL --> PB --> JC --> JEV
    JEV -- "action, target focus,<br/>panic probability" --> JC --> APPLY --> SIM
    JC -. "late or failed:<br/>unit keeps its last intent" .-> APPLY
    SIM --> E{"One team wiped,<br/>or 180 s up?"}
    E -- "yes" --> RES["Result posted to the server"]
```

**Engine mapping.**

| Concept | In PoMiniGames | Unity equivalent |
|---|---|---|
| The agent | A JS class (`AiController`, `AiTypist`, `Enemies`) or C# class (`TicTacToeAI`, `PoRacerAiDriver`) | `Agent` MonoBehaviour |
| Sensors | A plain object built each tick from game state (`_aiContext`, `perceive`, `measure`) | `RayPerceptionSensor`, `CollectObservations` |
| Brain / policy | Hand-written rules, a search, or a web call | `.onnx` model in Behavior Parameters |
| Actions | An "intent" object, a board move, or a key press | `OnActionReceived` |
| Physics | cannon-es (PoBrawl ragdolls, PoVoxelStrike player, PoMarbleRace) or custom arcade maths | Rigidbody, ConfigurableJoint |
| Episode reset | Round / match / race restart; demo modes loop on their own | `EndEpisode()` |
| Decision period | The tick rate plus any reaction-time gate | Decision Requester |

### 2.2 Controls & Movement Map

**High-level view.**

```mermaid
flowchart LR
    subgraph Senses["What agents sense"]
        P["Positions and distances"]
        V["Own speed and heading"]
        O["Obstacles, walls, track shape"]
        T["Opponent's current move<br/>and timing"]
        N["Needs: hunger, thirst,<br/>stamina, health"]
    end
    subgraph Controls["What agents control"]
        M["Move direction and speed"]
        ST["Steer, throttle, brake"]
        AT["Attack, block, special"]
        J["Jump"]
        BM["Board move"]
        K["Key presses"]
    end
    Senses --> BR(("Brain")) --> Controls
```

**Component-level view.** Each row is one agent family.

```mermaid
flowchart LR
    subgraph IN["Senses"]
        b1["Boxer: distance, opponent swing phase,<br/>own energy, super meter"]
        r1["Cabinet racer: own speed and position,<br/>cars within 170 units, bend ahead"]
        r2["PoRacer bot: centreline nodes ahead,<br/>bend sharpness"]
        m1["Horde monster: player position,<br/>falling debris, wall voxels ahead"]
        g1["Wall gun: player position and velocity,<br/>clear line of fire"]
        s1["Runner: own position, next hurdle"]
        c1["Island creature: threats, prey, mates,<br/>food and water tiles, night, fear"]
        j1["Arena unit: hp, cooldowns, stamina,<br/>five candidate targets"]
    end
    subgraph OUT["Controls"]
        b2["move, side-step, punch, kick,<br/>block, super"]
        r3["steer, throttle, brake"]
        r4["steer left or right,<br/>accelerate, coast, brake, reverse"]
        m2["walk direction, melee,<br/>carve wall, spit"]
        g2["aim, fire"]
        s2["four-key stride sequence, jump"]
        c2["one of 11 goals,<br/>then a walk or run velocity"]
        j2["tactical action, target focus,<br/>panic and flee"]
    end
    b1 --> b2
    r1 --> r3
    r2 --> r4
    m1 --> m2
    g1 --> g2
    s1 --> s2
    c1 --> c2
    j1 --> j2
```

How movement reaches the engine:

| Agent | Movement type | What that means |
|---|---|---|
| PoBrawl boxer | Kinematic | Velocity is eased toward the intent and the position is written directly. Physics only takes over for the KO ragdoll. |
| PoVoxelStrike monsters | Direct position | No physics body. The mesh is moved each frame and settles onto the terrain height. |
| PoCabinet racer | Custom arcade car | Speed along the heading; turning limited by grip. |
| PoRacer bot | Custom arcade car | One circle per car; on-or-off steering and pedals. |
| PoSports runner | Scalar lane state | Each finished key sequence adds a speed impulse; speed decays between strides. |
| PoMarbleRace marble | Physics body | A rolling sphere. No brain: gravity and the track do everything. |
| PoEcosystem creature | Kinematic over a heightmap | Velocity intent with fallback headings when blocked. |
| PoJevArena unit | Force-based 2D | Leg force limited by grip and stamina. |

### 2.3 Goals & Scoring Rules

**High-level view.** Nothing is "rewarded" in the training sense. These are the game's own
win, lose and score rules, which are what a trained agent would have been scored on.

```mermaid
flowchart LR
    subgraph Plus["Adds points / wins"]
        a["Finish first or fastest"]
        b["Knock out or outlast the opponent"]
        c["Complete a line on the board"]
        d["Survive longer, destroy more"]
    end
    subgraph Minus["Costs time / loses"]
        e["Hit a hurdle or wall"]
        f["Run out of health"]
        g["False start, wrong key"]
        h["Fall off the track"]
    end
    Plus --> SC(("Score or<br/>result"))
    Minus --> SC
```

**Component-level view.**

```mermaid
flowchart TB
    subgraph Board["TicTacToe / ConnectFive"]
        bw["Win: 4 in a row on 6 x 6,<br/>or 5 in a row on 9 x 9"]
        bd["Draw: board full"]
        be["Rating: plus or minus up to 32 per game"]
    end
    subgraph Brawl["PoBrawl"]
        pw["Win: opponent's health reaches 0"]
        pt["60 s timer: higher health wins,<br/>within 10 health is a draw"]
        pl["Board: fastest KO, ladder rungs cleared"]
    end
    subgraph Voxel["PoVoxelStrike"]
        vw["Win: touch the chalice<br/>bonus 25000 minus 40 per second, at least 5000"]
        vs["Score: 10 per second survived, 25 per kill,<br/>plus 50 brute, plus 40 crush kill,<br/>1 per 20 voxels destroyed"]
        vl["Lose: health reaches 0"]
    end
    subgraph Race["PoRacer / PoCabinet / PoSports"]
        rw["Win: lowest time or first across the line"]
        rp["Penalties: hurdle hit plus 1.5 s,<br/>false start 0.5 s hold, wall and sand slow you"]
        rb["Board: best lap or best meet time"]
    end
    subgraph Marble["PoMarbleRace"]
        mw["Score: top 10 of 101, 10 for first down to 1 for tenth"]
        mb["Plus 4 for a 1.5 s winning margin,<br/>streak multiplier up to 3 times"]
        ml["Miss or fall off: score and streak reset to 0"]
    end
    subgraph Arena["PoJevArena"]
        aw["Win: wipe the other team"]
        at["180 s timer: higher team health percent wins,<br/>within 1 point is a draw"]
    end
    subgraph Eco["PoEcosystem"]
        ew["No score. Watch only.<br/>The run ends when rabbits, deer and wolves are all gone."]
    end
```

### 2.4 Tuning Settings

**High-level view: where the knobs live.**

```mermaid
flowchart LR
    T1[("Difficulty tables<br/>in source code")] --> RF["Rule followers"]
    T2[("Per-character traits<br/>in source code")] --> RF
    T3[("Player's rating<br/>stored per player")] --> LT["Look-ahead thinkers"]
    T4[("appsettings.json and<br/>Azure Key Vault")] --> HM["Hosted models"]
```

**Component-level view: one knob traced end to end (PoBrawl difficulty).**

```mermaid
flowchart LR
    LAD["Ladder position<br/>(which president you face)"] --> RUNG["Rung 1 to 15"]
    RUNG --> ROW["Row in the LEVELS table"]
    ROW --> K1["reactionMs: 560 down to 95"]
    ROW --> K2["blockP: 0.16 up to 0.97"]
    ROW --> K3["punishP: 0.14 up to 1.00"]
    ROW --> K4["comboP: 0.00 up to 0.90"]
    K1 --> BEH["How the boxer plays"]
    K2 --> BEH
    K3 --> BEH
    K4 --> BEH
    HAB["Player habits<br/>(spam, turtle)"] --> BEH
```

**The configuration table.** The left column uses the plain-language names from the training
world. The middle column is the closest real setting in this project.

| Plain-language setting | Training-world name | Closest equivalent here | Value(s) | Where |
|---|---|---|---|---|
| **Learning pace** | Learning rate | Nothing trains. Closest: how fast the board-game CPU's strength follows the player's rating. | `AdaptiveK = 32` | `Client/Services/Play/GameStatsService.cs` |
| **Learning pace (generations)** | Mutation rate | How much a newborn island creature's personality differs from its parents. | `TRAIT_MUTATION_SIGMA = 0.08` | `js/poecosystem/sim/core/config.js` |
| **How far ahead it plans** | Time horizon | Moves searched ahead on the board. | 4 (TicTacToe hard), 1 to 4 (ConnectFive by rating) | `TicTacToeAI.cs`, `ConnectFiveAI.cs` |
| | | Distance a racer looks down the road. | 25 to 130 units per official (PoCabinet); 9 to 24 track segments (PoRacer) | `js/pocabinet/physics.js`, `PoRacerSim.cs` |
| | | How early a runner spots a hurdle. | 1.6 / 1.8 / 2.0 m (easy / medium / hard) | `js/posports/ai.js` |
| **Memory size** | Buffer / memory size | Positions the board search remembers. | 2048 (ConnectFive) | `NegamaxSearch.cs` |
| | | How long an island creature remembers food and water. | 120 s food, 240 s water | `js/poecosystem/sim/core/config.js` |
| | | How long a boxer remembers the player's habits. | `HABIT_TAU = 8` s | `js/pobrawl/ai.js` |
| **Exploration rate** | Epsilon / entropy | Chance the board CPU plays a random move on purpose. | 0.55 down to 0.05 (TicTacToe); 0.60 down to 0.00 (ConnectFive) | `StrengthForElo` in each AI file |
| | | Chance a PoCabinet racer misjudges a corner. | `wildness` 0.01 to 0.12 for the four officials | `js/pocabinet/physics.js` |
| | | Steering wobble on a PoRacer bot. | `0.015 x (1.15 - CorneringSkill)` per tick | `PoRacerSim.cs` |
| | | Typing mistakes by a PoSports runner. | `errorRate` 0.008 to 0.01 | `js/posports/ai.js` |
| **Reaction time** | Decision period | Delay before a boxer makes a weighted choice. | 560 ms (rung 1) down to 95 ms (rung 15) | `js/pobrawl/ai.js` |
| **How often it thinks** | Decision frequency | Ticks per second. | PoBrawl 60, PoSports 60, PoJevArena sim 60 (one model call per unit per second), PoRacer 50, PoCabinet 30, PoEcosystem 20 (goals re-scored 4 times a second) | each engine's constants |
| **Batch size** | Batch size | Units sent to Jev per request. | `MaxBatch = 8` | `PoJevArenaEndpoints.cs` |
| **Aggression** | Reward weight | Boxer's attack appetite. | `aggro` 0.72 to 1.50 | `js/pobrawl/ai.js` |
| | | PoRacer bot's risk on corners. | `Aggression` 0.30 to 0.95; tier `botCaution` 0.58 / 0.42 / 0.20 | `PoRacerAiDriver.cs`, `PoRacerRaceRegistry.cs` |
| **Spending cap** | Compute budget | Hosted-model tokens per player per day. | `DailyTokensPerIdentity = 250000` | `appsettings.json` |
| | | Jev decisions per player per day. | `DailyCallsPerIdentity = 5000` | `appsettings.json` |
| **Give-up time** | Timeout | Longest a hosted-model call may take. | 20 s total (chat models), 1.5 s (Jev) | `AzureOpenAIResilience.cs`, `JevOptions.cs` |

---

## Tier 3: Setup Guide

### 3.1 Run it

```powershell
docker compose up -d azurite
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj
# open http://localhost:5080
```

Every game has a demo mode where the computer plays both sides. That is the quickest way to
watch an agent without touching anything.

### 3.2 Change how hard an opponent is

There is no inspector panel. Settings are constants in source files; edit, rebuild, reload.

| To change | Edit | Notes |
|---|---|---|
| PoBrawl difficulty curve | `LEVELS` in `wwwroot/js/pobrawl/ai.js` | One row per rung. `reactionMs` lower is harder; the `P` values are chances from 0 to 1. |
| A president's fighting style | that president's block in `wwwroot/js/pobrawl/personalities.js` | `footwork`, three `aiPatterns`, and a `super`. The schema is documented at the top of the file. |
| A president's body | `wwwroot/js/pobrawl/fighters.js` | `heightScale`, `buildScale`, `mass`, `attackPower`, `moveAccel`. |
| Board-game CPU strength | `StrengthForElo` in `TicTacToeAI.cs` / `ConnectFiveAI.cs` | Rating thresholds map to search depth and blunder chance. |
| Horde monsters | `ARCHETYPES` in `wwwroot/js/povoxelstrike/enemies.js` | `hp`, `speed`, `meleeDamage`, `spitInterval`. Spawn pacing is in the spawn director below it. |
| Wall guns | constants at the top of `FortressGuns` in `wwwroot/js/povoxelstrike/fortress.js` | Range 120, reload 2.2 s, spread 0.035 rad. |
| PoSports CPU runners | `DIFFICULTIES` in `wwwroot/js/posports/ai.js` | The medium row is mirrored in `PoSportsConstants.cs` and pinned by a test; change both. |
| PoCabinet officials | the roster in `wwwroot/js/pocabinet/physics.js` **and** `PoCabinetSim.cs` | The two files are a line-for-line mirror. Change both or the lap verifier will reject laps. |
| PoRacer bots | `PoRacerAiDriver.cs` (personalities), `PoRacerRaceRegistry.cs` (tier pace and caution) | Server-side only. |
| Island creatures | `wwwroot/js/poecosystem/sim/creatures/species.js` and `sim/core/config.js` | PoEcosystem is watch-only by design; tune numbers, do not add player controls. |
| Arena creatures | `Shared/Games/PoJevArenaShared.cs` | Presets, ability costs, build budget of 80. |

### 3.3 Joint limits

Only two games have jointed bodies, and in both the joints are for falling over, not for
walking.

| Rig | Parts | Joints | Limits (cone / twist, radians) |
|---|---|---|---|
| PoBrawl KO ragdoll (`ragdollPhysics.js`) | 11 boxes | 10 cone-twist | waist 0.50 / 0.40 · neck 0.80 / 0.80 · shoulders 1.20 / 0.50 · elbows 0.90 / 0.30 · hips 1.00 / 0.40 · knees 0.90 / 0.25 |
| PoEcosystem biped ragdoll (`sim/physics/ragdoll.js`) | 7 boxes | 6 cone-twist | not listed here; see the file |
| PoEcosystem quadruped ragdoll | 6 boxes | 5 cone-twist | not listed here; see the file |

Everything else is a single body with no joints: a sphere (marbles, the PoVoxelStrike
player), a circle (PoRacer cars, arena units), a capsule (PoCabinet cars), or no physics
body at all (horde monsters, runners, living island creatures).

### 3.4 Hosted-model settings

Settings live under `PoMiniGames:AI` and `PoMiniGames:Jev` in `appsettings.json`, with
secrets in Azure Key Vault. Do not use `dotnet user-secrets` in this repo.

| Setting | Meaning |
|---|---|
| `PoMiniGames:AI:FoundryEndpoint` | Where the chat models live (Key Vault secret). |
| `PoMiniGames:AI:DefaultDeployment` | Model used when a game has no specific entry. |
| `PoMiniGames:AI:Deployments` | Map of `game` or `game.task` to a model name, for example `couplequiz.similarity`. |
| `PoMiniGames:AI:TokenBudget:DailyTokensPerIdentity` | Per-player daily spend cap. 0 turns it off. |
| `PoMiniGames:AI:QuizPrebake:*` | Background PoFunQuiz bank filler: `Enabled`, `Interval`, `Categories`, and `AllowAiTopUp` (off; the only part that spends). |
| `PoFunQuiz:QuestionSource` / `AllowFreshAi` / `BankTargetPerCategory` | `Bank` (free, default) or `FreshAi`; Fresh AI is served only to signed-in players while allowed. `PoFunQuiz:OpenTriviaDb:*` tunes the free source. |
| `PoCoupleQuiz:Features:QuestionSource` / `AllowFreshAi` / `AnswerMatching` / `AllowAiJudge` | `Bank` and `Smart` (free `AnswerMatcher`) by default; `FreshAi` and `AiJudge` apply only to a signed-in host. |
| `PoMiniGames:Jev:Brain` | `Local` (free rules, the default) or `Jev` (paid; also needs `ApiKey` and the player's opt-in). |
| `PoMiniGames:Jev:Model` | Pinned to `typesafe/jev-1.13`. |
| `PoMiniGames:Jev:CallTimeoutMs` | 1500. A late answer is dropped and the unit keeps its last order. |
| `<Game>:Features:UseMockAI` | Use canned answers when a paid path is chosen. Honoured only outside production. Tests force it on, and `appsettings.Development.json` turns it on for PoFunQuiz and PoCoupleQuiz so local runs spend nothing. |

Both quizzes and their answer-similarity scoring point at `gpt-5.4-nano`, the cheapest
model in `ModelPricing.cs`. The process-local usage, cost and caller-budget read-model is
`GET /api/diag/ai` (the AI half of `/api/diag`).

#### AI provider recipes

The quizzes play from their free banks by default. Development also sets the mock AI flags, so
even a Fresh AI or AI-judge request never calls a paid model locally,
even though `KeyVault:Uri` can resolve the shared Foundry endpoint. To try real model output
locally, opt in deliberately: set `PoFunQuiz:Features:UseMockAI` and/or
`PoCoupleQuiz:Features:UseMockAI` to `false`, and point the AI section at one of these.

- **Ollama (free, local, the recommended opt-in).** Run `ollama pull qwen3:4b`, then set
  `PoMiniGames:AI:FoundryEndpoint=http://localhost:11434/v1`, `Provider=openai`,
  `DefaultDeployment=qwen3:4b`, and clear the `Deployments` map so every game resolves the
  default. No key and no network. Add `ModelCapabilityOverrides={"qwen3:4b":"basic"}` if a
  structured-output call starts returning 400: the name heuristic assumes `qwen*` speaks
  `json_schema`, which older Ollama builds do not.
- **Gemini (paid, separate quota).** Google's OpenAI-compatibility endpoint is cheaper per
  token on the Flash-Lite tier: `FoundryEndpoint=https://generativelanguage.googleapis.com/v1beta/openai/`,
  `Provider=openai`, `ApiKey=<AI Studio key>`, `DefaultDeployment=gemini-2.5-flash-lite`.
  `AiModelCapabilities` already classifies `gemini-*` as conventional (json_schema and
  temperature, no reasoning_effort).
- **Embeddings for PoCoupleQuiz similarity.** An embedding deployment is the cheapest fix for
  answer scoring and does not need Azure: `ollama pull nomic-embed-text` plus
  `EmbeddingDeployment=nomic-embed-text` on the openai provider makes similarity scoring
  free, deterministic and permanently cacheable. `AiEmbeddingService` is provider-neutral.

### 3.5 Known gaps worth fixing before relying on these docs

Found while reading the code for this snapshot:

- **No strength tests exist** for either board-game opponent.
- ConnectFive declares an 8-second thinking budget (`AiMoveBudgetMs`) that nothing enforces.
- PoVoxelStrike monsters and PoRacer steering wobble use unseeded randomness, so their runs
  cannot be replayed exactly.
- PoBrawl demo mode can pair in BOB, whom the server's rating endpoint rejects.
- PoSports "hard" has a slightly higher typing error rate (0.01) than "medium" (0.008).

### 3.6 MarbleRace physics: Rapier migration plan

Status (2026-10-17): **planned, not started.** PoMarbleRace still runs on cannon-es 0.20.0, and
every other 3D game keeps cannon-es too. The swap was investigated and deliberately not
half-done: it cannot be verified without a browser, and a partial switch would leave two
physics engines fighting over the same marbles.

**Why switch.** cannon-es steps a variable number of substeps per frame (`stepWorld` in
`pomarblerace/physics.js` throws away the time it cannot catch up) and promises nothing about
identical float results across browsers. That is why online play is a host-authoritative relay
(`PoMarbleRaceShared.cs`: the host simulates, streams 101 positions at 15 Hz, the guest only
steers) and why the ghost of your best run (F5, `ghostTrack.js`) is a recorded *path* rather than
a replayed input log. Rapier's WASM build steps the same inputs to the same result on every
machine, which would let a ghost, a guest and the server all share one simulation.

**What it touches.** cannon-es is not wrapped behind an interface; game code reads and writes
cannon bodies directly.

| File | cannon-es use |
|---|---|
| `physics.js` | world, gravity, solver, seven contact materials (friction and restitution per pair) |
| `marbles.js` | 101 sphere bodies, mass spread, damping, `body.velocity` / `position` / `quaternion` |
| `track-glb.js` | chunked `CANNON.Trimesh` colliders (Int16 index cap, octree patch), static bodies |
| `track-procedural.js` | boxes, spheres, hinged turnstile paddles with motors (`driveMotors`) |
| `game.js` | steering, boost, brakes, kickers and unstick all add to `body.velocity`; `world.contacts` drives the on-track test, the elimination sweep and the audio surface |

**Plan, in order. Each step ships on its own and keeps online play working.**

1. **Physics port behind a seam.** Add `pomarblerace/physics-api.js` with what game code needs:
   `addSphere`, `addTrimesh`, `addBox`, `addHinge(motor)`, `velocity(body)` / `setVelocity`,
   `position`, `rotation`, `contactsOf(body) → material names`, `step()`. Implement it on
   cannon-es first and move every direct `body.*` and `world.contacts` access in `game.js`,
   `marbles.js` and the two track builders onto it. No behaviour change; this is the large,
   reviewable part.
2. **Fixed step, input-driven.** Replace the frame-dt accumulator with whole fixed steps at
   1/60 s and a step counter. Slow motion and hit-stop change how many steps a frame runs, never
   the step size. Steering, boost and kickers are applied per step from the step counter, not
   from wall time. The one `Math.random()` that touches play (the demo's random pick) takes a
   seeded generator; spark spawning stays random because it is visual only.
3. **Rapier implementation of the seam.** Load `@dimforge/rapier3d-compat` pinned to one exact
   version (for example `0.14.0`) from `cdn.jsdelivr.net/npm`, by a dynamic `import()` inside the
   MarbleRace engine only, never through the shared import map, so the other games never fetch
   it. `await RAPIER.init()` before the first `Game` is built (index.js `start()` already awaits
   the map load, so it goes there). Map cannon's pieces: sphere bodies to
   `RigidBodyDesc.dynamic()` + `ColliderDesc.ball`, trimesh chunks to `ColliderDesc.trimesh`
   (no Int16 cap, so the chunking can be relaxed), paddles to a revolute joint with a motor,
   contact-material pairs to per-collider friction/restitution with `CoefficientCombineRule`, and
   `world.contacts` to `world.contactPairsWith`. Enable CCD on marbles; the speed clamp and
   `sweepGuard` stay until measurements show CCD alone holds the shell.
   Cross-browser bit-exactness needs Rapier's enhanced-determinism build; check which compat
   package exposes it at the pinned version before relying on lockstep (step 6).
4. **Retune and verify headless-free.** A node test (`tests/pomarblerace-physics.test.mjs`)
   loads the compat build (it inlines its WASM, so node can run it), builds the procedural chute
   from a fixed seed with no renderer, steps 60 s of race twice and asserts identical marble
   positions, then checks the course invariants the cannon tuning was written for: no marble
   trapped on the shallowest descent (friction bracket 0.077–0.11 in `physics.js`), none
   tunnelling at 120 u/s, the field finishing inside `RACE_TIMEOUT`. Then one recorded headless browser
   pass per map for frame cost: 101 marbles against a trimesh course cost ~16.5 ms a step on
   cannon-es, and Rapier has to come in under that or the race runs in slow motion.
5. **Switch the default, keep a flag.** `?physics=cannon` keeps the old engine for one release;
   ghosts recorded on cannon stay valid because they are paths, not input logs.
6. **Then, and only then, lockstep.** With a deterministic step, online can send steering
   inputs per step instead of 101 positions at 15 Hz, and the ghost can become an input log
   replayed through the real simulation. Keep the relay as the fallback until both browsers'
   step checksums have been compared in production for a while.

**Online today, unchanged by any of this until step 6:** the host's `_netSend` streams Float32
positions plus a flag byte per marble through `PoMarbleRaceOnlineHub`; the guest eases toward
them in `_guestRacingFrame` and runs no physics at all.
