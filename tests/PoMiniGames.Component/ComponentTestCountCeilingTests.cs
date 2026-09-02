using System.Reflection;

namespace PoMiniGames.Component;

/// <summary>
/// Structural guardrail extending the "100/50/25/25 Rule" to the Component tier:
/// bUnit tests are capped at 25 methods. The tier is cheap, but it is still a
/// maintenance surface per component — consolidate assertions into one render per
/// component rather than raising the cap.
/// </summary>
public sealed class ComponentTestCountCeilingTests
{
    private const int ComponentTierCeiling = 25;

    [Fact]
    public void ComponentTier_StaysWithinCeiling()
    {
        var testMethodCount = Assembly.GetExecutingAssembly()
            .GetTypes()
            .Where(t => t != typeof(ComponentTestCountCeilingTests))
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Count(m => m.GetCustomAttributes<FactAttribute>(inherit: true).Any()
                     || m.GetCustomAttributes<Xunit.TheoryAttribute>(inherit: true).Any());

        testMethodCount.Should().BeLessThanOrEqualTo(
            ComponentTierCeiling,
            because: $"the Component tier is capped at {ComponentTierCeiling} test methods; " +
                     "consolidate renders rather than raising the cap");
    }
}
