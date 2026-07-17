# PoRacer demo mode — 401 + spectator flow fix

## TL;DR

Two coupled bugs on `/poracer/demo`:
1. **SignalR negotiate returned 401** because `HubConnectionBuilder.WithUrl(string)`
   builds its own internal `HttpClient` that bypasses the DI-registered
   `IncludeCredentialsHandler` — the dev cookie set by `/api/auth/dev-login` never
   reached the negotiate POST, so `[Authorize]` rejected it.
2. **Demo didn't act like a demo** — the visitor was joining the lobby as the host
   and starting a multiplayer race, which meant they drove one car against 7 bots.
   User wanted the visitor to be a pure spectator over an 8-bot race.

## Root cause #1 — SignalR negotiate credentials

`HttpConnectionOptions.HttpClientFactory` does NOT exist in
`Microsoft.AspNetCore.Http.Connections.Client.HttpConnectionOptions` (verified by
inspecting `Microsoft.AspNetCore.Http.Connections.Client.xml` in the NuGet cache).
The correct property is `HttpMessageHandlerFactory`, typed as
`Func<HttpMessageHandler, HttpMessageHandler>` — it supplies the default inner
handler and we wrap it.

Wired via a shared helper
[src/PoMiniGames.Client/Services/SignalRCredentialsHttpClientFactory.cs](../../src/PoMiniGames.Client/Services/SignalRCredentialsHttpClientFactory.cs)
applied to every `WithUrl(url, options => …)` call across:
- `Games/PoRacer/PoRacerPage.razor` (lobby + race hubs)
- `Games/PoRacer/PoRacerLobbyPage.razor`
- `Games/PoCoupleQuiz/Services/CoupleQuizHubService.cs`
- `Games/PoFunQuiz/Services/FunQuizHubService.cs` (both default + SSE branches)

The DI `HttpClient` pipeline in `Program.cs` (`TransientRetryHandler → IncludeCredentialsHandler → HttpClientHandler`) only applies to calls going through the DI-registered `HttpClient`. SignalR doesn't use it. Without the helper, `HubConnection.StartAsync()` throws an `HttpRequestException` with the WASM-style message
`net::http_message_not_success_statuscode_reason.401. Unauthorized`.

## Root cause #2 — spectator demo

The previous `StartDemoRaceAsync` did the full multiplayer dance:
`ConnectLobbyAsync → ToggleReady → StartGame`. The visitor became the lobby host and
a real player in the race. To make the visitor a spectator over an 8-bot race, the
flow now just calls `ConnectRaceAsync("LOBBY")`. `PoRacerSim`'s constructor pads
an empty player list to 8 AI bots, so the race has a full grid with no humans.

Other changes in `PoRacerPage.razor` to support spectator mode:
- HUD shows `🤖 Spectator`, `Grid: 8 CPU drivers`, race clock — instead of fabricating
  a `Player?.Position` from a null car.
- Skip the 30 Hz input-send timer (server has no car with our connection ID).
- Skip score submit (`SubmitPlayerScoreAsync`) — no score to save.
- `GameShell`'s `GameOver` prop is already gated `Phase == Finished && !_isDemo`, so
  the end-of-race modal correctly stays hidden in demo.

## What did NOT help

- **`ForceSkipWebSockets` for SSE/LongPolling**: I tried FunQuiz's
  `PoMiniGames:FunQuiz:ForceSkipWebSockets` workaround for the dev-box WebSocket
  slowness (the 60s `UseResponseCompression` upgrade delay). It made the page
  connect in <1s but snapshots stopped arriving — server responded to every LP
  GET with `application/octet-stream` in 30-60ms instead of holding the connection
  open. Reverted; WebSocket-only is fine for this dev box even with the slow upgrade.
- A blanket `IHttpMessageHandlerBuilderFilter` that injects `IncludeCredentialsHandler`
  into every `HttpMessageHandlerBuilder` would also work as a global fix, but the
  per-call-site wiring is more explicit and the user's `IncludeCredentialsHandler`
  comments already document it as a deliberate choice.

## Dev-box quirk still applies

The 60-second WebSocket upgrade is still the worst UX issue for first-load demo.
FunQuiz handles it via the config flag above (and FunQuiz's snapshot delivery
keeps working because the snapshots are HTTP-shaped, not raw WS frames). PoRacer
relies on the live broadcast stream from the server's `SnapshotReady` event at
20Hz and doesn't survive the LP fallback in the test. If we ever want a fast
first-paint demo on this dev box, the fix is likely server-side
(`UseResponseCompression` → negotiated per-message-deflate or no compression on
hubs), not client-side transport choice.
