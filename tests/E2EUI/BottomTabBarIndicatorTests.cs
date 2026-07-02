using System.Globalization;
using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// §9 Bottom-tab-bar active-indicator regression capture (mobile portrait).
///
/// The active-tab accent underline is an absolutely-positioned <c>::before</c> on
/// <c>.btb-item--active</c> sized <c>left:25%; right:25%</c> — i.e. 50% of its
/// CONTAINING BLOCK. The fix adds <c>position: relative</c> to <c>.btb-item</c> so the
/// containing block is the individual cell (~78px) and the indicator lands centered
/// under the active tab. Without it, the nearest positioned ancestor is the fixed
/// <c>.btb</c> nav (390px), so the indicator becomes a single ~195px stripe pinned to
/// the bar's top-center regardless of which tab is active.
///
/// Decisive geometric assertion: indicator width must be LESS than the active cell's
/// width — true only when the indicator is anchored to the cell (post-fix), false when
/// anchored to the whole bar (pre-fix). Screenshots are written for visual review.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class BottomTabBarIndicatorTests
{
    private static readonly ViewportSize Portrait = MobileViewport.Portrait;

    private readonly KestrelServerFixture _fixture;

    public BottomTabBarIndicatorTests(KestrelServerFixture fixture) => _fixture = fixture;

    private static string ArtifactDir
    {
        get
        {
            var dir = Path.Combine(AppContext.BaseDirectory, "ui-artifacts");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    private async Task<IPage> OpenAsync(IBrowser browser, string relativeUrl)
    {
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = Portrait,
            DeviceScaleFactor = 2, // retina capture so the 2px accent line is legible
            ExtraHTTPHeaders = new Dictionary<string, string>
            {
                ["X-Fake-User"] = "test-user",
                ["X-Fake-Roles"] = "Player",
            },
        });
        var page = await context.NewPageAsync();
        var sep = relativeUrl.Contains('?') ? '&' : '?';
        await page.GotoAsync($"{_fixture.ServerAddress}{relativeUrl.TrimStart('/')}{sep}autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });
        return page;
    }

    /// <summary>Reads the active indicator's geometry vs. its owning cell and the whole bar.</summary>
    private static async Task<IndicatorGeometry> MeasureAsync(IPage page)
    {
        // Wait for the portrait bar to actually be laid out (display:grid at <=640px).
        await page.Locator(".btb").WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Visible,
            Timeout = 60_000,
        });

        var json = await page.EvaluateAsync<IndicatorGeometry>(@"() => {
            const bar = document.querySelector('.btb');
            const active = document.querySelector('.btb-item--active');
            if (!bar || !active) return { found: false, barWidth: 0, cellWidth: 0, indicatorWidth: 0, cellLabel: '' };
            const barRect = bar.getBoundingClientRect();
            const cellRect = active.getBoundingClientRect();
            const before = getComputedStyle(active, '::before');
            // Chromium resolves the percentage left/right into a used px width here.
            const indicatorWidth = parseFloat(before.width) || 0;
            const label = (active.querySelector('.btb-label')?.textContent || '').trim();
            return {
                found: true,
                barWidth: barRect.width,
                cellWidth: cellRect.width,
                indicatorWidth: indicatorWidth,
                cellLabel: label,
            };
        }");
        return json;
    }

    [Fact]
    public async Task ActiveIndicator_OnMobilePortrait_IsAnchoredToActiveCell_NotWholeBar()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(
            BrowserLaunch.Options());

        // ── Home: the "Home" tab is active ──────────────────────────────────────
        var home = await OpenAsync(browser, "/");
        var homeGeo = await MeasureAsync(home);

        await home.ScreenshotAsync(new PageScreenshotOptions
        {
            Path = Path.Combine(ArtifactDir, "btb-home-portrait-full.png"),
            FullPage = true,
        });
        await home.Locator(".btb").ScreenshotAsync(new LocatorScreenshotOptions
        {
            Path = Path.Combine(ArtifactDir, "btb-home-bar.png"),
        });

        homeGeo.Found.Should().BeTrue(because: ".btb and an active tab must render on a 390px portrait viewport");
        homeGeo.CellLabel.Should().Be("Home", because: "the home route activates the Home tab");
        homeGeo.BarWidth.Should().BeApproximately(Portrait.Width, 1.5, because: "the fixed bar spans the viewport width");

        // The regression guard: the 50%-of-containing-block indicator must be narrower
        // than the cell it lives in. Pre-fix it was 50% of the whole bar (~195px) — wider
        // than a single ~78px cell — and would FAIL this assertion.
        homeGeo.IndicatorWidth.Should().BeGreaterThan(0, because: "the active indicator pseudo-element renders");
        homeGeo.IndicatorWidth.Should().BeLessThan(homeGeo.CellWidth,
            because: $"the indicator ({homeGeo.IndicatorWidth:F1}px) must be anchored to its cell " +
                     $"({homeGeo.CellWidth:F1}px), not the whole {homeGeo.BarWidth:F1}px bar");

        // ── Leaderboards: the indicator must MOVE to the "Scores" tab ────────────
        var scores = await OpenAsync(browser, "/leaderboards");
        var scoresGeo = await MeasureAsync(scores);

        await scores.Locator(".btb").ScreenshotAsync(new LocatorScreenshotOptions
        {
            Path = Path.Combine(ArtifactDir, "btb-leaderboards-bar.png"),
        });

        scoresGeo.Found.Should().BeTrue();
        scoresGeo.CellLabel.Should().Be("Scores",
            because: "the /leaderboards route activates the Scores tab — proving the indicator tracks the active cell");
        scoresGeo.IndicatorWidth.Should().BeLessThan(scoresGeo.CellWidth,
            because: "the indicator stays anchored to its (now different) cell");

        // Surface the artifact location in test output for manual review.
        Console.WriteLine($"[btb-capture] artifacts written to: {ArtifactDir}");
        Console.WriteLine($"[btb-capture] home   : bar={homeGeo.BarWidth:F1}px cell={homeGeo.CellWidth:F1}px indicator={homeGeo.IndicatorWidth:F1}px ({homeGeo.CellLabel})");
        Console.WriteLine($"[btb-capture] scores : bar={scoresGeo.BarWidth:F1}px cell={scoresGeo.CellWidth:F1}px indicator={scoresGeo.IndicatorWidth:F1}px ({scoresGeo.CellLabel})");
    }

    private sealed class IndicatorGeometry
    {
        public bool Found { get; set; }
        public double BarWidth { get; set; }
        public double CellWidth { get; set; }
        public double IndicatorWidth { get; set; }
        public string CellLabel { get; set; } = string.Empty;
    }
}
