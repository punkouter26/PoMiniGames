namespace PoMiniGames.Features.Shared;

/// <summary>
/// The shared mock-fallback gate for every AI-consuming game service.
/// </summary>
/// <remarks>
/// <para>
/// Three services (PoCoupleQuiz, PoFunQuiz, PoJoker) carried byte-identical private
/// <c>IsNonProduction()</c> helpers and the same "mock only when the flag is on AND the
/// environment is safe" decision. Duplicated predicates drift — the standing example is
/// <c>IFaceAnalysisService</c>, which ended up unmocked because one copy of a related
/// dictionary was updated and the others were not. One helper, one definition.
/// </para>
/// <para>
/// The rule itself is unchanged: fabricated AI output may be served in Development and Test
/// (where the foundry is often unconfigured and a mock keeps the game playable), never in
/// Production (where a misconfigured deployment must fail loudly rather than silently serve
/// invented data).
/// </para>
/// </remarks>
public static class AiMockFallback
{
    /// <summary>
    /// True when the current environment may serve mock AI output. Development and the
    /// E2E "Test" environment only.
    /// </summary>
    public static bool IsNonProduction(IHostEnvironment environment)
        => environment.IsDevelopment() || environment.IsEnvironment("Test");

    /// <summary>
    /// True when the game's <c>UseMockAI</c> flag is set AND the environment permits mocks —
    /// the complete gate every mock fallback must pass before serving fabricated data.
    /// </summary>
    public static bool ShouldUseMock(IHostEnvironment environment, bool useMockAiFlag)
        => useMockAiFlag && IsNonProduction(environment);
}
