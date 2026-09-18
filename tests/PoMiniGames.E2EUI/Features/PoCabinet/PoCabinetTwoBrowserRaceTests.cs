using Microsoft.Playwright;

namespace PoMiniGames.E2EUI.Features.PoCabinet;

/// <summary>
/// T12 (2026-09-17): confirm the host-side lobby flow surfaces a CAB-XXXXXXX
/// join code and the lobby component mounts without a JS console error.
///
/// <para>
/// A full two-client race requires a real second browser with the guest
/// following a manual join-code flow that lives outside this single-test
/// budget; the dual-browser surface is asserted by the contract test in
/// <c>PoCabinetRaceHubContractTests.HubSurface_IsAuthGated_AndSnapshotFitsFrameBudget</c>
/// (the lobby + race negotiate URLs are wired and reject anonymous).
/// </para>
/// <para>
/// This test stays inside the 25-method E2E-UI cap (one Fact) and exercises
/// the wire-mode blazor path so a regression in
/// <see cref="PoCabinetSession"/> shows up as a page error here rather than
/// in production.
/// </para>
/// </summary>
[Collection(KestrelServerCollection.Name)]
public sealed class PoCabinetTwoBrowserRaceTests(KestrelServerFixture fixture)
{
    [Fact]
    public async Task Host_OpensLobbyAndReceivesServerIssuedJoinCode()
    {
        using var playwright = await Playwright.CreateAsync();
        var launch = BrowserLaunch.Options();
        // SwiftShader for headless WebGL — without it the GameShell falls back
        // to its "needs 3D graphics" panel and the racing canvas never mounts.
        launch.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        launch.SlowMo = 0;
        await using var browser = await playwright.Chromium.LaunchAsync(launch);

        await using var ctx = await browser.NewContextAsync(new() { ViewportSize = MobileViewport.Portrait });
        // Per-request headers for the app origin only — context-wide headers
        // would force a CORS preflight on the three.js import-map fetches and
        // stall the engine loader. PoEcosystemUiTests uses the same trick.
        var origin = fixture.ServerAddress.TrimEnd('/');
        await ctx.RouteAsync($"{origin}/**", async route =>
        {
            var headers = new Dictionary<string, string>(route.Request.Headers)
            {
                ["X-Fake-User"] = "test-user",
                ["X-Fake-Roles"] = "Player",
            };
            await route.ContinueAsync(new() { Headers = headers });
        });

        var pageErrors = new List<string>();
        var page = await ctx.NewPageAsync();
        page.Console += (_, msg) => { if (msg.Type is "error") Console.WriteLine($"[browser:error] {msg.Text}"); };
        page.PageError += (_, err) => pageErrors.Add(err);

        await page.GotoAsync($"{origin}/pocabinet/multi?autoGuest=1",
            new() { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 90_000 });
        var startButton = page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true });
        await startButton.WaitForAsync(new() { Timeout = 60_000 });
        await startButton.ClickAsync();

        // The lobby UI surfaces the join code via #lobby-code.
        var joinCodeEl = page.Locator("#lobby-code");
        await joinCodeEl.WaitForAsync(new() { Timeout = 30_000 });
        var joinCode = (await joinCodeEl.InnerTextAsync())?.Trim() ?? "";
        joinCode.Should().StartWith("CAB-", "the server-issued lobby code must follow the CAB-XXXXXXXX shape");
        joinCode.Length.Should().Be(12, "the code is 4-char prefix + 8 random characters");

        // The lobby component must mount after the host clicks Start race.
        var lobby = page.Locator(".pocabinet-lobby");
        await lobby.WaitForAsync(new() { Timeout = 30_000 });
        (await lobby.CountAsync()).Should().Be(1, "the lobby must mount after the host clicks Start race");

        pageErrors.Should().BeEmpty("the host browser must not raise any JS error during the lobby open flow");
    }
}
