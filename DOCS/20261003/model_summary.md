# Agent & Rig Inventory

Snapshot date: 2026-10-03, AI rows revised 2026-10-17. See also [architecture_overview.md](architecture_overview.md) and
[creatures_dashboard.html](creatures_dashboard.html).

---

## Tier 1: Quick Look (30 seconds)

- **19 agent families** across 13 of the 14 games. 15 are hand-written rules, 1 is a small
  on-device model and 3 are hosted models.
- **Paid AI is opt-in only.** Every hosted model sits behind a free default (a question bank,
  free answer matching, or the local Jev rules) and runs only when a signed-in player picks it.
  Ecosystem, Brawl and Cabinet use no AI service at all; their text is scripted.
- **0 trained model files.** No `.onnx`, `.pt`, `.nn` or weights of any kind are in the repo.
  The "Brain Model File" column below lists the source file that holds the rules instead.
- **No success rates have been measured** for any agent. The only recorded performance data
  is five PoCabinet laps kept as test fixtures.
- **Everything listed as "Live in game" ships today.** Two items are test-only stand-ins.

---

## Tier 2: Core Mechanics

### Agent Model Table

"Final Success Rate" is the template's column name. Nothing here was trained, so the column
reports whatever real evidence exists and says "not measured" otherwise. File sizes are the
source files on disk on the snapshot date.

#### Hand-written agents

| Agent Name | Game | Brain Model File | File Size | Task Type | Final Success Rate | Deployment Status |
|---|---|---|---|---|---|---|
| Four-in-a-row CPU | TicTacToe | `Client/Games/TicTacToe/TicTacToeAI.cs` | 7.9 KB | Turn-based board play (search 4 moves ahead) | Not measured. No strength tests exist. | Live in game |
| Five-in-a-row CPU | ConnectFive | `Client/Games/ConnectFive/ConnectFiveAI.cs` + `NegamaxSearch.cs` | 4.6 KB + 6.6 KB | Turn-based board play (search 1 to 4 moves ahead) | Not measured. No strength tests exist. | Live in game |
| President boxers (15) | PoBrawl | `wwwroot/js/pobrawl/ai.js` + `personalities.js` | 28.0 KB + 32.3 KB | Real-time 1 v 1 fighting | Not measured in the repo. A live rating board exists in cloud storage; every fighter starts at 1000. | Live in game |
| Swarmer / Brute / Spitter | PoVoxelStrike | `wwwroot/js/povoxelstrike/enemies.js` | 14.5 KB | Chase and attack the player | Not measured. | Live in game (solo Survival only) |
| Fortress wall guns (22) | PoVoxelStrike | `wwwroot/js/povoxelstrike/fortress.js` | 22.2 KB | Aim and fire at the player | Not measured. | Live in game |
| Kiosk demo bot | PoVoxelStrike | `wwwroot/js/povoxelstrike/game.js` | not sized | Walk to the objective, blast through walls | Not measured. A code comment records one run stuck for 85 s before a fix. | Live in game (demo mode) |
| Cabinet officials (4) + field (95) | PoCabinet | `wwwroot/js/pocabinet/physics.js` (server twin `PoCabinetAiDriver.cs`) | 27.6 KB (11.3 KB) | Circuit racing in traffic | Test requires each official to lap in 12 to 60 s. Five recorded 100-car runs are stored as fixtures. | Live in game |
| Racing bots (99 in solo; 100 in demo) | PoRacer | `API/Features/PoRacer/PoRacerAiDriver.cs` + `PoRacerSim.cs` | 2.3 KB + 42.0 KB | Circuit racing on a centre line | Not measured. Code comments give oval laps of about 27 / 21 / 16 s for easy / medium / hard. Online rooms remain capped at 8 cars. | Live in game |
| Marble pack (100) | PoMarbleRace | `wwwroot/js/pomarblerace/marbles.js` | 46.2 KB | None. Passive physics bodies with no brain. | Test requires 96 of 101 marbles to finish every map. | Live in game |
| Island creatures (4 species) | PoEcosystem | `wwwroot/js/poecosystem/sim/behavior/utility.js` + `sim/creatures/species.js` | 4.9 KB + 3.5 KB | Survive: eat, drink, flee, hunt, mate, build | No score by design. A code comment records wolves dying out in 11 of 32 twenty-year runs. | Live in game |
| Island tribes (3) | PoEcosystem | `wwwroot/js/poecosystem/sim/tribe/` | not sized | Research, diplomacy, war and peace | Not measured. | Live in game |
| Colonist personalities (7) | PoMule | `Shared/Games/PoMule/PoMuleAi.cs` | 11.7 KB | Claim land, outfit M.U.L.E.s, bid and sell | A unit test plays 100 seeded matches: no personality wins more than 40. | Live in game |
| Arena unit executor | PoJevArena | `wwwroot/js/pojevarena/sim.js` + `scheduler.js` | 51.3 KB + 4.2 KB | Carry out the order Jev gave | Not measured. | Live in game |

