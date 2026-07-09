namespace PoMiniGames.Application.Simulation;

using PoMiniGames.Domain.Entities.Simulation;
using PoShared.Simulation.Models;

// SOLID: DIP — Application depends on this abstraction; Infrastructure provides the implementation
public interface ISessionRepository
{
    Task SaveSessionAsync(SimulationSession session, CancellationToken ct = default);
    Task SaveHeartbeatBatchAsync(IEnumerable<HeartbeatEventDto> events, CancellationToken ct = default);
}
