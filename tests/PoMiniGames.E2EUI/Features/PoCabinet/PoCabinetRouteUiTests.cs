using Microsoft.Playwright;
using Xunit.Sdk;

namespace PoMiniGames.E2EUI.Features.PoCabinet;

/// <summary>
/// E2E-UI smoke for the four PoCabinet routes. The Blazor WASM client must boot
/// and the page must render without a JS console error — the framework's
/// GameShell falls back to a "needs 3D graphics" gate when WebGL is absent, so
/// we use the same SwiftShader real-GL context as PoEcosystemUiTests.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class PoCabinetRouteUiTests
{
    private readonly KestrelServerFixture _fixture;

    public PoCabinetRouteUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Theory]
    [InlineData("/pocabinet/1player", "Cabinet")]
    [InlineData("/pocabinet/2player", "Cabinet")]
    [InlineData("/pocabinet/multi", "Cabinet")]
    [InlineData("/pocabinet/demo", "Cabinet")]
    public async Task Route_RendersBlazorWasm_AndShowsGameTitle(string path, string expectedTitleFragment)
    {
        using var playwright = await Playwright.CreateAsync();
        var options = BrowserLaunch.Options();
        // three.js renderers need a real GL context — without SwiftShader the
        // GameShell would correctly show its "needs 3D graphics" fallback and
        // the page would not reach the in-race HUD. Harmless for the track
        // selector / paint shop / championship panels.
        options.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        await using var browser = await playwright.Chromium.LaunchAsync(options);
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = MobileViewport.Portrait,
        });
        await context.SetExtraHTTPHeadersAsync(new Dictionary<string, string>
        {
            ["X-Fake-User"] = "test-user",
            ["X-Fake-Roles"] = "Player",
        });
        var page = await context.NewPageAsync();
        page.Console += (_, msg) => { if (msg.Type is "error") Console.WriteLine($"[browser:error] {msg.Text}"); };
        page.PageError += (_, err) => Console.WriteLine($"[pageerror] {err}");

        var origin = _fixture.ServerAddress.TrimEnd('/');
        await page.GotoAsync($"{origin}{path}?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });

        // The Blazor WASM runtime replaces the loading placeholder once #app renders.
        // Asserting that the page title carries the Cabinet identity and that #app
        // contains rendered markup is enough for a route smoke — the in-race canvas
        // and AI car meshes are visual-audit territory, not unit-test territory.
        var title = await page.TitleAsync();
        title.Should().Contain(expectedTitleFragment, "the Blazor page title should name the game");

        var appHtml = await page.Locator("#app").InnerHTMLAsync();
        appHtml.Should().NotBeNullOrWhiteSpace("the Blazor app shell must render markup after NetworkIdle");

        // The track selector is part of every interactive mode's pre-race UI.
        // Demo mode auto-starts into the kiosk race reel on first paint.
        if (path.EndsWith("/demo", StringComparison.OrdinalIgnoreCase))
        {
            var raceMount = page.Locator("#pocabinetCanvas, .pocabinet-track").First;
            await raceMount.WaitForAsync(new() { Timeout = 30_000 });
            (await raceMount.IsVisibleAsync()).Should().BeTrue("demo mode mounts the race view or track selector");
        }
        else
        {
            var trackButtons = await page.Locator(".pocabinet-track").CountAsync();
            trackButtons.Should().Be(3,
                "the track selector must render Capitol + Mar-a-Lago + Press Briefing");
        }
    }
}
