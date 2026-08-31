namespace PoMiniGamesClient.Models;

/// <summary>
/// Mirror of <c>Features.PoGallery.PoGalleryEndpoints.GalleryManifest</c> on the API.
/// Kept as a separate DTO so the WASM client doesn't reference the server project
/// directly. Wire shape is documented there.
/// </summary>
public sealed record GalleryManifest(
    string GeneratedAt,
    string Environment,
    IReadOnlyList<GalleryModel> Models);

public sealed record GalleryModel(
    string Id,
    string Title,
    string Description,
    string ReferenceImage,
    string ModelUrl,
    string ViewerUrl,
    string Kind = "model");
