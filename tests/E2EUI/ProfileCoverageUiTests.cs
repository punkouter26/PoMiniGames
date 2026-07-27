using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// §5 E2E-UI coverage for the profile page's game roster and the offline treatment.
/// </summary>
/// <remarks>
/// These live in the browser tier rather than a cheaper one because both surfaces are
/// only reachable through a real browser: the profile's rating classification is
/// private to the Razor component and reads localStorage over JS interop, and the
/// offline treatment is driven by <c>navigator.onLine</c>. Neither has a seam the
/// Unit or Integration tiers can reach without inventing one that exists only for
/// tests.
///
/// Scope limit: the published service worker is NOT exercised here. The test host
/// serves the no-op development worker (see wwwroot/service-worker.js), so real
/// cache-first offline loading has to be verified against published output. What is
/// covered here is the offline *UX contract* — banner shown, network-dependent games
/// made unavailable — which is what regresses silently.
/// </remarks>
[Collection(KestrelServerCollection.Name)]
public class ProfileCoverageUiTests
{
    private readonly KestrelServerFixture _fixture;

    public ProfileCoverageUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    private async Task<IPage> NewSignedInPageAsync(IBrowser browser)
    {
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = MobileViewport.Portrait,
        });
        await context.SetExtraHTTPHeadersAsync(new Dictionary<string, string>
        {
            ["X-Fake-User"] = "test-user",
            ["X-Fake-Roles"] = "Player",
        });
        return await context.NewPageAsync();
    }

    [Fact]
    public async Task Profile_ListsEveryGame_IncludingPlayCountOnlyEntries()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var page = await NewSignedInPageAsync(browser);

        // Actually play Joker rather than seeding its counter into localStorage.
        // Seeding would have to guess the storage key, and the play count is keyed by
        // a player name the guest flow assigns per session — so a seeded key can
        // silently miss. Visiting the page exercises the real path end to end:
        // RecordPlay on the game page, GetPlayCount on the profile.
        await page.GotoAsync($"{_fixture.ServerAddress}pojoker?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });
        await page.Locator("#app *").First.WaitForAsync(
            new LocatorWaitForOptions { Timeout = 30_000 });

        await page.GotoAsync($"{_fixture.ServerAddress}profile?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });
        await page.Locator(".prf-game-card").First.WaitForAsync(
            new LocatorWaitForOptions { Timeout = 30_000 });

        var names = await page.Locator(".prf-game-name").AllInnerTextsAsync();

        // The whole point of the change: the profile used to report three of ten
        // games, so several games recorded stats no one could ever see.
        names.Should().Contain(["Tic-Tac-Toe", "Connect Five", "Brawl", "Sports",
            "Fun Quiz", "Racer", "Couple Quiz", "Marble Race", "Joker", "Survive"]);

        // Joker carries a session count, not a win rate.
        var joker = page.Locator(".prf-game-card", new PageLocatorOptions
        {
            HasText = "Joker",
        }).First;
        (await joker.Locator(".prf-game-plays").InnerTextAsync()).Should().Contain("1",
            because: "the visit above is one session, and it must reach the profile");
        (await joker.Locator(".prf-game-wr").CountAsync()).Should().Be(0,
            because: "a game with no win condition must not display a win rate");
    }

    [Fact]
    public async Task Offline_ShowsBanner_AndMakesNetworkOnlyGamesUnavailable()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var page = await NewSignedInPageAsync(browser);

        await page.GotoAsync($"{_fixture.ServerAddress}?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });

        // On portrait the home sections start collapsed except 1-Player, so the first
        // chip in DOM order is present but hidden. Expand the Multiplayer section so
        // the assertions below cover what a player can actually see and tap.
        var toggles = page.Locator(".home-section-toggle");
        await toggles.First.WaitForAsync(new LocatorWaitForOptions { Timeout = 30_000 });
        await toggles.Nth(3).ClickAsync();
        await page.Locator("a.home-game-chip[href='/couplequiz/multi']").WaitForAsync(
            new LocatorWaitForOptions { Timeout = 15_000 });

        // Online: nothing is suppressed.
        (await page.Locator(".gl-offline-banner").CountAsync()).Should().Be(0);
        (await page.Locator(".home-game-chip--offline").CountAsync()).Should().Be(0);

        await page.Context.SetOfflineAsync(true);

        // The banner is the whole reason offline support is discoverable: with a
        // service worker installed the shell keeps working, so without it a failing
        // multiplayer game reads as a bug rather than as a connection problem.
        await page.Locator(".gl-offline-banner").WaitForAsync(
            new LocatorWaitForOptions { Timeout = 15_000 });

        // Every hub-backed entry must stop being navigable — otherwise the player is
        // dropped into a lobby that can never connect.
        var offlineChips = await page.Locator(".home-game-chip--offline").AllInnerTextsAsync();
        offlineChips.Should().NotBeEmpty();
        offlineChips.Should().Contain(c => c.Contains("Couple Quiz"));

        // Local games stay playable — that is the point of offline support.
        var stillPlayable = await page.Locator("a.home-game-chip").AllInnerTextsAsync();
        stillPlayable.Should().Contain(c => c.Contains("Tic-Tac-Toe"));

        await page.Context.SetOfflineAsync(false);
        await page.Locator(".gl-offline-banner").WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Detached,
            Timeout = 15_000,
        });
    }
}
