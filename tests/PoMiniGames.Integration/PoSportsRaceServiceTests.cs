using System.Collections.Concurrent;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Application.DTOs;
using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.PoSports;
using PoShared.Games;

namespace PoMiniGames.Integration;

/// <summary>
/// Online-path coverage for the PoSports race service with no live hub and no
/// timers (startTimers:false + manual Advance): lobby-seeded lane layout, key
/// routing, phase flow, and score persistence through a capturing storage fake.
/// Lives in the Integration tier — the Unit tier is at its 100-method ceiling.
/// </summary>
public sealed class PoSportsRaceServiceTests
{
    private const double Dt = 1.0 / 60.0;

    /// <summary>Captures saved PoSports scores; every other member is inert.</summary>
    private sealed class CapturingStorage : IStorageService
    {
        public readonly ConcurrentBag<PoSportsHighScore> Saved = [];

        public Task<List<PoSportsHighScore>> GetPoSportsHighScoresAsync(int limit = 10) =>
            Task.FromResult(Saved.OrderBy(s => s.TotalTimeSeconds).Take(limit).ToList());

        public Task<PoSportsHighScore> SavePoSportsHighScoreAsync(PoSportsHighScore entry)
        {
            Saved.Add(entry);
            return Task.FromResult(entry);
        }

