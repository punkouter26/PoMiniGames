namespace PoMiniGames.AI;

/// <summary>
/// What a given deployment will accept on the wire, so a call can ask for the strongest output
/// contract the model actually supports instead of the strongest one that exists.
/// </summary>
/// <remarks>
/// <para>
/// This is the coupling that made moving cheap tasks onto cheaper deployments unsafe. The two
/// knobs <see cref="AiDecisionChatOptions"/> relies on are not universal:
/// </para>
/// <list type="bullet">
///   <item><c>reasoning_effort</c> exists only on the reasoning families (gpt-5*, o*). Sending it
///   to <c>Phi-4-mini-instruct</c> is a <c>400 unsupported_parameter</c>, not a no-op.</item>
///   <item><c>response_format: json_schema</c> (structured outputs) is likewise not implemented by
///   the Phi deployments on the shared account; they accept <c>json_object</c> only. Asking for a
///   schema there fails the call outright, which would turn a cost optimisation into an outage.</item>
/// </list>
/// <para>
/// So capability is resolved per deployment and the options builder degrades: schema where the
/// model supports it, JSON-object mode plus a prompt-carried contract where it does not. The
/// parsers downstream were already tolerant of the weaker mode — it is what every game except
/// PoSurvive used before — so degrading is safe, it just stops being *enforced*.
/// </para>
/// <para>
/// <b>Heuristic, with an override.</b> Matching on the deployment name is inference, not fact: a
/// deployment can be named anything. It is the pragmatic default because the alternative — probing
/// each deployment's capabilities at startup — costs a paid call per deployment per boot to learn
/// something that changes about once a year. <see cref="AIFoundryOptions.ModelCapabilityOverrides"/>
/// is the escape hatch when a name lies, and it is checked first.
/// </para>
/// </remarks>
public static class AiModelCapabilities
{
    /// <summary>Capabilities of one deployment, as far as the call options are concerned.</summary>
    /// <param name="SupportsReasoningEffort">True when <c>reasoning_effort</c> may be sent.</param>
    /// <param name="SupportsJsonSchema">True when <c>response_format: json_schema</c> may be sent.</param>
    /// <param name="SupportsTemperature">True when a non-default temperature may be sent. The
    /// reasoning families reject it outright (<c>400 unsupported_value</c>), which is why nothing
    /// in this solution sets one; recorded here so a future caller does not rediscover it.</param>
    public readonly record struct Capabilities(
        bool SupportsReasoningEffort,
        bool SupportsJsonSchema,
        bool SupportsTemperature);

    /// <summary>
    /// Everything a modern Azure OpenAI reasoning deployment (gpt-5.4-nano, gpt-5-nano,
    /// gpt-5.4-mini) accepts: schema output and reasoning effort, but no temperature.
    /// </summary>
    private static readonly Capabilities Reasoning = new(
        SupportsReasoningEffort: true, SupportsJsonSchema: true, SupportsTemperature: false);

    /// <summary>
    /// A conventional chat deployment: schema and temperature, no reasoning knob. Nothing on the
    /// shared account is currently in this class; it exists so a gpt-4.1-class deployment added
    /// later is classified correctly rather than falling into <see cref="Basic"/>.
    /// </summary>
    private static readonly Capabilities Conventional = new(
        SupportsReasoningEffort: false, SupportsJsonSchema: true, SupportsTemperature: true);

    /// <summary>
    /// The floor: JSON-object mode only. Used for the Phi deployments and for any unrecognised
    /// name, because the safe assumption about an unknown model is that it supports the least.
    /// </summary>
    private static readonly Capabilities Basic = new(
        SupportsReasoningEffort: false, SupportsJsonSchema: false, SupportsTemperature: true);

    /// <summary>
    /// Resolves what <paramref name="deployment"/> accepts. <paramref name="overrides"/> — from
    /// <see cref="AIFoundryOptions.ModelCapabilityOverrides"/> — wins over the name heuristic.
    /// </summary>
    public static Capabilities For(string? deployment, IReadOnlyDictionary<string, string>? overrides = null)
    {
        if (string.IsNullOrWhiteSpace(deployment))
            return Basic;

        if (overrides is not null)
        {
            foreach (var (key, profile) in overrides)
            {
                if (string.Equals(key, deployment, StringComparison.OrdinalIgnoreCase))
                    return FromProfileName(profile);
            }
        }

        // Reasoning families. Prefix match rather than exact, because deployments on this account
        // are named after the model they serve (gpt-5.4-nano, gpt-5-nano, gpt-5.4-mini).
        if (deployment.StartsWith("gpt-5", StringComparison.OrdinalIgnoreCase)
            || deployment.StartsWith("o1", StringComparison.OrdinalIgnoreCase)
            || deployment.StartsWith("o3", StringComparison.OrdinalIgnoreCase)
            || deployment.StartsWith("o4", StringComparison.OrdinalIgnoreCase))
        {
            return Reasoning;
        }

        if (deployment.StartsWith("gpt-4", StringComparison.OrdinalIgnoreCase))
            return Conventional;

        // Phi-4, Phi-4-mini-instruct, and anything unrecognised.
        return Basic;
    }

    /// <summary>Maps an override profile name to a capability set. Unknown names get the floor.</summary>
    private static Capabilities FromProfileName(string? profile) => profile?.Trim().ToLowerInvariant() switch
    {
        "reasoning" => Reasoning,
        "conventional" => Conventional,
        _ => Basic,
    };
}
