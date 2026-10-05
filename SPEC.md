# SPEC: PoMule (Project Octo-M.U.L.E.)

Game 15 of PoMiniGames, and the first screen built with Radzen. Module ownership is in
`CAPABILITY-MAP.md`. Numbers marked *(proposed)* are not in the PRD; they are starting values
to be tuned by the balance check in success criterion 11.

## 1. Objective

An 8-player take on the 1983 game M.U.L.E.: twelve months on a wrap-around planet where one
human and seven computer colonists claim land, outfit M.U.L.E.s, and trade four commodities
on a walking-floor market, all at the same time under one shared clock. The richest colonist
wins, but only if the colony as a whole survives.

Two modes ship in v1:

- **1 Player** (`/pomule/1player`): one human against seven AI opponents.
- **Demo** (`/pomule/demo`): eight AI opponents play full matches on a loop. It also runs in
  the hub demo reel and never posts a score.

## 2. User journeys

1. **Start a match.** From the hub card the player opens PoMule, sees the shared start card,
   picks one of eight species, and presses Play. The seven AI seats are filled with the seven
   archetypes, each on a different remaining species.
2. **Play a month.** Six phases run in order (section 6). The player moves with the keyboard
   or the touch pad; the announcement bar always says which phase is running and how long is
   left.
3. **Finish.** After month 12 the standings grid shows final Net Worth, the First Founder and
   the colony grade. The shared end modal offers Play Again and Home. If signed in, the score
   is posted; if offline, it is parked and sent later.
4. **Watch.** Demo mode plays without input at 4× speed, about 6 minutes a match. Any key or
   tap offers "Play it yourself".
6. **Come back.** A player who reloads or returns later sees "Continue" on the start card and
   resumes at the start of the month they were in.
5. **Compare.** The PoMule board on the leaderboards page ranks players by best Net Worth.

## 3. Tech stack (pinned)

| Item | Version | Notes |
|---|---|---|
| .NET SDK | 10.0.100, `rollForward: latestFeature` | `global.json` |
| Target framework | `net10.0` | `Directory.Build.props`; warnings are errors |
| Blazor WebAssembly | 10.0.12 | `Directory.Packages.props`; all ASP.NET 10.0.x pins moved from 10.0.10 for Radzen, and `Microsoft.OpenApi` from 2.7.5 to 2.12.0 to follow |
| **Radzen.Blazor** | **12.0.5** (MIT) | New. Trimmed Release publish is clean. Unused, it ships 41 KB of code and a 61 KB stylesheet (brotli) |
| Blazored.LocalStorage | 4.5.0 | Existing; string API only |
| xUnit / FluentAssertions | 2.9.3 / 8.8.0 | Existing |
| Playwright | 1.50.0 | Existing |
| Node test runner | built in | Existing pattern: `tests/*.test.mjs` |
| Storage | Azure Table Storage (Azurite locally) | Existing |

No new secrets, external APIs or AI models.

## 4. Commands

```powershell
dotnet build PoMiniGames.slnx                                   # build; any warning fails it
docker compose up -d azurite                                    # local storage
dotnet run --project src/PoMiniGames.API/PoMiniGames.API.csproj # http://localhost:5080
dotnet test tests/PoMiniGames.Unit --filter "FullyQualifiedName~PoMule"
dotnet test tests/PoMiniGames.Integration --filter "FullyQualifiedName~PoMule"
node --test tests/pomule-*.test.mjs                             # JS wrap and collision maths
pwsh scripts/css-lint.ps1                                       # stylesheet structure check
pwsh scripts/test-ceilings.ps1                                  # test-count budgets
pwsh scripts/test-all.ps1                                       # all tiers (Phase 5 only)
```

## 5. Project structure

```
src/PoMiniGames.Shared/Games/PoMule/     rules engine (pure C#, no I/O, seeded RNG)
src/PoMiniGames.Domain/Models/           PoMuleHighScore.cs; GameKey gains PoMule
src/PoMiniGames.Infrastructure/          PoMule HighScoreDescriptor
src/PoMiniGames.API/Features/PoMule/     high-score endpoints
src/PoMiniGames.Client/Games/PoMule/     PoMulePage.razor + Radzen components
src/PoMiniGames.Client/wwwroot/js/pomule/ canvas renderer, movement, collisions, touch pad
tests/PoMiniGames.Unit/Features/PoMule/  engine tests
tests/pomule-*.test.mjs                  renderer maths tests
```

