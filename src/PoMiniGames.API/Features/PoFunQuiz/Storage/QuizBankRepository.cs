using System.Text.Json;
using Azure;
using Azure.Data.Tables;

namespace PoMiniGames.Features.PoFunQuiz.Storage;

/// <summary>One banked question. PartitionKey = category, RowKey = <see cref="QuizQuality.Hash"/> of the text.</summary>
public sealed class QuizBankEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }

    public string Text { get; set; } = string.Empty;

    /// <summary>The four options as a JSON array, in stored order.</summary>
    public string OptionsJson { get; set; } = "[]";

    public int CorrectOptionIndex { get; set; }
    public string Difficulty { get; set; } = nameof(DifficultyLevel.Medium);

    /// <summary>Where it came from: <c>OpenTDB</c>, <c>Bundled</c> or <c>AI</c>.</summary>
    public string Source { get; set; } = string.Empty;
}

/// <summary>
/// The permanent PoFunQuiz question bank in Table Storage (<c>PoFunQuizBank</c>). It only grows:
/// Open Trivia DB, the bundled set and (opt-in) AI top-ups are written in, and quizzes are dealt
/// out of it at random. Replaces the six-hour regenerate-on-expiry cache as the default path.
/// </summary>
/// <remarks>
/// <para>
/// <b>Dedup is structural.</b> The row key is the normalized-text hash, so writing a question the
/// bank already holds collides on (category, hash) and the 409 is the dedupe — no read-before-write.
/// </para>
/// <para>
/// <b>Never throws.</b> Like <see cref="LeaderboardRepository"/>, an unreachable backend degrades:
/// reads return null ("unknown", not "empty") and writes are dropped. The caller still has the
/// bundled set and the live Open Trivia DB fetch.
/// </para>
/// </remarks>
public sealed class QuizBankRepository(TableServiceClient tableServiceClient, ILogger<QuizBankRepository> logger)
{
    /// <summary>Must match the entry in <c>StorageInitializer.AdditionalTables</c>.</summary>
    public const string TableName = "PoFunQuizBank";

    private readonly TableClient _table = tableServiceClient.GetTableClient(TableName);

    /// <summary>Every banked question in a category, or null when storage could not be read.</summary>
    public async Task<List<QuizQuestion>?> GetCategoryAsync(QuestionCategory category, CancellationToken cancellationToken)
    {
        var results = new List<QuizQuestion>();
        try
        {
            await foreach (var row in _table.QueryAsync<QuizBankEntity>(
                filter: TableClient.CreateQueryFilter($"PartitionKey eq {category.ToString()}"),
                maxPerPage: 1000,
                cancellationToken: cancellationToken))
            {
                if (ToQuestion(row, category) is { } question) results.Add(question);
            }
            return results;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation(ex, "Quiz bank unreadable for {Category}; serving from the bundled set.", category);
            return null;
        }
    }

    /// <summary>Writes the questions the bank does not already hold. Returns how many were new.</summary>
    public async Task<int> AddAsync(
        QuestionCategory category, IEnumerable<QuizQuestion> questions, string source, CancellationToken cancellationToken)
    {
        var added = 0;
        foreach (var q in questions)
        {
            if (QuizQuality.Reject(q.Text, q.Options, q.CorrectOptionIndex) is not null) continue;
            var entity = new QuizBankEntity
            {
                PartitionKey = category.ToString(),
                RowKey = QuizQuality.Hash(q.Text),
                Text = q.Text,
                OptionsJson = JsonSerializer.Serialize(q.Options),
                CorrectOptionIndex = q.CorrectOptionIndex,
                Difficulty = q.Difficulty.ToString(),
                Source = source,
            };
            try
            {
                await _table.AddEntityAsync(entity, cancellationToken);
                added++;
            }
            catch (RequestFailedException ex) when (ex.Status == 409)
            {
                // Already banked (same normalized text) — the row key is the dedupe.
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                // Storage down: stop trying this batch. The questions are still served from memory.
                logger.LogInformation(ex, "Quiz bank write failed for {Category}; dropping the rest of this batch.", category);
                break;
            }
        }
        return added;
    }

    private static QuizQuestion? ToQuestion(QuizBankEntity row, QuestionCategory category)
    {
        List<string>? options;
        try { options = JsonSerializer.Deserialize<List<string>>(row.OptionsJson); }
        catch (JsonException) { return null; }
        if (options is null || QuizQuality.Reject(row.Text, options, row.CorrectOptionIndex) is not null) return null;

        return new QuizQuestion
        {
            Text = row.Text,
            Options = options,
            CorrectOptionIndex = row.CorrectOptionIndex,
            Category = category,
            Difficulty = Enum.TryParse<DifficultyLevel>(row.Difficulty, out var d) ? d : DifficultyLevel.Medium,
        };
    }
}
