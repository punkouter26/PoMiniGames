using System.Text.Json;
using Microsoft.JSInterop;
using PoShared.Simulation.Constants;
using PoShared.Simulation.Models;

namespace PoMiniGamesClient.Games.PoSurvive.Services;

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
                ?? (int.TryParse(config["Simulation:MaxInferredAgentsPerTurn"], out var _maxAgents) ? _maxAgents : SimulationDefaults.MaxInferredAgentsPerTurn));
    }

    private async Task<E2EOverrides?> ReadOverridesAsync()
    {
        try
        {
            var json = await js.InvokeAsync<string?>("localStorage.getItem", "PoSurvive.E2EOverrides");
            if (string.IsNullOrWhiteSpace(json))
                return null;

            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            return new E2EOverrides
            {
                TeamSize               = TryGetInt(root, "teamSize")   ?? TryGetInt(root, "TeamSize"),
                RockDensity            = TryGetFloat(root, "rockDensity") ?? TryGetFloat(root, "RockDensity"),
                FoodSpawnChance        = TryGetFloat(root, "foodSpawnChance") ?? TryGetFloat(root, "FoodSpawnChance"),
                FoodTtl                = TryGetInt(root, "foodTtl")    ?? TryGetInt(root, "FoodTtl"),
                HungerDecayConstant    = TryGetFloat(root, "hungerDecayConstant") ?? TryGetFloat(root, "HungerDecayConstant"),
                HungerThreshold        = TryGetFloat(root, "hungerThreshold") ?? TryGetFloat(root, "HungerThreshold"),
                StarveHpLossPerTurn    = TryGetInt(root, "starveHpLossPerTurn") ?? TryGetInt(root, "StarveHpLossPerTurn"),
                BaseDamage             = TryGetInt(root, "baseDamage") ?? TryGetInt(root, "BaseDamage"),
                MaxInferredAgentsPerTurn = TryGetInt(root, "maxInferredAgentsPerTurn") ?? TryGetInt(root, "MaxInferredAgentsPerTurn"),
            };
        }
        catch
        {
            return null;
        }
    }

    private static int? TryGetInt(JsonElement root, string name)
    {
        if (root.TryGetProperty(name, out var el) && el.TryGetInt32(out var v)) return v;
        return null;
    }

    private static float? TryGetFloat(JsonElement root, string name)
    {
        if (root.TryGetProperty(name, out var el) && el.TryGetSingle(out var v)) return v;
        return null;
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