## 6. Game rules

### 6.1 Month cycle

| # | Phase | Length *(proposed)* | What happens |
|---|---|---|---|
| 1 | Land grant and auction | 10 s grant; auction up to 20 s per plot | Every player claims one free plot; some months add an auction |
| 2 | Development | 45 s | All eight avatars are on the map at once |
| 3 | Production | 6 s | Yields, energy shutdowns, spoilage |
| 4 | Colony event | 4 s | At most one event |
| 5 | Market | 4 × 12 s | Food, Energy, Smithore, Crystite, one after another |
| 6 | Standings | 6 s or until dismissed | Net Worth ranking and colony status |

A full match is about 25 to 30 minutes.

### 6.2 World

- Grid of 24 columns × 8 rows. Column 24 wraps to column 1; rows 1 and 8 are hard edges.
- Four town hubs at row 4, columns 3, 9, 15 and 21 *(proposed)*, leaving 188 claimable plots.
- The seed decides the rest *(proposed mix)*: 3 north–south rivers (about 20 tiles), about
  40 mountain tiles with 1 to 3 peaks, about 10 valleys or craters, the remainder plains.
- Base yield per installed M.U.L.E. per month *(proposed)*, each ±1 at random:

| Terrain | Food | Energy | Smithore | Crystite |
|---|---|---|---|---|
| River | 4 | 2 | 1 | 0 |
| Plains | 2 | 3 | 1 | hidden 0–1 |
| Mountain (1 / 2 / 3 peaks) | 0 | 1 | 2 / 3 / 4 | hidden 0–1 |
| Valley or crater | 1 | 1 | 1 | hidden 2–4 |

- All towns share one Colony Store. Each town has an Outfitter, a Pub and an Assay Office.

### 6.3 Land

- **Grant:** all eight cursors move for 10 s. A tile picked by one player goes to that
  player. A tile picked by several goes to one of them at random; each loser gets the nearest
  unowned plot, searching outward in a spiral with column wrap. A player who picks nothing
  gets nothing that month.
- **Auction** *(proposed)*: on even months the Store auctions 2 random unowned plots, one at
  a time. Opening bid 160 credits, open ascending bids, highest bid when the clock stops wins.

### 6.4 Development

- One 45 s clock for everyone.
- **Food:** monthly need is 3 units (months 1–4), 4 (5–8), 5 (9–12) *(proposed, classic
  values)*. With the full need a player moves at 100%. Short of it, speed scales with the
  fraction held, floor 40%. With no food the player sits the month out.
- **Outfitter:** buy a M.U.L.E. at the Store's price (starts at 100), then a module: Food 25,
  Energy 50, Smithore 75, Crystite 100 *(proposed, classic values)*. One M.U.L.E. in tow at a
  time. Installing on a plot that already has one swaps them.
- **Assay Office:** walk in, then walk to a plot to reveal its Crystite level. Free.
- **Pub:** entering removes the avatar for the rest of the month and pays
  `min(250, secondsLeft × (3 + month))` credits *(proposed)*.
- **Dash:** 1.6× speed, 3 s of stamina, refilling 1 s per 4 s *(proposed)*.
- **Collisions:** avatars are solid and push each other by mass.
- **Runaway:** a towed M.U.L.E. bolts and is lost when (a) its owner is hit while either
  avatar is dashing, (b) its owner tries to install on a plot they do not own, or (c) the
  clock reaches zero before it is installed.
- **Energy:** each installed M.U.L.E. that is not producing Energy needs 1 Energy per month.
  A player who is short has that many M.U.L.E.s idle that month, lowest-value output first.

### 6.5 Production and spoilage

- Output per plot = terrain base × weather modifier, with species bonuses applied, 0 if idle.
- After production *(proposed, classic values)*: half of the Food above next month's need
  spoils; a quarter of the Energy above next month's need spoils; Smithore and Crystite above
  50 units are lost.

