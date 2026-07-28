using FluentAssertions;
using PoMiniGames.Features.PoJoker;
using PoShared.Games.PoJoker;

namespace PoMiniGames.Integration;

/// <summary>
/// The Jester runs with JokeAPI safe-mode off, and harsh jokes are rewritten rather
/// than skipped. These pin the rewrite rules: what triggers one, that only whole
/// words are swapped, that capitalisation survives, and that a joke is never dropped.
/// </summary>
/// <remarks>
/// Hermetic string logic that would naturally sit in the Unit tier, but that tier is
/// at its 100-method ceiling, so it lives here per the 100/50/25/25 rule. Kept to a
/// small number of theory-driven methods for the same reason — this tier's own cap is
/// 50, and a theory counts as one method however many cases it carries.
/// </remarks>
public class JokeSanitizerTests
{
    private static JokeDto Joke(string setup, string punchline, JokeFlags? flags = null) => new()
    {
        Id = 1,
        Type = "twopart",
        Setup = setup,
        Punchline = punchline,
        Flags = flags ?? new JokeFlags(),
    };

    [Theory]
    // Vocabulary flags trigger a rewrite...
    [InlineData(true, false, false, false, false, false, true)]
    [InlineData(false, true, false, false, false, false, true)]
    [InlineData(false, false, true, false, false, false, true)]
    [InlineData(false, false, false, true, false, false, true)]
    // ...but religious and political flag a joke's opinions, not its words. Swapping
    // vocabulary would not make those less pointed, so they play as written.
    [InlineData(false, false, false, false, true, false, false)]
    [InlineData(false, false, false, false, false, true, false)]
    // An unflagged joke plays untouched.
    [InlineData(false, false, false, false, false, false, false)]
    public void NeedsSanitizing_TriggersOnVocabularyFlagsOnly(
        bool racist, bool sexist, bool nsfw, bool isExplicit,
        bool religious, bool political, bool expected)
    {
        var flags = new JokeFlags
        {
            Racist = racist,
            Sexist = sexist,
            Nsfw = nsfw,
            Explicit = isExplicit,
            Religious = religious,
            Political = political,
        };

        JokeSanitizer.NeedsSanitizing(flags).Should().Be(expected);
    }

    [Theory]
    // Mapped terms are swapped.
    [InlineData("what the hell", "what the heck")]
    // Whole words only: "hell" inside "hello"/"shell" must survive, or the rewrite
    // mangles ordinary words and the joke stops parsing as English.
    [InlineData("hello, she sells a shell", "hello, she sells a shell")]
    // Longest-first alternation: a compound term must not first match its substring
    // and leave a mangled stem behind.
    [InlineData("motherfucker", "marshmallow")]
    // Capitalisation carries over, so a shouted line stays shouted.
    [InlineData("damn", "bless")]
    [InlineData("Damn", "Bless")]
    [InlineData("DAMN", "BLESS")]
    // Empty input passes straight through.
    [InlineData("", "")]
    [InlineData(null, null)]
    public void Clean_SwapsWholeWordsAndKeepsCapitalisation(string? input, string? expected)
    {
        JokeSanitizer.Clean(input).Should().Be(expected);
    }

    [Fact]
    public void SanitizeIfNeeded_RewritesFlaggedJoke_MarksIt_AndKeepsItPlayable()
    {
        var joke = Joke("What the hell happened?", "It was a damn mess.",
            new JokeFlags { Explicit = true });

        var result = JokeSanitizer.SanitizeIfNeeded(joke);

        result.Setup.Should().Be("What the heck happened?");
        result.Punchline.Should().Be("It was a bless mess.");
        result.Sanitized.Should().BeTrue();
        // The whole point of rewriting instead of blacklisting: the show always has
        // something left to perform.
        result.Setup.Should().NotBeNullOrWhiteSpace();
        result.Punchline.Should().NotBeNullOrWhiteSpace();
    }

    [Theory]
    // Unflagged, but contains a mapped word: still played verbatim. The rewrite is
    // reserved for jokes that would otherwise be skipped.
    [InlineData(false, "What the hell happened?")]
    // Flagged for its premise rather than its vocabulary, so nothing matches. The
    // Sanitized bit must stay false — a cleaned-looking joke is never to be mistaken
    // for one that was actually altered.
    [InlineData(true, "Two people walk into a bar.")]
    public void SanitizeIfNeeded_LeavesTextAloneAndReportsNoRewrite(bool racist, string setup)
    {
        var joke = Joke(setup, "Nothing was changed.", new JokeFlags { Racist = racist });

        var result = JokeSanitizer.SanitizeIfNeeded(joke);

        result.Setup.Should().Be(setup);
        result.Punchline.Should().Be("Nothing was changed.");
        result.Sanitized.Should().BeFalse();
    }
}
