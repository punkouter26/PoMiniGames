// filepath: tests/E2EUI/BrowserLaunch.cs
using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// Shared Chromium launch options for the E2E-UI tier. Headless by default (CI);
/// set the environment variable <c>HEADED=1</c> to watch the browser live, which
/// also adds a small SlowMo so individual actions are visible to a human.
/// </summary>
public static class BrowserLaunch
{
    public static BrowserTypeLaunchOptions Options()
    {
        var headed = Environment.GetEnvironmentVariable("HEADED") == "1";
        return new BrowserTypeLaunchOptions
        {
            Headless = !headed,
            SlowMo = headed ? 300 : 0,
        };
    }
}