### 6.6 Colony events *(proposed list)*

One event with 75% probability each month, chosen evenly:

| Event | Effect this month |
|---|---|
| Solar Flare | Energy output × 1.5 |
| Acid Rain | Food output × 1.5 on rivers, Energy output × 0.5 |
| Pest Attack | One random player's best Food plot yields 0 |
| Planetquake | Smithore and Crystite output × 0.5 |
| Space Pirates | All Crystite held by players is stolen |
| Store Fire | The Store's Food, Energy and Smithore stock is destroyed |

### 6.7 Market

- Eight vertical lanes with the Store in the middle. Before each commodity every player is a
  seller (holds more than next month's need) or a buyer; the human may switch.
- Sellers start at the top and walk down to lower their ask; buyers start at the bottom and
  walk up to raise their bid. When the highest bid meets the lowest ask, one unit trades at
  that price every 0.25 s until a side moves away, runs out of goods or runs out of cash.
- The Store buys at its low price and sells at its high price while it has stock. Its prices
  move each month with colony supply against colony need.
- Store opening stock *(proposed)*: Food 32, Energy 32, Smithore 0, Crystite 0, M.U.L.E.s 28.
  Opening prices: Food 30, Energy 25, Smithore 50, Crystite 50–150 (random each month).
  Each month the Store turns every 2 Smithore it holds into 1 M.U.L.E.; the M.U.L.E. price
  follows the Smithore price.
- Players start with 4 Food and 2 Energy *(proposed)*.

### 6.8 Species

As in the PRD: Gollumoid (+15% Food on rivers), Voltronix (+1 free Energy per month),
Ore-Gorger (no mountain slowdown, +15% Smithore), Crystite-Weaver (800 credits, sees Crystite
without assay), Zephyr-Flapper (1,600 credits, +10% speed), Bonz-Crusher (cannot be pushed,
pushes others), Spheroid-Drifter (no terrain slowdown, runaway chance halved), Humanoid
Settler (1,200 credits, no modifiers). All others start with 1,000 credits.

### 6.9 AI archetypes

Four from the PRD and three new ones *(proposed, for approval)*:

| Archetype | Behaviour |
|---|---|
| Hoarder | Holds Food and Energy off the market until prices near their cap |
| Industrialist | Claims mountains, produces Smithore, controls M.U.L.E. supply |
| Prospector | Assays, chases Crystite, ignores farming |
| Agitator | Dashes into rivals who are towing M.U.L.E.s and blocks town doors |
| **Farmer** *(new)* | Claims rivers, sells Food surplus every month at fair prices; keeps the colony fed |
| **Speculator** *(new)* | Bids hard at land auctions; buys whatever is cheap on the floor and resells in later months |
| **Gambler** *(new)* | Does the minimum on the map, runs to the Pub early for the payout, spends it at auctions |

In Demo mode the eighth seat repeats one archetype chosen by the seed.

### 6.10 Scoring

- **Net Worth** = cash + 500 per plot + 350 per installed M.U.L.E. + goods at current Store
  prices *(values proposed)*. Highest is First Founder.
- **Colony grade** *(proposed)*: the colony survives if combined Net Worth is at least 60,000
  and there were at most 3 crisis months (a month where the colony's total Food or Energy was
  below the colony's total need). Otherwise it collapses, and the results say so above the
  winner's name.
- The leaderboard stores Net Worth, species, and whether the colony survived.

## 7. Architecture decisions

- The rules engine is plain C# in `PoMiniGames.Shared`, with no I/O and one seeded RNG, so the
  same seed and inputs always give the same match.
- JavaScript runs the 60 fps part of the development phase (movement, collisions, tether) and
  tells the engine about discrete events: entered a building, reached a plot, got bumped,
  M.U.L.E. bolted. The engine checks each against its own state (ownership, cash, stock,
  clock) before applying it. There is no per-frame interop.
- The market runs entirely in the engine at 10 ticks per second; JavaScript only draws it.
- The camera follows the player on a sideways-scrolling strip; a HUD panorama shows all 24
  columns with the seam.
- Layout (chosen from ten concepts, 2026-10-05): "split focus" on desktop. The map and
  panorama take the left three fifths; the right two fifths hold the timer, a "Your colony"
  card (cash, the four goods against this month's need, M.U.L.E. in tow, plots) and a rivals
  grid. On phones in landscape the map fills the screen with a cash pill, a timer pill, eight
  player dots, a stick on the left and Act and Dash buttons on the right.
- Components: `PoMulePage`, `PoMuleHud`, `PoMuleAuction`, `PoMuleStandings`. The species
  picker sits in the start card.
- Radzen provides every non-canvas element. The shared start card and end modal stay as the
  outer frame so PoMule opens and closes like the other games.
- PoMule follows the existing leaderboard and offline score-sync path with no new mechanism.

## 8. Code style

Match the surrounding code: file-scoped namespaces, `sealed record` for data, XML doc
comments that explain why, no interface with a single implementation.

```csharp
namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>One plot on the 24×8 planet. Column wraps; row does not.</summary>
public sealed record Plot(int Column, int Row, Terrain Terrain, int Peaks, int CrystiteLevel)
{
    public const int Columns = 24;
    public const int Rows = 8;

    /// <summary>Shortest east–west distance, going around the seam when that is closer.</summary>
    public static int ColumnDistance(int a, int b)
    {
        var d = Math.Abs(a - b);
        return Math.Min(d, Columns - d);
    }
}
```

JavaScript follows the other engines in `wwwroot/js/`: ES modules, no build step, no
framework.

## 9. Testing strategy

| Level | Framework | PoMule scope | Budget today |
|---|---|---|---|
| Unit | xUnit + FluentAssertions | Every engine rule in section 6: about +40 | 100 of 100 used; ceiling raised to 140 |
| Integration | xUnit + Testcontainers Azurite | High-score save and read: +2 | 46 of 50 |
| API end to end | xUnit over HTTP | Post and list scores: +1 | 24 of 25 |
| UI end to end | Playwright | Start a match; demo reaches month 2: +2 | 23 of 25 |
| JS | `node --test` | Wrap maths, collision push, tether snap | no cap |

- Coverage target: 90% of lines in `Shared/Games/PoMule/`.
- Build order per task: failing test, passing code, the tests related to the change, build,
  commit. The full suite runs once, in Phase 5. Tests are never weakened or deleted to pass.
- The balance check (criterion 11) runs 100 seeded 8-AI matches inside one unit test.

## 10. Boundaries

**Always**
- Keep the engine deterministic: all randomness through the seeded RNG, no clock reads.
- Fix every compiler warning; restart the app after a change and confirm it comes up.
- Keep `SPEC.md` and `tasks/todo.md` in step when a decision changes.
- Work on `master`, one commit per task.

**Ask first**
- Raising any test ceiling.
- Bumping pinned package versions beyond what Radzen needs.
- Changing shared components, shared CSS or anything in another game's folder.
- Any deploy, infrastructure or storage-schema change beyond the new PoMule table rows.

**Never**
- Use `dotnet user-secrets`, or commit a secret.
- Spend AI tokens from a test.
- Post a score from Demo mode.
- Migrate other screens to Radzen in this effort.

## 11. Out of scope for v1

Online play; server score verification; AI-written text; saving a match in progress across
devices; difficulty levels; shorter match lengths; plot adjacency and learning-curve
production bonuses; personal good-luck and bad-luck events; gamepad support; a 3D globe;
Radzen in the hub, settings, leaderboards or other games (next effort after v1).

## 12. Edge cases and error states

| Case | Behaviour |
|---|---|
| Two cursors on one tile | Random winner; losers get the nearest free plot by spiral search |
| No free plot left | Loser gets nothing; land auctions stop |
| Avatar or camera crosses the seam | No jump, gap or duplicate; distance and AI paths use the short way round |
| Store has no M.U.L.E.s | Outfitter shows "sold out"; AI falls back to its next goal |
| Not enough cash | Purchase or bid refused with a notice; no negative balances, ever |
| Clock ends with a M.U.L.E. in tow | It bolts; the purchase money is not refunded |
| Player has no Food | Sits out development; still takes part in land grant and market |
| Buyer runs out of cash mid-trade | Trading stops at the last unit they could afford |
| Tab hidden or phone locked | Match pauses; resumes on return |
| Page reloaded mid-match | Start card offers "Continue" from the start of the current month |
| Saved match is from an older engine version | Discarded silently; start card shows only Play |
| Score post fails or player is offline | Score parked locally and sent later (existing path) |
| Player not signed in (dev guest aside) | Sign-in gate applies as for every game |
| Touch device in portrait | Prompt to rotate; game stays paused |
| JS engine fails to load | Existing engine-loader error card with Retry |

## 13. Success criteria

1. A 1 Player match starts with 1 human and 7 AI seats, each a different archetype and
   species; Demo starts with 8 AI seats.
2. An avatar or cursor leaving column 24 appears in column 1 on the next frame with no
   clipping; the unit test for wrap distance passes for every column pair.
3. During development all 8 avatars move at once under one 45 s clock, shown by a Playwright
   run in which at least 6 avatars change position within the same second.
4. Colliding avatars are displaced by mass; Bonz-Crusher is never displaced (JS test).
5. A contested plot goes to exactly one claimant and every loser receives the nearest free
   plot (unit test over 1,000 seeds, no plot owned twice).
6. The market renders 8 lanes and executes a trade when a buyer and seller meet, at the
   meeting price (unit test plus screenshot).
7. The same seed and inputs produce an identical final state on two runs (unit test).
8. No balance or stock value is ever negative across 100 seeded AI matches.
9. A finished 1 Player match appears on the PoMule leaderboard; with the network off, it
   appears after reconnecting. Demo matches never appear.
10. Keyboard and touch can both complete a full month (Playwright, desktop and phone sizes).
11. Balance, over 100 seeded 8-AI matches: the Store still has at least 1 M.U.L.E. for sale
    at the end of month 1 in every match; the colony survives in 40% to 90% of matches; no
    single archetype wins more than 40%.
12. `dotnet build PoMiniGames.slnx` finishes with 0 warnings, and the published client is no
    more than 1.5 MB larger (compressed) than before Radzen.
13. A 12-month Demo match completes with no console errors and holds 50 fps or better on the
    development phase on a mid-range laptop.
14. PoMule's page uses Radzen for all non-canvas UI; `css-lint.ps1` passes.
15. Reloading the page in month 3 and pressing Continue restores month 3's opening cash,
    land and stock exactly (unit test on the save record, plus a Playwright run).
16. A 12-month Demo match finishes in 5 to 8 minutes.

## 14. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Radzen 12.0.5 needs ASP.NET Components ≥ 10.0.12; the repo pins 10.0.10 and treats the downgrade warning as an error | First task of the plan: bump the `Microsoft.AspNetCore.*` 10.0.x pins together, or pick the newest Radzen that accepts 10.0.10 |
| R2 | The client is trim-analysed with warnings as errors; Radzen may raise trim warnings on publish | Same first task publishes a trimmed build before any game code is written |
| R3 | Radzen's theme CSS leaks into the 14 existing games | Load the Radzen stylesheet only on the PoMule route until the migration effort |
| R4 | Unit tier has no room | Resolved: ceiling raised to 140 (decision 1) |
| R5 | A 30-minute match with no resume loses players | Resolved: month-boundary resume (decision 2) |

## 15. Decisions (answered 2026-10-05)

1. **Unit test ceiling** rises from 100 to 140. PoMule engine tests use `[Theory]` rows so
   about 40 methods cover the engine.
2. **Resume after reload:** the engine state is saved to local storage at the end of each
   month and the start card offers "Continue". Finishing or abandoning a match clears it.
3. **New archetypes:** Farmer, Speculator and Gambler are approved.
4. **Match length:** 25 to 30 minutes for 1 Player. Demo runs faster: 4× game speed with
   phases 3, 4 and 6 cut to 1 s each, so a full match takes about 6 minutes.
5. **Radzen theme:** Material Dark.

No open questions remain.
