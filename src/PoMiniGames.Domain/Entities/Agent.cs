namespace PoMiniGames.Domain.Entities.Simulation;

using PoMiniGames.Domain.Enums.Simulation;
using PoMiniGames.Domain.ValueObjects.Simulation;

// SOLID: SRP — Agent owns only its own state; all behaviour is in external service classes
public sealed class Agent
{
    private int   _hp;
    private float _hunger;

    public string          Id               { get; }
    public TeamColor       Team             { get; }
    public PersonalityDna  Dna              { get; }
    public GridCoordinate  Position         { get; set; }
    public bool            IsFading         { get; set; }
    public AgentAction?    LastAction        { get; set; }
    public string?         LastThought      { get; set; }
    public int             KillCount        { get; set; }
    public int             FoodConsumed     { get; set; }
    public int             TotalDamageDealt { get; set; }
    
    public int Hp
    {
        get => _hp;
        set => _hp = Math.Clamp(value, 0, 100);
    }

    public float Hunger
    {
        get => _hunger;
        set => _hunger = Math.Clamp(value, 0f, 1f);
    }

    public bool IsAlive => Hp > 0;

    public Agent(string id, TeamColor team, GridCoordinate position, PersonalityDna dna, int startingHp = 100)
    {
        // Invariant: Id must be one letter (R/B) + one digit
        if (id.Length != 2 || id[0] is not ('R' or 'B') || !char.IsDigit(id[1]))
            throw new ArgumentException($"Agent Id must be one letter (R/B) followed by a digit, got '{id}'.", nameof(id));

        Id       = id;
        Team     = team;
        Position = position;
        Dna      = dna;
        _hp      = Math.Clamp(startingHp, 0, 100);
        _hunger  = 0f;
    }
}
