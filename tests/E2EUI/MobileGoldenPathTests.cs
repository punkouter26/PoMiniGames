using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// §5 E2E-UI "Golden Path" smoke tests under a strict mobile-portrait viewport
/// (390×844 — the platform is mobile-first). These drive a real Chromium browser
/// through the player's first interactions: land on home, see the game catalog,
/// open a single-player game. The default (non-mock) fixture is used, so these
/// also assert the mock banner is ABSENT in a normal environment.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class MobileGoldenPathTests
{
    private static readonly ViewportSize Portrait = new() { Width = 390, Height = 844 };

    private readonly KestrelServerFixture _fixture;

    public MobileGoldenPathTests(KestrelServerFixture fixture) => _fixture = fixture;

    private async Task<IPage> OpenHomeAsync(IBrowser browser)
    {
        // §3 BFF Header Overrides: every browser context attaches the FakeAuth headers
        // so the FakeAuth scheme authenticates each request without depending on the
        // cookie flow (which is brittle across dynamic-port Kestrel hosts).
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = Portrait,
            ExtraHTTPHeaders = new Dictionary<string, string>
            {
                ["X-Fake-User"] = "test-user",
                ["X-Fake-Roles"] = "Player",
            },
        });
        var page = await context.NewPageAsync();
        // WASM cold-boot (download + start) can take a while under the load of the parallel
        // Testcontainers fixtures, so allow a generous navigation budget.
        await page.GotoAsync($"{_fixture.ServerAddress}?autoGuest=1", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });
        return page;
    }

    [Fact]
    public async Task Home_OnMobilePortrait_ShowsCatalog_AndNoMockBanner()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(
            new BrowserTypeLaunchOptions { Headless = true });
        var page = await OpenHomeAsync(browser);

        // The home hero renders the platform identity…
        await page.Locator(".home-title").WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Visible,
            Timeout = 60_000,
        });
        (await page.Locator(".home-title").InnerTextAsync()).Should().Contain("PoMiniGames");

        // …and the single-player catalog renders at least one playable game chip.
        var chips = page.Locator(".home-game-chip");
        (await chips.CountAsync()).Should().BeGreaterThan(0,
            because: "the home page must surface playable games on a phone");

        // In a normal (non-mock) environment the mock banner must NOT be present.
        (await page.Locator(".gl-mock-banner").CountAsync()).Should().Be(0,
            because: "UseMockData is false in this fixture");
    }

    [Fact]
    public async Task GoldenPath_OpenFirstSinglePlayerGame_Navigates_AndRenders()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(
            new BrowserTypeLaunchOptions { Headless = true });
        var page = await OpenHomeAsync(browser);

        var firstChip = page.Locator(".home-game-chip").First;
        await firstChip.WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Visible,
            Timeout = 60_000,
        });

        var targetHref = await firstChip.GetAttributeAsync("href");
        targetHref.Should().NotBeNullOrWhiteSpace();

        // Navigate directly to the chip's href instead of clicking — Blazor WASM's
        // enhanced navigation can race the SPA boot. Direct navigation goes through
        // the SPA router deterministically (MapFallbackToFile serves index.html, the
        // router picks up the path) and confirms the route is reachable.
        var absoluteTarget = new Uri(new Uri(_fixture.ServerAddress), targetHref!.TrimStart('/')).ToString();
        await page.GotoAsync(absoluteTarget, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });

        page.Url.Should().Contain(targetHref!.TrimStart('/'),
            because: "navigating to a game route renders that game");

        // The router mounted a new page into #app; it must contain rendered markup.
        var appHtml = await page.Locator("#app").InnerHTMLAsync();
        appHtml.Should().NotBeNullOrWhiteSpace();
    }
}
