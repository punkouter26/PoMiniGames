# PoCabinet race harness

PoCabinet's physics runs in two copies that must agree to the last bit:
`src/PoMiniGames.Client/wwwroot/js/pocabinet/physics.js` + `track.js` (solo races in the browser)
and `src/PoMiniGames.API/Features/PoCabinet/` (`PoCabinetPhysics`, `PoCabinetAiDriver`,
`PoCabinetTrack`; the lap verifier and online races). These tools race the browser copy in
node, so track and physics changes can be checked without a browser, and regenerate the lap
proofs the tests replay.

1. Dump the worlds the page hands race.js (the same JSON, from the shared C#):

   ```powershell
   dotnet run scripts/pocabinet/dump.cs -- artifacts/pocabinet-worlds capitol maralago pressbriefing playground senate today
   ```

   `today` is today's daily circuit; `daily:7` dumps the next seven.

2. Race a 100-car field on one (the player on the demo autopilot from grid slot 50):

   ```powershell
   node scripts/pocabinet/harness.mjs race capitol clean      # or messy / wild; add 1 for rain
   node scripts/pocabinet/harness.mjs profile senate 12       # where the field slows down, per knot
   node scripts/pocabinet/harness.mjs log pressbriefing       # wrecks and stalled cars
   node scripts/pocabinet/harness.mjs svg maralago            # top-down preview: run-off, kerbs, patches, dividers, line
   ```

   A healthy track: the field's median lap within a few seconds of its best, a handful of
   wrecks, few "stuck" events (a car under 5 u/s for 4 s) and no knot where most cars are slow.

3. Regenerate the lap proofs after an intended physics or track change (it searches the
   "messy" driver's line until Capitol orders messy < clean < wild, which
   `PoCabinetScoreStorageTests` needs):

   ```powershell
   node scripts/pocabinet/gen.mjs tests/Shared/Fixtures/pocabinet-lap-proofs.txt
   dotnet test tests/PoMiniGames.Unit --filter "FullyQualifiedName~PoCabinet"
   ```

   `PoCabinetLapVerifierTests` replays every proof in C# and needs the browser's lap time
   exactly; a mismatch means the two copies have drifted apart.
