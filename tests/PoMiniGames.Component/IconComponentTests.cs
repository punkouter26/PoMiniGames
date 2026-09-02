using Bunit;
using PoMiniGamesClient.Components;

namespace PoMiniGames.Component;

/// <summary>
/// Smoke test for the Component tier: renders the shared <see cref="Icon"/> and asserts
/// its accessibility contract (aria-hidden without a title, role="img" + &lt;title&gt; with one).
/// One method, two rows — the tier counts methods, not cases.
/// </summary>
public sealed class IconComponentTests : BunitContext
{
    [Theory]
    [InlineData(null, "true", "presentation")]
    [InlineData("Settings", "false", "img")]
    public void Icon_HonoursAccessibilityContract(string? title, string expectedAriaHidden, string expectedRole)
    {
        var cut = Render<Icon>(p => p
            .Add(x => x.Name, "gear")
            .Add(x => x.Title, title));

        var svg = cut.Find("svg");
        svg.GetAttribute("aria-hidden").Should().Be(expectedAriaHidden);
        svg.GetAttribute("role").Should().Be(expectedRole);
        (cut.FindAll("title").Count > 0).Should().Be(title is not null);
    }
}
