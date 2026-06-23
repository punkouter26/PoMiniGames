namespace PoSurvive.Application.Interfaces;

using PoSurvive.Application.DTOs;

// SOLID: DIP — Application depends on this abstraction; Infrastructure provides the implementation
public interface ISimulationRepository
{
    Task<SimulationConfig> GetConfigAsync(CancellationToken ct = default);
}
