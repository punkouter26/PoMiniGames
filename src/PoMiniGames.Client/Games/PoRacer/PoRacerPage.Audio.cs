namespace PoMiniGamesClient.Games.PoRacer;

public partial class PoRacerPage
{
    private int _lastLap, _lastPosition;
    private bool _boosting;

    private async Task UpdateAudioAsync()
    {
        if (Player is not { } player) return;
        if (_lastLap == 0)
        {
            _announcement = "Race started.";
            await Feedback.CueAtAsync("poracer", "rev");
        }
        else if (player.Lap > _lastLap && player.Lap <= _totalLaps)
        {
            _announcement = player.Lap == _totalLaps ? "Final lap." : $"Lap {player.Lap} of {_totalLaps}.";
            await Feedback.CueAtAsync("poracer", "checkpoint");
        }
        if (_lastPosition > 0 && player.Position < _lastPosition)
        {
            _announcement = $"Position {player.Position}.";
            await Feedback.CueAtAsync("poracer", "shift", gain: 0.85);
        }
        var boosting = player.BoostTimer > 0;
        if (boosting && !_boosting) await Feedback.CueAtAsync("poracer", "boostPad");
        _boosting = boosting;
        _lastLap = player.Lap;
        _lastPosition = player.Position;
    }
}
