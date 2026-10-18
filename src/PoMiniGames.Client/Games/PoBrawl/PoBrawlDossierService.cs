using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>
/// The fighter dossiers for <see cref="PoBrawlDossierCard"/>: fetched from
/// <c>GET /api/pobrawl/dossier</c> once per app life and kept. Until the fetch lands, or when it
/// fails, <see cref="Peek"/> answers with the static facts, so a card always has something to show.
/// </summary>
public sealed class PoBrawlDossierService(ApiService api)
{
    private static readonly Dictionary<string, PoBrawlDossierDto> Static =
        PoBrawlDossiers.StaticDtos().ToDictionary(d => d.FighterId, StringComparer.OrdinalIgnoreCase);

    private Dictionary<string, PoBrawlDossierDto>? _loaded;
    private Task<bool>? _load;

    /// <summary>The best dossier on hand for <paramref name="fighterId"/>, or null for an unknown id.</summary>
    public PoBrawlDossierDto? Peek(string? fighterId)
    {
        if (string.IsNullOrEmpty(fighterId)) return null;
        if (_loaded is not null && _loaded.TryGetValue(fighterId, out var loaded)) return loaded;
        return Static.GetValueOrDefault(fighterId);
    }

    /// <summary>
    /// Fetches the server list once; concurrent callers share the one request. True when the
    /// server list is in. A failed fetch is forgotten, so the next card to ask tries again.
    /// </summary>
    public Task<bool> EnsureLoadedAsync() => _loaded is not null ? Task.FromResult(true) : _load ??= LoadAsync();

    private async Task<bool> LoadAsync()
    {
        var list = await api.GetPoBrawlDossiersAsync();
        if (list is null || list.Count == 0)
        {
            _load = null;
            return false;
        }

        _loaded = list
            .Where(d => !string.IsNullOrEmpty(d.FighterId))
            .GroupBy(d => d.FighterId, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        return true;
    }
}
