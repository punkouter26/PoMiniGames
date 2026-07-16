using System.Collections;
using System.Reflection;
using FluentAssertions;

namespace PoMiniGames.Unit;

/// <summary>
/// Structural guardrail over every high-score board's <c>HighScoreDescriptor</c>.
/// </summary>
/// <remarks>
/// <para>
/// This exists because the MarbleRace board rejected <b>every</b> submission with a 500 for its
/// entire life and nothing noticed. The RowKey field names used to be discovered by probing
/// <c>ToFields(default!)</c> — passing null into each board's lambda — so a lambda that
/// dereferenced its argument threw on every save. MarbleRace's did; its two siblings happened to
/// use <c>?.</c> and survived. The probe is gone (descriptors now state <c>RowKeyFields</c>
/// outright), and these tests cover the failure modes that replaced it.
/// </para>
/// <para>
/// Reflection over the private descriptor fields is deliberate: the point is to assert something
/// about <em>every</em> board, including ones added later that never think about this file.
/// </para>
/// </remarks>
public sealed class HighScoreDescriptorTests
{
    private sealed record Board(string Name, object Descriptor, Type EntryType);

    private static readonly Board[] Boards = Discover();

    private static Board[] Discover()
    {
        var storageService = typeof(PoMiniGames.Infrastructure.Services.StorageService);
        var descriptorType = storageService.Assembly.GetType(
            "PoMiniGames.Infrastructure.Services.HighScoreDescriptor`1")!;

        return storageService
            .GetFields(BindingFlags.NonPublic | BindingFlags.Static)
            .Where(f => f.FieldType.IsGenericType && f.FieldType.GetGenericTypeDefinition() == descriptorType)
            .Select(f => new Board(f.Name, f.GetValue(null)!, f.FieldType.GetGenericArguments()[0]))
            .ToArray();
    }

    private static IDictionary<string, object?> ToFields(Board board, object entry)
    {
        var toFields = (Delegate)board.Descriptor.GetType().GetProperty("ToFields")!.GetValue(board.Descriptor)!;
        return (IDictionary<string, object?>)toFields.DynamicInvoke(entry)!;
    }

    private static IReadOnlyList<string> RowKeyFields(Board board) =>
        ((IEnumerable)board.Descriptor.GetType().GetProperty("RowKeyFields")!.GetValue(board.Descriptor)!)
            .Cast<string>().ToList();

    [Fact]
    public void EveryBoard_IsDiscovered()
    {
        // Guards the reflection above: if the descriptors are renamed or restructured, the other
        // tests would silently pass over an empty set.
        Boards.Select(b => b.Name).Should().Contain(["MarbleRaceScores", "PoBrawlScores", "PoRacerScores"]);
    }

    [Fact]
    public void EveryBoard_MapsADefaultEntryWithoutThrowing()
    {
        foreach (var board in Boards)
        {
            var entry = Activator.CreateInstance(board.EntryType)!;

            var map = () => ToFields(board, entry);

            map.Should().NotThrow($"{board.Name}.ToFields must handle a default {board.EntryType.Name}; " +
                                  "a board whose mapping throws rejects every submission with a 500");
        }
    }

    [Fact]
    public void EveryBoard_RowKeyFieldsExistInToFields()
    {
        // The failure this catches is quiet and total: DeterministicRowKey substitutes an empty
        // value for a name ToFields never emits, so a typo'd or stale entry here doesn't throw —
        // it makes every row on the board hash to the same RowKey and overwrite each other.
        foreach (var board in Boards)
        {
            var entry = Activator.CreateInstance(board.EntryType)!;
            var available = ToFields(board, entry).Keys;

            RowKeyFields(board).Should().BeSubsetOf(
                available,
                $"every {board.Name}.RowKeyFields entry must name a field {board.EntryType.Name} actually emits");
        }
    }

    [Fact]
    public void EveryBoard_RowKeyFieldsAreNonEmptyAndDistinct()
    {
        foreach (var board in Boards)
        {
            var fields = RowKeyFields(board);
            fields.Should().NotBeEmpty($"{board.Name} rows would all share one RowKey with no identity fields");
            fields.Should().OnlyHaveUniqueItems($"{board.Name} hashes each RowKey field once");
        }
    }
}
