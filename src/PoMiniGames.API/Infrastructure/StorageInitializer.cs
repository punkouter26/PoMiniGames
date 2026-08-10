using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Eager, idempotent initialization of the Azure Storage tables and blob containers used by
/// the games consolidated into PoMiniGames. Runs at host startup alongside
/// <see cref="PoMiniGames.Infrastructure.Services.StorageService.Initialize"/>.
/// </summary>
/// <remarks>
/// Pattern: Lazy Singleton (table-only here) + Idempotent Bootstrap. A missing table is the
/// single most common reason for a 500 in a freshly provisioned environment; we ensure
/// everything in one place rather than scattering <c>CreateIfNotExistsAsync</c> calls.
/// Best-effort: a failure logs a warning and lets the app continue. Real failures surface
/// at first use via the existing <c>Table(...)</c> lazy path in
/// <see cref="PoMiniGames.Infrastructure.Services.StorageService"/>.
/// </remarks>
public sealed class StorageInitializer
{
    /// <summary>Tables used by the consolidated games.</summary>
    public static readonly string[] AdditionalTables =
    [
        // "PoCoupleQuizTeams" and "PoCoupleQuizHistory" were dropped with the Teams
        // subsystem (2026-08-10): nothing in the game ever wrote a row to either, so both
        // tables were created on every boot and stayed empty for the life of the app.
        "PoFunQuizPlayers",
        // PoSurvive persistence: backs /api/evolution/record. Without eager creation
        // that endpoint returns 500 with "No Azure Table…". Name must match the
        // constant in EvolutionRepository.
        // "SimulationSessions" and "HeartbeatEvents" were dropped with the /api/sessions
        // endpoint — nothing read them, and SaveHeartbeatBatchAsync never had a caller.
        "EvolutionRecords",
        // PoJoker (demo-only): per-session joke-performance records that back the
        // /api/joker/leaderboard surface (PartitionKey = SessionId).
        "PoJokerPerformances",
    ];

    /// <summary>Blob containers used by the consolidated games (none beyond the base container set).</summary>
    public static readonly string[] AdditionalBlobContainers =
    [
    ];

    private readonly TableServiceClient _tableServiceClient;
    private readonly BlobServiceClient? _blobServiceClient;
    private readonly ILogger<StorageInitializer> _logger;

    public StorageInitializer(IConfiguration configuration, ILogger<StorageInitializer> logger)
    {
        _logger = logger;

        var section = configuration.GetSection("PoMiniGames:Storage:TableService");
        var connectionString = section["ConnectionString"];
        var endpoint = section["Endpoint"];
        var accountName = section["AccountName"];

        if (!string.IsNullOrWhiteSpace(connectionString))
        {
            _tableServiceClient = new TableServiceClient(connectionString);
        }
        else if (!string.IsNullOrWhiteSpace(endpoint) || !string.IsNullOrWhiteSpace(accountName))
        {
            var serviceUri = !string.IsNullOrWhiteSpace(endpoint)
                ? new Uri(endpoint!)
                : new Uri($"https://{accountName}.table.core.windows.net");
            _tableServiceClient = new TableServiceClient(serviceUri, new DefaultAzureCredential());
        }
        else
        {
            _tableServiceClient = new TableServiceClient("UseDevelopmentStorage=true");
        }

        // Blob service: same credential path; falls back to the dev emulator. Lazy-initialized
        // so a missing blob endpoint is non-fatal (PoCoupleQuiz / PoFunQuiz don't need it).
        var blobConnectionString = section["BlobConnectionString"];
        var blobEndpoint = section["BlobEndpoint"];
        if (!string.IsNullOrWhiteSpace(blobConnectionString))
        {
            _blobServiceClient = new BlobServiceClient(blobConnectionString);
        }
        else if (!string.IsNullOrWhiteSpace(blobEndpoint))
        {
            _blobServiceClient = new BlobServiceClient(new Uri(blobEndpoint), new DefaultAzureCredential());
        }
        else if (!string.IsNullOrWhiteSpace(accountName))
        {
            _blobServiceClient = new BlobServiceClient(
                new Uri($"https://{accountName}.blob.core.windows.net"),
                new DefaultAzureCredential());
        }
    }

    /// <summary>
    /// Eagerly create every consolidated-game table and blob container. Idempotent —
    /// safe to call on every startup.
    /// </summary>
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        foreach (var table in AdditionalTables)
        {
            try
            {
                var client = _tableServiceClient.GetTableClient(table);
                await client.CreateIfNotExistsAsync(cancellationToken);
                _logger.LogInformation("Storage table ensured: {Table}", table);
            }
            catch (Exception ex)
            {
                // Best-effort: log and continue. The lazy path in StorageService will retry
                // on first real use.
                _logger.LogWarning(ex, "Failed to ensure storage table {Table}; will retry lazily on first use", table);
            }
        }

        if (_blobServiceClient is not null)
        {
            foreach (var container in AdditionalBlobContainers)
            {
                try
                {
                    var client = _blobServiceClient.GetBlobContainerClient(container);
                    await client.CreateIfNotExistsAsync(cancellationToken: cancellationToken);
                    _logger.LogInformation("Storage blob container ensured: {Container}", container);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to ensure blob container {Container}; will retry lazily on first use", container);
                }
            }
        }
    }
}