#### Hosted-model agents

None of these has a model file in the repo. The "brain" is a remote model; the file listed
is the service that builds the request and checks the answer. Each paid row is gated twice:
a server setting has to allow it, and a signed-in player has to choose it in the game or in
Settings. Calls count against the per-player daily token budget (quizzes) or the daily Jev
call cap (arena).

| Agent Name | Game | Service File | File Size | Model (from `appsettings`) | Task Type | Fallback when unavailable | Deployment Status |
|---|---|---|---|---|---|---|---|
| Jev | PoJevArena | `Features/PoJevArena/JevPromptBuilder.cs` + `Jev/JevClient.cs` | 10.1 KB + 8.4 KB | `typesafe/jev-1.13` | Pick a tactic, a target and a panic level for one unit | None. The unit keeps its last order. | Opt-in (Brain=Jev + player choice) |
| Local Jev brain | PoJevArena | `Features/PoJevArena/Jev/LocalJevClient.cs` | 9 KB | Rules (target bias, focus fire, HP and odds panic) | Same three answers as Jev, free | None needed | Live in game (default) |
| On-device AI | PoJevArena | `wwwroot/js/localAi.js` | 5 KB | WebLLM `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` in the browser | Serves the Jev brain for one unit at a time | Rule answer on timeout (1.5 s) or bad JSON | Opt-in setting, off by default |
| Fresh AI quiz writer | PoFunQuiz | `Features/PoFunQuiz/AiQuizGeneratorService.cs` | 33.2 KB | `funquiz` key (`gpt-5.4-nano`) | Write multiple-choice trivia | The free question bank (`PoFunQuizBank` table, filled from Open Trivia DB and a bundled set) | Opt-in (`PoFunQuiz:QuestionSource` / `AllowFreshAi` + player choice) |
| Couple-quiz writer and AI judge | PoCoupleQuiz | `Features/PoCoupleQuiz/AiQuestionService.cs` | 18.7 KB | `couplequiz` / `couplequiz.similarity` (`gpt-5.4-nano`) | Write a question; judge close-call answer pairs | The curated question bank and free `AnswerMatcher` scoring | Opt-in (`PoCoupleQuiz:Features:*` + a signed-in host) |

Production model names come from Azure Key Vault and could not be confirmed from the repo.

#### Test-only stand-ins

| Agent Name | File | Behaviour | Deployment Status |
|---|---|---|---|
| Stub Jev | `Features/PoJevArena/Jev/StubJevClient.cs` | Always answers `melee_charge`, confidence 0.6, panic 0.1 | Testing |
| Mock quiz and question services | `MockQuestionService.cs`, `MockOpenAIService` | Canned answers, no network | Testing |

### Physics & Rig Table

