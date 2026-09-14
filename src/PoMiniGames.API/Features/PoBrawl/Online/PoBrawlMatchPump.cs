using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Drives the per-match simulation tick. Hosted as a singleton service so the
/// tick survives the wiring hub connection leaving. When a match is finished
/// the pump finalises the result, broadcasts it once, and clears the registry
/// so the next lobby round can start cleanly.
/// </summary>
public sealed class PoBrawlMatchPump : BackgroundService
{
    private readonly PoBrawlMatchRegistry _registry;
    private readonly PoBrawlLobbyService _lobby;
    private readonly IHubContext<PoBrawlMatchHub> _hubContext;
    private readonly ILogger<PoBrawlMatchPump> _log;

    public PoBrawlMatchPump(
        PoBrawlMatchRegistry registry,
        PoBrawlLobbyService lobby,
        IHubContext<PoBrawlMatchHub> hubContext,
        ILogger<PoBrawlMatchPump> log)
    {
        _registry = registry;
        _lobby = lobby;
        _hubContext = hubContext;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromMilliseconds(1000 / PoBrawlMatchService.TickHz);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(interval, stoppingToken);
                await TickOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "PoBrawl match pump tick failed; continuing.");
            }
        }
    }

    private async Task TickOnceAsync(CancellationToken ct)
    {
        var match = _registry.Current;
        if (match is null) return;
        var snap = match.Tick();
        if (snap is null) return; // already finished in a previous tick
        await _hubContext.Clients.Group(MatchGroup(match.MatchId))
            .SendAsync("matchState", snap, ct);
        if (snap.Finished)
        {
            await BroadcastFinalResultsAsync(match, ct);
            _registry.ClearCurrent();
        }
    }

    /// <summary>
    /// Broadcast a per-connection final result. The match result is shaped per
    /// recipient (each client sees its own side as "local"), so this iterates the
    /// lobby roster's connection ids. Connections that have already dropped
    /// receive nothing — the result endpoint can still POST when they reconnect.
    /// </summary>
    private async Task BroadcastFinalResultsAsync(PoBrawlMatchService match, CancellationToken ct)
    {
        // Use the lobby roster as the source of truth for "who was in this match",
        // because a connection might have dropped but the player is still entitled
        // to see the result when they reconnect.
        foreach (var player in match.Roster)
        {
            var result = match.BuildResultFor(player.ConnectionId);
            await _hubContext.Clients.Client(player.ConnectionId)
                .SendAsync("matchFinished", result, ct);
        }
    }

    private static string MatchGroup(string matchId) => $"pobrawl-match-{matchId}";
}
