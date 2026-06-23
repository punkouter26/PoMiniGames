using System.Text.Json;
using Microsoft.JSInterop;
using PoSurvive.Shared.Constants;
using PoSurvive.Shared.Models;

namespace PoSurvive.Client.Services;

public sealed class SimulationLaunchService(IJSRuntime js, IConfiguration config)
{
    public async Task<SimulationConfigDto> BuildConfigAsync()
    {
        var overrides = await ReadOverridesAsync();

        return new SimulationConfigDto(
            TeamSize: overrides?.TeamSize ?? SimulationDefaults.TeamSize,
            RockDensity: overrides?.RockDensity ?? SimulationDefaults.RockDensity,
            FoodSpawnChance: overrides?.FoodSpawnChance ?? SimulationDefaults.FoodSpawnChance,
            FoodTtl: overrides?.FoodTtl ?? SimulationDefaults.FoodTtl,
            HungerDecayConstant: overrides?.HungerDecayConstant ?? SimulationDefaults.HungerDecayConstant,
            HungerThreshold: overrides?.HungerThreshold ?? SimulationDefaults.HungerThreshold,
            StarveHpLossPerTurn: overrides?.StarveHpLossPerTurn ?? SimulationDefaults.StarveHpLossPerTurn,
            BaseDamage: overrides?.BaseDamage ?? SimulationDefaults.BaseDamage,
            HeartbeatMinMs: SimulationDefaults.HeartbeatMinMs,
            HeartbeatMaxMs: SimulationDefaults.HeartbeatMaxMs,
            InferenceTimeoutMs: SimulationDefaults.InferenceTimeoutMs,
            MaxInferredAgentsPerTurn: overrides?.MaxInferredAgentsPerTurn
                ?? config.GetValue("Simulation:MaxInferredAgentsPerTurn", SimulationDefaults.MaxInferredAgentsPerTurn));
    }

    private async Task<E2EOverrides?> ReadOverridesAsync()
    {
        try
        {
            var json = await js.InvokeAsync<string?>("localStorage.getItem", "PoSurvive.E2EOverrides");
            if (string.IsNullOrWhiteSpace(json))
                return null;

            return JsonSerializer.Deserialize<E2EOverrides>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });
        }
        catch
        {
            return null;
        }
    }

    private sealed class E2EOverrides
    {
        public int? TeamSize { get; init; }
        public float? RockDensity { get; init; }
        public float? FoodSpawnChance { get; init; }
        public int? FoodTtl { get; init; }
        public float? HungerDecayConstant { get; init; }
        public float? HungerThreshold { get; init; }
        public int? StarveHpLossPerTurn { get; init; }
        public int? BaseDamage { get; init; }
        public int? MaxInferredAgentsPerTurn { get; init; }
    }
}
