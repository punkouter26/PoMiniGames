using FluentAssertions;
using PoMiniGames.Shared.Games.PoJevArena;
using Xunit;

namespace PoMiniGames.Unit.Features.PoJevArena;

/// <summary>
/// The creature rules are the one gate between a player's form and the public library (and,
/// through it, every word Jev is shown), so every bound, catalog and budget edge is a row here.
/// The last two rows guard the registry and the presets themselves: a new ability must bring a
/// unique Jev option, and a retuned cost must not push a shipped preset over budget.
/// </summary>
public sealed class CreatureRulesTests
{
    private static ArenaCreatureDraft Valid => new(
        Name: "Moss Biter",
        MaxHp: 200,
        MoveSpeed: 5.0,
        Mass: 2.5,
        Abilities: ["spit_glob", "dodge_dash"],
        Temperament: "skirmisher",
        TargetBias: "hunt_weakest",
        PanicThreshold: "panics_under_25_hp");

    [Theory]
    [InlineData("valid", null)]
    [InlineData("no-abilities", null)]
    [InlineData("hp-low", "hp")]
    [InlineData("hp-high", "hp")]
    [InlineData("speed-low", "speed")]
    [InlineData("speed-high", "speed")]
    [InlineData("speed-off-step", "speed")]
    [InlineData("mass-low", "mass")]
    [InlineData("mass-high", "mass")]
    [InlineData("mass-nan", "mass")]
    [InlineData("unknown-ability", "ability")]
    [InlineData("two-offense", "ability-slot")]
    [InlineData("duplicate-ability", "ability-slot")]
    [InlineData("too-many-abilities", "ability-slot")]
    [InlineData("unknown-temperament", "temperament")]
    [InlineData("unknown-bias", "target-bias")]
    [InlineData("unknown-panic", "panic")]
    [InlineData("over-budget", "budget")]
    [InlineData("empty-name", "name")]
    [InlineData("registry-integrity", null)]
    [InlineData("presets-within-budget", null)]
    public void CreatureValidation_RejectsOutOfBoundsAndOffCatalog(string scenario, string? expectedError)
    {
        switch (scenario)
        {
            case "registry-integrity":
                AssertRegistryIntegrity();
                return;
            case "presets-within-budget":
                AssertPresetsValid();
                return;
        }

        var draft = scenario switch
        {
            "valid" => Valid,
            "no-abilities" => Valid with { Abilities = [] },
            "hp-low" => Valid with { MaxHp = 49 },
            "hp-high" => Valid with { MaxHp = 501 },
            "speed-low" => Valid with { MoveSpeed = 1.5 },
            "speed-high" => Valid with { MoveSpeed = 9.5 },
            "speed-off-step" => Valid with { MoveSpeed = 3.25 },
            "mass-low" => Valid with { Mass = 0.5 },
            "mass-high" => Valid with { Mass = 5.5 },
            "mass-nan" => Valid with { Mass = double.NaN },
            "unknown-ability" => Valid with { Abilities = ["laser_eyes"] },
            "two-offense" => Valid with { Abilities = ["spit_glob", "hurl_boulder"] },
            "duplicate-ability" => Valid with { Abilities = ["dodge_dash", "dodge_dash"] },
            "too-many-abilities" => Valid with { Abilities = ["spit_glob", "dodge_dash", "hard_shell"] },
            "unknown-temperament" => Valid with { Temperament = "chaotic_neutral" },
            "unknown-bias" => Valid with { TargetBias = "whoever" },
            "unknown-panic" => Valid with { PanicThreshold = "never" },
            // 500 HP / 9 m/s / 5.0 mass is 90 points before any ability; the budget is 80.
            "over-budget" => Valid with { MaxHp = 500, MoveSpeed = 9.0, Mass = 5.0, Abilities = [] },
            "empty-name" => Valid with { Name = "  " },
            _ => throw new ArgumentOutOfRangeException(nameof(scenario), scenario, null),
        };

        var result = PoJevArenaRules.Validate(draft);

        if (expectedError is null)
        {
            result.IsValid.Should().BeTrue($"{scenario} should pass, but failed with {result.Error}");
            result.Creature!.Name.Should().Be(draft.Name.Trim());
            result.Creature.BuildCost.Should().BeLessThanOrEqualTo(PoJevArenaRules.BuildBudget);
        }
        else
        {
            result.IsValid.Should().BeFalse($"{scenario} must be rejected");
            result.Error.Should().Be(expectedError);
            result.Creature.Should().BeNull();
        }
    }

    private static void AssertRegistryIntegrity()
    {
        var abilities = PoJevArenaCatalog.Abilities;
        abilities.Should().NotBeEmpty();
        abilities.Select(a => a.Id).Should().OnlyHaveUniqueItems("ability ids key the JS handlers and visuals");

        // Every option Jev can be offered (base + one per ability) must be unique, or two
        // behaviours would collapse into one answer.
        var options = PoJevArenaCatalog.BaseActions.Select(b => b.Option)
            .Concat(abilities.Select(a => a.JevOption))
            .ToList();
        options.Should().OnlyHaveUniqueItems();

        foreach (var ability in abilities)
        {
            ability.JevCriterion.Should().NotBeNullOrWhiteSpace($"{ability.Id} needs criterion text for Jev");
            ability.Cost.Should().BePositive($"{ability.Id} must cost build points");
            ability.CooldownSeconds.Should().BePositive($"{ability.Id} needs a cooldown");
        }

        Enum.GetValues<ArenaAbilitySlot>()
            .Should().OnlyContain(slot => abilities.Any(a => a.Slot == slot), "every slot offers at least one ability");
    }

    private static void AssertPresetsValid()
    {
        PoJevArenaCatalog.Presets.Should().HaveCount(5);
        foreach (var preset in PoJevArenaCatalog.Presets)
        {
            preset.Id.Should().StartWith(PoJevArenaCatalog.PresetPrefix);
            var result = PoJevArenaRules.Validate(preset.ToDraft());
            result.IsValid.Should().BeTrue($"preset {preset.Name} must satisfy its own rules ({result.Error})");
        }

        PoJevArenaCatalog.Presets.SelectMany(p => p.Abilities).Distinct()
            .Should().BeEquivalentTo(PoJevArenaCatalog.Abilities.Select(a => a.Id),
                "the presets together should show off every shipped ability");
    }
}
