namespace PoSurvive.Domain.Entities;

using System.Text.Json.Serialization;

/// <summary>
/// Source-generated STJ context for the small JSON payloads persisted on
/// <see cref="EvolutionRecord"/>. Using generated <see cref="System.Text.Json.Serialization.Metadata.JsonTypeInfo"/>
/// keeps the serialization path trim-safe (no reflection-based <c>JsonSerializer.Serialize</c>),
/// so <see cref="EvolutionRecord"/> stays clean under the WASM client's PublishTrimmed audit.
/// </summary>
[JsonSerializable(typeof(IReadOnlyList<string>))]
[JsonSerializable(typeof(List<string>))]
public sealed partial class EvolutionJsonContext : JsonSerializerContext;
