namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Server-only lane seed handed from the lobby to the race: the member's sanitized
/// display name and character plus the claim-derived identity. Deliberately NOT part
/// of <c>PoMiniGames.Shared.Games</c> — <c>UserId</c> must never ride along in the lobby state
/// broadcast, and lane ownership is bound by it (never by the client-supplied name).
/// </summary>
/// <param name="UserId">Claim-derived id, or "" for a caller with no stable id.</param>
public sealed record PoSportsRaceSeat(string DisplayName, string Character, string UserId, bool IsGuest);
