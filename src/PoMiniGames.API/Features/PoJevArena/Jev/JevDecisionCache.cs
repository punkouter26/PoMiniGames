using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena.Jev;

/// <summary>
/// Per-match memo of paid Jev answers, keyed on a coarse picture of the unit's situation: the same
/// creature at about the same HP, with the same abilities ready, facing the same kinds of enemy at
/// about the same range, gets the answer Jev already gave and costs nothing. Only successful
/// answers are stored, and the memo stops growing at <see cref="MaxEntries"/>.
/// </summary>
public sealed class JevDecisionCache
{
    public const int MaxEntries = 1_024;

    private readonly ConcurrentDictionary<string, JevAnswers> _answers = new(StringComparer.Ordinal);

    public int Count => _answers.Count;

    public bool TryGet(string key, out JevAnswers answers) => _answers.TryGetValue(key, out answers!);

    public void Store(string key, JevAnswers answers)
    {
        if (_answers.Count < MaxEntries) _answers.TryAdd(key, answers);
    }

    /// <summary>
    /// The quantized state: HP in tenths, cooldowns as ready/not, the status flags, allies near
    /// (capped at 3), cover in 3 m steps, stamina in quarters, the team-count lead (capped at ±3),
    /// and per candidate its focus, creature, 2 m range band and HP quarter.
    /// </summary>
    internal static string KeyOf(JevPromptFacts facts)
    {
        var s = facts.State;
        var inv = CultureInfo.InvariantCulture;
        var sb = new StringBuilder(192);
        sb.Append(facts.Blue ? 'B' : 'R').Append('|').Append(facts.Subject.Id).Append('|');
        sb.Append(inv, $"h{100 * s.Hp / PoJevArenaRules.BattleHp(facts.Subject.MaxHp) / 10}|");
        foreach (var cd in s.AbilityCooldowns) sb.Append(cd <= 0 ? '1' : '0');
        sb.Append('|')
          .Append(s.Poisoned ? 'P' : '-').Append(s.UnderFire ? 'F' : '-')
          .Append(s.InTar ? 'T' : '-').Append(s.InBrush ? 'S' : '-');
        sb.Append(inv, $"|a{Math.Min(3, s.AlliesNear)}");
        sb.Append(s.CoverDistanceM < 0 ? "|c-" : string.Create(inv, $"|c{Math.Min(4, (int)(s.CoverDistanceM / 3))}"));
        sb.Append(s.Stamina < 0 ? "|s-" : string.Create(inv, $"|s{s.Stamina / 25}"));
        var (allies, enemies) = facts.Blue ? (s.BlueAlive, s.RedAlive) : (s.RedAlive, s.BlueAlive);
        sb.Append(inv, $"|d{Math.Clamp(allies - enemies, -3, 3)}");
        foreach (var c in facts.Candidates.OrderBy(c => c.Candidate.Focus, StringComparer.Ordinal))
        {
            sb.Append('|').Append(c.Candidate.Focus).Append(':').Append(c.Creature.Id)
              .Append(inv, $":{Math.Min(6, (int)(c.Candidate.DistanceM / 2))}:{c.Candidate.HpPercent / 25}");
        }
        return sb.ToString();
    }
}
