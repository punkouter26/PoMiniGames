namespace PoMiniGamesClient.Games.PoRunner;

public enum PoRunnerGameMode
{
    OnePlayer,
    TwoPlayer,
    Multiplayer,
    Demo
}

public enum PlayerDirection
{
    East,
    West,
    North,
    South
}

public enum PlayerAction
{
    Idle,
    Walk
}

public enum GameStatus
{
    Waiting,
    ReadyCheck,
    Countdown,
    Playing,
    GameOver
}

public enum SoundTheme
{
    Default,
    Jungle,
    Retro,
    Silent
}