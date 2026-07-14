// filepath: src/PoMiniGames/PoMiniGames/Features/Diagnostics/MockablesEndpoints.cs
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using PoShared.Interfaces;

namespace PoMiniGames.Features.Diagnostics;

/// <summary>
/// Diagnostic endpoint that enumerates every <see cref="IMockable"/> currently
/// registered in the DI container. Surfaces a uniform answer to "which services
/// in this process are mocks?" without requiring consumers to know the per-service
/// boolean field name (e.g. <c>IFaceAnalysisService.IsMock</c>).
/// </summary>
/// <remarks>
/// <para><b>§5 Mockable Enumeration.</b> Pre-marker, every game had its own
/// ad-hoc "is this a mock?" probe (PoCoupleQuiz exposed <c>isMockData</c>,
/// etc.). Lifting the contract to
/// <see cref="IMockable"/> lets this endpoint project a stable JSON shape and
/// lets the test suite assert the mock count is exactly the expected number
/// (e.g. zero in Production, one per overridden game in Dev/Test).</para>
/// <para><b>Production hardening:</b> in Production environments the endpoint
/// returns 404 so the inventory of internal mocks never leaks outside Dev/Test.
/// The Production mock-budget guard fires through the existing
/// <c>StartupSecretValidator</c> path; this endpoint is purely diagnostic.</para>
/// </remarks>
public static class MockablesEndpoints
{
    public sealed record MockableInfo(string MockId);

    public static IEndpointRouteBuilder MapMockablesEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: dev-tooling endpoint under /api/mockables.
        var mockables = app.MapGroup("/api/mockables").WithTags("Diagnostics");

        mockables.MapGet("", (IServiceProvider sp, IHostEnvironment env) =>
        {
            // Production hardening: never expose the mock surface to a deployed host.
            // Production should never resolve an IMockable — if any does, the suite's
            // structural guard (MockableServiceCount_IsZero_InProduction) will catch it.
            if (env.IsProduction())
            {
                return Results.NotFound();
            }

            // GetServices<IMockable>() enumerates every registered IMockable
            // implementation. The same MockId may appear more than once if multiple
            // service registrations use the same mock; we de-duplicate so the response
            // is a stable, greppable projection.
            var mockIds = sp.GetServices<IMockable>()
                .Select(m => m.MockId)
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(id => id, StringComparer.Ordinal)
                .Select(id => new MockableInfo(id))
                .ToArray();

            return Results.Ok(mockIds);
        })
        .WithName("GetMockables")
        .WithSummary("Enumerates IMockable registrations. Hidden in Production.");

        return app;
    }
}