        // Inert surface — PoSports never touches these.
        public IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(CancellationToken ct = default) =>
            throw new NotSupportedException();
        public Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName) =>
            Task.FromResult<PlayerStats?>(null);
        public Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats) => Task.CompletedTask;
        public Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null) =>
            Task.FromResult(new List<(string, PlayerStats)>());
        public Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10) =>
            Task.FromResult(new List<MarbleRaceHighScore>());
        public Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry) => Task.FromResult(entry);
        public Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10) =>
            Task.FromResult(new List<PoBrawlHighScore>());
        public Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry) => Task.FromResult(entry);
        public Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10) =>
            Task.FromResult(new List<PoRacerHighScore>());
        public Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry) => Task.FromResult(entry);
        public Task<List<PoBrawlLadderEntry>> GetPoBrawlLadderAsync(int limit = 10) =>
            Task.FromResult(new List<PoBrawlLadderEntry>());
        public Task<PoBrawlLadderEntry> SavePoBrawlLadderAsync(PoBrawlLadderEntry entry) => Task.FromResult(entry);
    }

    private static (PoSportsRaceService race, PoSportsLobbyService lobby, CapturingStorage storage) StartedRace()
    {
        var lobby = new PoSportsLobbyService();
        lobby.Open("conn-alice", "Alice", isGuest: false);
        lobby.Open("conn-bob", "Bob", isGuest: true);
        lobby.PickCharacter("conn-alice", "dad");
        lobby.PickCharacter("conn-bob", "mom");
        lobby.SetReady("conn-bob", true);
        lobby.TryStart("conn-alice").Should().BeTrue();

        var storage = new CapturingStorage();
        var race = new PoSportsRaceService(
            "LOBBY", lobby.Members, lobby, storage,
            NullLogger<PoSportsRaceService>.Instance, startTimers: false, seed: 11);
        return (race, lobby, storage);
    }

    private static void Advance(PoSportsRaceService race, double seconds)
    {
        for (var i = 0; i < (int)(seconds / Dt); i++) race.Advance(Dt);
    }

    [Fact]
    public void LobbySeeding_HumansFirst_AiFillsRemainingLanes()
    {
        var (race, _, _) = StartedRace();

        var snap = race.Snapshot();

        snap.Phase.Should().Be("countdown");
        snap.Lanes.Should().HaveCount(4);
        snap.Lanes[0].Should().Match<PoSportsLaneState>(l => l.Name == "Alice" && l.Character == "dad" && !l.IsAi);
        snap.Lanes[1].Should().Match<PoSportsLaneState>(l => l.Name == "Bob" && l.Character == "mom" && !l.IsAi);
        snap.Lanes.Skip(2).Should().OnlyContain(l => l.IsAi, "unpicked family members fill the track");
        snap.Lanes.Select(l => l.Character).Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void KeyRouting_AdvancesOnlyTheSendersLane()
    {
        var (race, _, _) = StartedRace();
        race.RegisterOwner("conn-alice", "Alice", "user-alice", isGuest: false);
        race.RegisterOwner("conn-bob", "Bob", "", isGuest: true);
        Advance(race, 3.1); // countdown over, gun fired

        // Alice types a full correct cycle; Bob types one wrong-order key.
        for (var step = 0; step < 4; step++) race.SendSequenceKey("conn-alice", step);
        race.SendSequenceKey("conn-bob", 2);
        race.Advance(Dt);

        var snap = race.Snapshot();
        snap.Lanes[0].Speed.Should().BeGreaterThan(0, "a completed cycle injects an impulse");
        snap.Lanes[1].Speed.Should().Be(0);
        snap.Lanes[1].SeqProgress.Should().Be(0, "an out-of-order key resets the cycle");
    }

    [Fact]
    public void MeetFlow_InterstitialAutoAdvances_And_PersistsHumanScores()
    {
        var (race, lobby, storage) = StartedRace();
        race.RegisterOwner("conn-alice", "Alice", "user-alice", isGuest: false);
        race.RegisterOwner("conn-bob", "Bob", "", isGuest: true);

        var finished = false;
        race.Finished += _ => finished = true;

        // Humans idle; the 90s leg timeout + AI lanes carry the meet to the podium.
        // countdown 3 + sprint ≤90 + interstitial 8 + hurdles ≤90 + margin.
        Advance(race, 3 + 90 + 8 + 90 + 2);

        var snap = race.Snapshot();
        snap.Phase.Should().Be("podium");
        finished.Should().BeTrue();
        snap.Lanes.Select(l => l.Placing).Should().BeEquivalentTo([1, 2, 3, 4]);

        // Exactly the two human lanes persisted — guest and authed shapes intact.
        storage.Saved.Should().HaveCount(2);
        var alice = storage.Saved.Single(s => s.PlayerName == "Alice");
        alice.UserId.Should().Be("user-alice");
        alice.IsGuest.Should().BeFalse();
        var bob = storage.Saved.Single(s => s.PlayerName == "Bob");
        bob.IsGuest.Should().BeTrue();
        storage.Saved.Should().OnlyContain(s =>
            Math.Abs(s.SprintSeconds + s.HurdlesSeconds - s.TotalTimeSeconds) < 0.001
            && s.GameCode == "LOBBY");

        // The meet's end resets the lobby for the next ready round.
        lobby.State.Phase.Should().Be("waiting");
    }

    [Fact]
    public void DisconnectDecays_RejoinResetsSequenceProgress()
    {
        var (race, _, _) = StartedRace();
        race.RegisterOwner("conn-alice", "Alice", "user-alice", isGuest: false);
        Advance(race, 3.1);

        // Build speed and a partial sequence.
        for (var step = 0; step < 4; step++) race.SendSequenceKey("conn-alice", step);
        race.SendSequenceKey("conn-alice", 0);
        race.SendSequenceKey("conn-alice", 1);
        race.Snapshot().Lanes[0].SeqProgress.Should().Be(2);
        var speedAtDrop = race.Snapshot().Lanes[0].Speed;

        // Disconnect: the lane keeps running and decays; keys from the dead conn are ignored.
        race.RemoveConnection("conn-alice");
        race.SendSequenceKey("conn-alice", 2);
        Advance(race, 1.0);
        var decayed = race.Snapshot().Lanes[0];
        decayed.Speed.Should().BeLessThan(speedAtDrop).And.BeGreaterThan(0);

        // Rejoin from a new connection rebinds the lane and resets the rhythm.
        race.RegisterOwner("conn-alice-2", "Alice", "user-alice", isGuest: false).Should().Be(0);
        race.Snapshot().Lanes[0].SeqProgress.Should().Be(0);
        for (var step = 0; step < 4; step++) race.SendSequenceKey("conn-alice-2", step);
        race.Advance(Dt);
        race.Snapshot().Lanes[0].Speed.Should().BeGreaterThan(decayed.Speed - 0.2,
            "the rebound connection's keys drive the same lane");
    }
}
