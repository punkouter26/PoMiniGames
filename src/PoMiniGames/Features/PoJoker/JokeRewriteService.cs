using Microsoft.Extensions.Hosting;
using OpenAI.Chat;
using PoShared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// Rewrites a flagged joke into a clean one that keeps its comic shape, so the Jester
/// can perform it instead of skipping it.
/// </summary>
/// <remarks>
/// <para><b>Why this exists.</b> <see cref="JokeSanitizer"/> substitutes words, which
/// turned out to do nothing to the jokes that actually get flagged: JokeAPI's racist
/// and sexist flags mark jokes whose <i>premise</i> is the offensive part, not jokes
/// containing profanity. Measured against the live Dark feed, every flagged joke came
/// back with no substitutable word in it. Changing the premise needs a rewrite, not a
/// find-and-replace.</para>
///
/// <para><b>Fallback chain</b> (never blocks the show): AI rewrite → word
/// substitution → play as fetched. Each step is best-effort; a rewrite that fails for
/// any reason — model not configured, timeout, refusal, upstream content filter —
/// falls through to the next rather than stalling the performance.</para>
///
/// <para>A refusal is a legitimate outcome here, not an error: the model declining to
/// restate a joke is precisely the signal that it should not be restated. That case
/// is logged and handed to the caller as <c>null</c>.</para>
/// </remarks>
public sealed class JokeRewriteService : IJokeRewriteService
{
    private readonly ILogger<JokeRewriteService> _logger;
    private readonly IHostEnvironment _environment;
    private readonly AIFoundryChatClientCache _chatClientCache;
    private readonly int _timeoutSeconds;

    // Asks for a replacement joke rather than a cleaned copy of the original: the
    // point is to lose the premise, keeping only the comedic form.
    private const string SystemPrompt = """
        You rewrite jokes so they are inoffensive.

        You will be given a joke that has been flagged as offensive. Write a NEW
        two-part joke that keeps only the comedic STRUCTURE of the original - the
        style of wordplay, the rhythm, the kind of misdirection. Everything that made
        the original offensive must be gone: no slurs, no demeaning premise, no group
        as the butt of the joke.

        The result must be genuinely funny and stand on its own to someone who has
        never seen the original.

        Respond with EXACTLY two lines and nothing else:
        SETUP: <the setup>
        PUNCHLINE: <the punchline>

        If you cannot do this, respond with exactly: CANNOT
        """;

    public JokeRewriteService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<JokeRewriteService> logger,
        AIFoundryChatClientCache chatClientCache)
    {
        _logger = logger;
        _environment = environment;
        _chatClientCache = chatClientCache;
        // Deliberately NOT the shared PoJoker:AzureOpenAI:TimeoutSeconds (30s) that
        // analysis uses. Analysis runs while the joke is already on screen, so it can
        // afford to wait; this call blocks the fetch, so every second is dead air
        // before the joke appears. Measured against an unresponsive deployment, the
        // inherited 30s turned a ~150 ms fetch into a 25 s stall.
        //
        // A slow model must degrade to the fallback chain quickly rather than hold up
        // the show — losing the rewrite costs less than stalling the performance.
        _timeoutSeconds = configuration.GetValue("PoJoker:Rewrite:TimeoutSeconds", 8);
    }

    /// <inheritdoc />
    public async Task<JokeDto?> TryRewriteAsync(JokeDto joke, CancellationToken cancellationToken = default)
    {
        var chatClient = _chatClientCache.Resolve(AIFoundryOptions.Games.Joker);
        if (chatClient is null)
        {
            // Unlike AiJesterService there is no mock stand-in: a fabricated "rewrite"
            // would claim the joke was cleaned when it was not. Fall through instead.
            _logger.LogWarning(
                "PoJoker: AIFoundry not configured in {Environment}; flagged joke {JokeId} cannot be rewritten.",
                _environment.EnvironmentName, joke.Id);
            return null;
        }

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

            var messages = new ChatMessage[]
            {
                new SystemChatMessage(SystemPrompt),
                new UserChatMessage($"Setup: \"{joke.Setup}\"\nPunchline: \"{joke.Punchline}\""),
            };

            var response = await chatClient.CompleteChatAsync(messages, cancellationToken: cts.Token);

            if (response.Value.FinishReason == ChatFinishReason.ContentFilter)
            {
                _logger.LogInformation(
                    "PoJoker: rewrite of joke {JokeId} was content-filtered; falling back.", joke.Id);
                return null;
            }

            var text = response.Value.Content.Count > 0 ? response.Value.Content[0].Text : null;
            return Parse(text, joke);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("PoJoker: rewrite of joke {JokeId} timed out after {Timeout}s.",
                joke.Id, _timeoutSeconds);
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PoJoker: rewrite of joke {JokeId} failed.", joke.Id);
            return null;
        }
    }

    /// <summary>
    /// Pulls SETUP/PUNCHLINE out of the reply. Anything that does not parse into two
    /// non-empty halves is treated as a refusal — better to fall through than to
    /// perform a malformed joke.
    /// </summary>
    private JokeDto? Parse(string? text, JokeDto original)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var trimmed = text.Trim();
        if (trimmed.StartsWith("CANNOT", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation("PoJoker: model declined to rewrite joke {JokeId}.", original.Id);
            return null;
        }

        string? setup = null, punchline = null;
        foreach (var line in trimmed.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var l = line.Trim();
            if (l.StartsWith("SETUP:", StringComparison.OrdinalIgnoreCase))
            {
                setup = l["SETUP:".Length..].Trim().Trim('"');
            }
            else if (l.StartsWith("PUNCHLINE:", StringComparison.OrdinalIgnoreCase))
            {
                punchline = l["PUNCHLINE:".Length..].Trim().Trim('"');
            }
        }

        if (string.IsNullOrWhiteSpace(setup) || string.IsNullOrWhiteSpace(punchline))
        {
            _logger.LogInformation(
                "PoJoker: rewrite of joke {JokeId} did not parse into a setup and punchline.", original.Id);
            return null;
        }

        // Flags describe the ORIGINAL joke and are cleared deliberately: what gets
        // performed is a different joke, and leaving them set would misreport it.
        return original with
        {
            Type = "twopart",
            Setup = setup,
            Punchline = punchline,
            Joke = string.Empty,
            Flags = new JokeFlags(),
            Sanitized = true,
        };
    }
}
