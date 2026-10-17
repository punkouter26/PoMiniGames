using System.Reflection;
using System.Runtime.ExceptionServices;

namespace PoMiniGames.Unit;

/// <summary>
/// Runs one named scenario of a test class. This is how the Unit tier stays inside its
/// 100-method cap without losing coverage: the checks of one unit live as private methods,
/// and one <c>[Theory]</c> lists them by <c>nameof</c>, one <c>[InlineData]</c> row each, so
/// every scenario still runs, passes and fails on its own row.
/// </summary>
internal static class Scenarios
{
    private const BindingFlags Declared =
        BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

    public static async Task RunAsync(object testClass, string name)
    {
        var method = testClass.GetType().GetMethod(name, Declared, Type.EmptyTypes)
            ?? throw new ArgumentException($"{testClass.GetType().Name} has no scenario named {name}.", nameof(name));

        object? result;
        try
        {
            result = method.Invoke(method.IsStatic ? null : testClass, null);
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            // Surface the assertion itself, not the reflection wrapper.
            ExceptionDispatchInfo.Throw(ex.InnerException);
            throw;
        }

        if (result is Task task) await task;
    }
}
