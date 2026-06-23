namespace PoSurvive.Application.Interfaces;

using PoSurvive.Domain.Entities;
using PoSurvive.Shared.Models;

// SOLID: DIP — Application depends on this abstraction; Infrastructure provides the implementation
public interface ISessionRepository
{
    Task SaveSessionAsync(SimulationSession session, CancellationToken ct = default);
    Task SaveHeartbeatBatchAsync(IEnumerable<HeartbeatEventDto> events, CancellationToken ct = default);
}
