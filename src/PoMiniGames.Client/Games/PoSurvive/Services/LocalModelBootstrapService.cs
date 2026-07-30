using Microsoft.JSInterop;

namespace PoMiniGamesClient.Games.PoSurvive.Services;

public sealed class LocalModelBootstrapService(IJSRuntime js, IConfiguration config)
{
    public List<LocalModelOption> ReadLocalModelOptions()
    {
        var options = new List<LocalModelOption>();
        var section = config.GetSection("Inference:LocalModelOptions");

        foreach (var child in section.GetChildren())
        {
            var id = child["Id"];
            if (string.IsNullOrWhiteSpace(id))
                continue;

            var label = child["Label"] ?? id;
            var description = child["Description"] ?? string.Empty;
            options.Add(new LocalModelOption(id, label, description));
        }

        if (options.Count == 0)
        {
            const string fallbackId = "Phi-4-mini-instruct-q4f16_1-MLC";
            options.Add(new LocalModelOption(
                Id: fallbackId,
                Label: "Phi-4-mini (4-bit)",
                Description: "Default local fallback model."));
        }

        return options;
    }

    // ReadAllModelOptions() lived here and merged the local list with a client-side
    // `Inference:RemoteModelOptions` list. That second list was the source of the
    // client/server model-id mismatch, so the remote half now comes from the server itself —
    // see InferenceBootstrapper.AvailableModels() and GET /api/infer/status.

    public string ResolveDefaultSelectedModelId(string? stateModelId, IReadOnlyList<LocalModelOption> options)
    {
        if (!string.IsNullOrWhiteSpace(stateModelId) && options.Any(o => o.Id == stateModelId))
            return stateModelId;

        var configModelId = config["Inference:ModelId"];

        if (!string.IsNullOrWhiteSpace(configModelId) && options.Any(o => o.Id == configModelId))
            return configModelId;

        return options[0].Id;
    }

    // ResolveDefaultSelectedModelIdFromAll and ResolveProviderKind are gone: the first never
    // had a caller, and the second was only used by the drawer's switch handler, which now
    // delegates the whole decision to InferenceBootstrapper.SwitchToAsync.

    public async Task InitModelAsync<TBridgeCallbacks>(DotNetObjectReference<TBridgeCallbacks> callbacksRef, string modelId)
        where TBridgeCallbacks : class
    {
        var cdnUrl = config["Inference:WebLlmCdnUrl"];
        var inferenceTimeoutMs = int.TryParse(config["Inference:InferenceTimeoutMs"], out var _itms) ? _itms : 15_000;
        var useJsonResponseFormat = bool.TryParse(config["Inference:UseJsonResponseFormat"], out var _ujrf) && _ujrf;
        var enableDiagnostics = !bool.TryParse(config["Inference:EnableDiagnostics"], out var _ed) || _ed;
        var shortCircuitOnBackpressure = !bool.TryParse(config["Inference:ShortCircuitOnBackpressure"], out var _scbp) || _scbp;
        var backpressureThreshold = int.TryParse(config["Inference:BackpressureThreshold"], out var _bpt) ? _bpt : 4;

        await js.InvokeVoidAsync("inferenceWorkerBridge.init", callbacksRef, modelId, cdnUrl, new
        {
            inferenceTimeoutMs,
            useJsonResponseFormat,
            enableDiagnostics,
            shortCircuitOnBackpressure,
            backpressureThreshold,
        });
    }

    public static string FormatBytes(long bytes) => bytes switch
    {
        >= 1_073_741_824 => $"{bytes / 1_073_741_824.0:F1} GB",
        >= 1_048_576 => $"{bytes / 1_048_576.0:F1} MB",
        >= 1_024 => $"{bytes / 1_024.0:F1} KB",
        _ => $"{bytes} B",
    };
}

public sealed record LocalModelOption(string Id, string Label, string Description);

/// <summary>
/// Unified model option shown in the model picker.
/// <c>IsRemote = false</c> → loaded via WebLLM in-browser.
/// <c>IsRemote = true</c>  → relayed through POST /api/infer to Azure OpenAI Foundry.
/// </summary>
public sealed record ModelOption(string Id, string Label, string Description, bool IsRemote);
