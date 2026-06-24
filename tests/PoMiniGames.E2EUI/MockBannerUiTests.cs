using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// §5 E2E-UI environment-state assertion: when mock dependencies are active
/// (<c>FeatureFlags:UseMockData=true</c>), the Blazor render tree must inject a
/// prominent, high-contrast "USING MOCK DATA" banner into the top navigation so a
/// human can never mistake a mock-backed environment for the real one.
/// </summary>
[Collection(MockDataKestrelServerCollection.Name)]
public class MockBannerUiTests
{
    private readonly MockDataKestrelServerFixture _fixture;

    public MockBannerUiTests(MockDataKestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Banner_IsInjected_WhenUseMockDataIsTrue()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(
            new BrowserTypeLaunchOptions { Headless = true });
        // Mobile portrait — the banner is part of the mobile-first nav shell.
        var page = await browser.NewPageAsync(new BrowserNewPageOptions
        {
            ViewportSize = new ViewportSize { Width = 390, Height = 844 },
        });

        await page.GotoAsync(_fixture.ServerAddress, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });

        var banner = page.Locator(".gl-mock-banner");
        await banner.WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Visible,
            Timeout = 60_000,
        });

        (await banner.InnerTextAsync()).Should().Contain("USING MOCK DATA");
        (await banner.IsVisibleAsync()).Should().BeTrue(
            because: "a mock-backed environment must be visually obvious");
    }
}
