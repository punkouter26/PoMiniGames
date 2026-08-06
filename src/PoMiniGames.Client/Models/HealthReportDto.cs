namespace PoMiniGamesClient.Models;

/// <summary>
/// Client-side view of the <c>GET /api/health</c> report, rendered by
/// <c>Pages/HealthPage.razor</c>.
/// </summary>
/// <remarks>
/// A read-model, not a mirror: the server's response also carries <c>totalDuration</c> and
/// <c>checkedAtUtc</c>, which the page does not display (it stamps its own poll time, so a
/// server clock skew cannot make a stale reading look fresh). Unlisted properties are
/// ignored on deserialization, so the endpoint can grow fields without touching this type.
/// </remarks>
public sealed record HealthReportDto(string Status, IReadOnlyList<HealthCheckEntryDto> Checks)
{
    /// <summary>
    /// Empty rather than null when the payload omits <c>checks</c>, so the page can enumerate
    /// unconditionally instead of guarding every render path.
    /// </summary>
    public IReadOnlyList<HealthCheckEntryDto> Checks { get; init; } = Checks ?? [];
}

/// <summary>One dependency's entry in the health report.</summary>
/// <param name="Name">Registration name of the check (e.g. the storage account probe).</param>
/// <param name="Status">ASP.NET <c>HealthStatus</c> name: Healthy / Degraded / Unhealthy.</param>
/// <param name="Description">Free-text detail; null for a check that passed silently.</param>
/// <param name="Duration">Milliseconds the check took.</param>
public sealed record HealthCheckEntryDto(
    string Name,
    string Status,
    string? Description,
    double Duration);