| Character Name | Physics Setup | Unity equivalent | Movement Type | Moving Parts | Main Objective |
|---|---|---|---|---|---|
| PoBrawl boxer (alive) | One kinematic sphere (radius 0.55) in cannon-es; a 15-joint visual skeleton posed by animation | Kinematic Rigidbody + Animator | Velocity, written directly | 1 body, 15 visual joints | Knock out the opponent inside 60 s |
| PoBrawl boxer (knocked out) | Ragdoll built at KO time: 11 boxes, 10 cone-twist joints | Ragdoll of ConfigurableJoints | Physics (launched by the final hit) | 11 | Fall over convincingly |
| PoVoxelStrike swarmer | No physics body; a 1.1 m cube moved each frame | Transform move, no Rigidbody | Direct position | 1 | Reach and bite the player |
| PoVoxelStrike brute | No physics body; a 2.2 x 2.6 x 2.2 m box | Transform move | Direct position | 1 | Smash through walls to reach the player |
| PoVoxelStrike spitter | No physics body; a 1.7 m cone | Transform move | Direct position | 1 | Hold 22 to 34 m away and shoot |
| PoVoxelStrike wall gun | Static mount and barrel, aimed with look-at | Static object with a turret script | None (rotation only) | 1 | Shoot the player while its wall still stands |
| PoVoxelStrike demo bot | cannon-es sphere (radius 0.45, mass 80), rotation locked | Rigidbody sphere, frozen rotation | Velocity on the ground, gravity in the air | 1 body, 4 visual limb pivots | Reach the chalice |
| PoCabinet car | Custom 2D arcade model; capsule hull 39 x 17 | Custom vehicle script | Speed along heading, grip-limited turn | 1 | Best lap; finish in the top 25 to clear a stage |
| PoRacer car | Custom C# model on the server; circle radius 18 | Custom vehicle script | On-or-off steering and pedals | 1 | Best lap over 3 laps |
| PoMarbleRace marble | cannon-es sphere (radius 1.0, mass 0.75 to 1.25) | Rigidbody sphere | Physics only (gravity, boost pads, kickers) | 1 | Reach the bottom; top 10 of 101 scores |
| PoEcosystem rabbit / deer / wolf (alive) | No rigid body; moved over a height map | NavMesh-free kinematic mover | Velocity intent | 1 | Stay alive and reproduce |
| PoEcosystem human (alive) | Same as above | Same | Velocity intent | 1 | Stay alive, chop wood, build huts |
| PoEcosystem creature (dead) | Cosmetic ragdoll: quadruped 6 boxes and 5 joints, biped 7 boxes and 6 joints | Ragdoll | Physics, cosmetic only | 6 or 7 | None. No rule reads it. |
| PoJevArena unit | Custom 2D; one circle sized by mass | Rigidbody2D circle | Force, limited by grip and stamina | 1 | Wipe the other team or lead on health at 180 s |
| Board-game CPU | None | None | Places a piece | 0 | Complete a line |

---

## Tier 3: Setup Guide

### Adding a new agent to this inventory

1. Put the rules next to the game: `wwwroot/js/<game>/ai.js` for a browser game, or
   `Features/<Game>/` for a server-simulated one.
2. Keep difficulty in one table at the top of the file, as the existing agents do.
3. If the game is simulated on both client and server (PoCabinet), mirror the
   constants in both and add a sync test.
4. Add a row to both tables above.

### If a trained model is ever added

This is the checklist the template assumes, for the day a real `.onnx` brain arrives:

| Step | What to record here |
|---|---|
| Export the model | File name, size on disk, date trained |
| Record its evaluation | Success rate over a fixed number of episodes, with the seed |
| Decide where it runs | Browser (ONNX Runtime Web) or server (ONNX Runtime) |
| Set its status | Testing until it passes the same checks the rule-based agent it replaces passes |

### Refreshing the file sizes

```powershell
Get-ChildItem src -Recurse -Include ai.js,*AI.cs,*AiDriver.cs,enemies.js |
  Select-Object FullName, Length
```
