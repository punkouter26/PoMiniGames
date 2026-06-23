using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

namespace PoMiniGames.Features.PoFace.Storage;

/// <summary>
/// Stores round-capture JPEGs in the <c>poface-captures</c> blob container. The
/// container is created by <c>StorageInitializer</c> at host startup. Per the 2026
/// design, the blob lifecycle policy in <c>infra/storage-lifecycle.json</c> cools
/// captures at 180 days, archives at 365, and deletes <c>non-best/</c> after 2 days.
/// </summary>
public interface IBlobImageRepository
{
    /// <summary>Upload a JPEG to the canonical <c>{userId}/{sessionId}/round-{n}.jpg</c> path.</summary>
    /// <returns>The blob URI on success, or null if storage is unavailable (caller logs and continues).</returns>
    Task<string?> UploadAsync(string userId, string sessionId, int roundNumber, byte[] imageJpeg, CancellationToken cancellationToken = default);

    /// <summary>Resolve a stored blob URI to its public URL. Returns a placeholder when the blob is missing.</summary>
    string ResolveUri(string userId, string sessionId, int roundNumber);
}

public sealed class BlobImageRepository : IBlobImageRepository
{
    private const string ContainerName = "poface-captures";
    private const string PlaceholderUri = "/images/placeholder-round.jpg";

    private readonly BlobContainerClient _container;
    private readonly ILogger<BlobImageRepository> _logger;

    public BlobImageRepository(BlobServiceClient blobServiceClient, ILogger<BlobImageRepository> logger)
    {
        _container = blobServiceClient.GetBlobContainerClient(ContainerName);
        _logger = logger;
    }

    public async Task<string?> UploadAsync(string userId, string sessionId, int roundNumber, byte[] imageJpeg, CancellationToken cancellationToken = default)
    {
        if (imageJpeg is null || imageJpeg.Length == 0) return null;
        try
        {
            var blobName = $"{userId}/{sessionId}/round-{roundNumber}.jpg";
            var client = _container.GetBlobClient(blobName);
            var headers = new BlobHttpHeaders { ContentType = "image/jpeg" };
            using var stream = new MemoryStream(imageJpeg, writable: false);
            await client.UploadAsync(stream, headers, cancellationToken: cancellationToken);
            return client.Uri.ToString();
        }
        catch (Exception ex)
        {
            // The round score is already recorded in table storage; blob failure is
            // best-effort. The recap page falls back to the placeholder image.
            _logger.LogWarning(ex, "Failed to upload PoFace round capture for {UserId}/{SessionId}/round-{Round}", userId, sessionId, roundNumber);
            return null;
        }
    }

    public string ResolveUri(string userId, string sessionId, int roundNumber) =>
        $"{_container.Uri}/{userId}/{sessionId}/round-{roundNumber}.jpg";
}
