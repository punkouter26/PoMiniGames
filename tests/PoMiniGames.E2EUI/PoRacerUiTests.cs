using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

[Collection(KestrelServerCollection.Name)]
public sealed class PoRacerUiTests(KestrelServerFixture fixture)
{
    [Fact]
    public async Task Multiplayer_BindsBothPlayersAfterLeavingTheLobby()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        await using var first = await browser.NewContextAsync();
        await using var second = await browser.NewContextAsync();
        var host = await first.NewPageAsync();
        var guest = await second.NewPageAsync();
        var url = $"{fixture.ServerAddress.TrimEnd('/')}/poracer/multi?autoGuest=1";
        await host.GotoAsync(url);
        await host.GetByRole(AriaRole.Button, new() { Name = "Start Race", Exact = true }).WaitForAsync(new() { Timeout = 60000 });
        await guest.GotoAsync(url);
        await guest.GetByRole(AriaRole.Button, new() { Name = "Ready!", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await host.GetByRole(AriaRole.Button, new() { Name = "Start Race", Exact = true }).ClickAsync();
        foreach (var page in new[] { host, guest })
        {
            await page.Locator(".race-metrics").WaitForAsync(new() { Timeout = 30000 });
            await page.Locator("#racerCanvas").ClickAsync();
            await page.Keyboard.DownAsync("ArrowUp");
            await page.WaitForFunctionAsync("() => [...document.querySelectorAll('.race-metrics span')].some(e => e.textContent.includes('km/h') && parseInt(e.textContent) > 0)", null, new() { Timeout = 10000 });
            await page.Keyboard.UpAsync("ArrowUp");
            (await page.Locator(".race-standings .local-driver").CountAsync()).Should().Be(1);
        }
        var hostDriver = await host.Locator(".race-standings .local-driver").InnerTextAsync();
        var guestDriver = await guest.Locator(".race-standings .local-driver").InnerTextAsync();
        hostDriver.Should().NotBe(guestDriver);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Race_StartsWithOneClick_InputMovesCar_AndNavigationReleasesTheRenderer(bool touch)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        await using var context = await browser.NewContextAsync(new()
        {
            ViewportSize = touch ? new() { Width = 390, Height = 844 } : new() { Width = 1280, Height = 900 },
            HasTouch = touch,
            ExtraHTTPHeaders = new Dictionary<string, string> { ["X-Fake-User"] = "racer-user", ["X-Fake-Roles"] = "Player" }
        });
        var page = await context.NewPageAsync();
        var errors = new List<string>();
        page.PageError += (_, error) => errors.Add(error);
        await page.GotoAsync($"{fixture.ServerAddress.TrimEnd('/')}/poracer?autoGuest=1");
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await page.Locator(".race-metrics").WaitForAsync(new() { Timeout = 30000 });
        if (touch)
        {
            var gas = page.Locator("[data-po-input=up]");
            await gas.DispatchEventAsync("pointerdown", new { pointerId = 1, pointerType = "touch", bubbles = true });
        }
        else
        {
            await page.Locator("#racerCanvas").ClickAsync();
            await page.Keyboard.DownAsync("ArrowUp");
        }
        await page.WaitForFunctionAsync("() => [...document.querySelectorAll('.race-metrics span')].some(e => e.textContent.includes('km/h') && parseInt(e.textContent) > 0)", null, new() { Timeout = 10000 });
        if (touch) await page.Locator("[data-po-input=up]").DispatchEventAsync("pointerup", new { pointerId = 1, bubbles = true });
        else await page.Keyboard.UpAsync("ArrowUp");
        await page.ScreenshotAsync(new() { Path = $"artifacts/poracer-{(touch ? "mobile" : "desktop")}.png" });
        await page.GetByRole(AriaRole.Button, new() { Name = "Back to start", Exact = true }).ClickAsync();
        (await page.Locator(".racer-gl").CountAsync()).Should().Be(0);
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).ClickAsync();
        await page.Locator(".race-metrics").WaitForAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Back to start", Exact = true }).ClickAsync();
        errors.Should().BeEmpty();
        (await page.EvaluateAsync<bool>("() => document.documentElement.scrollWidth <= innerWidth")).Should().BeTrue();
    }
}
