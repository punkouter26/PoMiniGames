using System.Text.Json.Serialization;
using PoMiniGames.Shared.Simulation.Models;

namespace PoMiniGames.Features.PoSurvive.Storage;

/// <summary>
/// Source-generated STJ context for the payloads the PoSurvive relay serialises into a prompt.
/// Keeps the hot path off reflection-based <c>JsonSerializer.Serialize</c>, matching
/// <c>EvolutionJsonContext</c> and the client's <c>ApiJsonContext</c>.
/// </summary>
[JsonSerializable(typeof(PersonalityDnaDto))]
internal sealed partial class PoSurviveJsonContext : JsonSerializerContext;
