using FluentAssertions;
using Microsoft.JSInterop;
using PoMiniGamesClient.Models.SubSurface;
using PoMiniGamesClient.Services;
using Xunit;

namespace PoMiniGames.Unit.SubSurface;

public class SubSurfaceComponentTests
{
    private sealed class MockJsRuntime : IJSRuntime
    {
        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args) => default;
        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, CancellationToken cancellationToken, object?[]? args) => default;
    }

    [Fact]
    public async Task InteropService_DispatchesMetrics_AndManagesLifecycle()
    {
        var jsRuntime = new MockJsRuntime();
        var service = new SubSurfaceInteropService(jsRuntime);

        SubSurfaceDiagnostics? received = null;
        service.OnMetricsReceived += diag => received = diag;

        var expectedDiag = new SubSurfaceDiagnostics(
            Fps: 60.0,
            SubSteps: 2,
            ActiveProjectiles: 3,
            SubmergedTNTCount: 1,
            ActiveFluidCells: 1200,
            ActiveSandCells: 45000);

        service.OnEngineMetricsUpdate(expectedDiag);

        received.Should().NotBeNull();
        received!.Fps.Should().Be(60.0);
        received.ActiveProjectiles.Should().Be(3);
        received.SubmergedTNTCount.Should().Be(1);

        // Tool config default state
        var defaultConfig = SubSurfaceToolConfig.Default;
        defaultConfig.Tool.Should().Be(SubSurfaceTool.DigVacuum);
        defaultConfig.BrushRadius.Should().Be(8);
        defaultConfig.IsPaused.Should().BeFalse();

        await service.DisposeAsync();
    }
}
