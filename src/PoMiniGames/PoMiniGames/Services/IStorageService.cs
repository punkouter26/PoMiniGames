using PoMiniGames.DTOs;
using PoMiniGames.Models;

namespace PoMiniGames.Services;

/// <summary>
/// Unified storage abstraction. Features should prefer the narrower
/// <see cref="IPlayerStatsStorage"/>, <see cref="ISnakeStorage"/>, or
/// <see cref="IPoDropSquareStorage"/> interfaces where possible.
/// </summary>
public interface IStorageService : IPlayerStatsStorage, ISnakeStorage, IPoDropSquareStorage { }

