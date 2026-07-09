namespace PoMiniGames.Application.Simulation;

using PoMiniGames.Application.Simulation;

// SOLID: DIP — Application depends on this abstraction; Infrastructure provides the implementation
public interface ISimulationRepository
{
    Task<SimulationConfig> GetConfigAsync(CancellationToken ct = default);
}
