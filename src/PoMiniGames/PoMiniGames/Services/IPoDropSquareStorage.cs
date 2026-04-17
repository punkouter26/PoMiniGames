using PoMiniGames.Models;

namespace PoMiniGames.Services;

/// <summary>
/// Narrow storage contract for the PoDropSquare high-score feature slice.
/// </summary>
public interface IPoDropSquareStorage
{
    Task<List<PoDropSquareHighScore>> GetPoDropSquareHighScoresAsync(int limit = 10);
    Task<PoDropSquareHighScore> SavePoDropSquareHighScoreAsync(PoDropSquareHighScore entry);
}
