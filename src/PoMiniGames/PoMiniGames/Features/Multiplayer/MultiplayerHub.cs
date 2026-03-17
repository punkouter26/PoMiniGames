using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.Multiplayer;

[Authorize]
public sealed class MultiplayerHub : Hub
{
    private readonly IMultiplayerService _service;
    private readonly ILogger<MultiplayerHub> _logger;
    private readonly IHubContext<MultiplayerHub> _hubContext;

    public MultiplayerHub(IMultiplayerService service, ILogger<MultiplayerHub> logger, IHubContext<MultiplayerHub> hubContext)
    {
        _service = service;
        _logger = logger;
        _hubContext = hubContext;
    }

    public override async Task OnConnectedAsync()
    {
        if (AuthenticatedUser.TryCreate(Context.User, out var user) && user is not null)
        {
            _logger.LogInformation("Multiplayer hub connected for {UserId}", user.UserId);
            var snapshots = _service.SetPresence(user, connected: true);
            foreach (var snapshot in snapshots)
            {
                await MultiplayerEndpoints.BroadcastSnapshotAsync(_hubContext, snapshot);
            }
        }

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (AuthenticatedUser.TryCreate(Context.User, out var user) && user is not null)
        {
            _logger.LogInformation("Multiplayer hub disconnected for {UserId}", user.UserId);
            var snapshots = _service.SetPresence(user, connected: false);
            foreach (var snapshot in snapshots)
            {
                await MultiplayerEndpoints.BroadcastSnapshotAsync(_hubContext, snapshot);
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    public async Task SendRealtimeInput(string matchId, JsonElement payload)
    {
        if (!AuthenticatedUser.TryCreate(Context.User, out var user) || user is null)
        {
            throw new HubException("The current connection is not authenticated.");
        }

        var envelope = _service.BuildRealtimeEnvelope(matchId, user, payload);
        if (envelope is null)
        {
            throw new HubException("Realtime input is not available for this match.");
        }

        await Clients.Users(envelope.RecipientUserIds).SendAsync("RealtimeInput", new
        {
            matchId = envelope.MatchId,
            fromUserId = envelope.FromUserId,
            fromDisplayName = envelope.FromDisplayName,
            payload = envelope.Payload,
            sentAt = DateTimeOffset.UtcNow,
        });
    }
}
