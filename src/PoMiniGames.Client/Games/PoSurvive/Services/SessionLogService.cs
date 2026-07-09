namespace PoMiniGamesClient.Games.PoSurvive.Services;

using System.Text;
using Microsoft.JSInterop;
using PoShared.Simulation.Models;

/// <summary>
/// Accumulates <see cref="HeartbeatEventDto"/> records in memory during a session;
/// buffers each record to IndexedDB via <c>indexedDbStore.js</c>;
/// exposes <see cref="DownloadLog"/> which exports a plain-text log and triggers a
/// browser download via JS Interop <c>URL.createObjectURL</c>.
/// </summary>
public sealed class SessionLogService
{
    private readonly IJSRuntime _js;
    private readonly List<HeartbeatEventDto> _log = [];
    private Guid _sessionId;

    public SessionLogService(IJSRuntime js) => _js = js;

    public sealed record DownloadLogResult(bool Success, string Message, string? FileName = null, int Bytes = 0);

    // ─── Public API ───────────────────────────────────────────────────────

    public IReadOnlyList<HeartbeatEventDto> All => _log;

    /// <summary>Called when a new session starts to set the IndexedDB store.</summary>
    public async Task OpenSessionAsync(Guid sessionId)
    {
        _sessionId = sessionId;
        _log.Clear();
        try
        {
            await _js.InvokeVoidAsync("indexedDbStore.openStore", sessionId.ToString());
        }
        catch { /* IndexedDB unavailable in some test runners — swallow */ }
    }

    /// <summary>Appends a heartbeat record to memory and IndexedDB.</summary>
    public async Task AppendAsync(HeartbeatEventDto evt)
    {
        _log.Add(evt);
        try
        {
            await _js.InvokeVoidAsync("indexedDbStore.appendHeartbeat", new
            {
                sessionId    = evt.SessionId.ToString(),
                turnNumber   = evt.TurnNumber,
                agentId      = evt.AgentId,
                team         = evt.Team,
                thoughtText  = evt.ThoughtText,
                actionTaken  = evt.ActionTaken,
                hpBefore     = evt.HpBefore,
                hpAfter      = evt.HpAfter,
                hungerBefore = evt.HungerBefore,
                hungerAfter  = evt.HungerAfter,
            });
        }
        catch { /* swallow JS interop errors */ }
    }

    /// <summary>Clears the IndexedDB store after a successful server persist.</summary>
    public async Task ClearAsync()
    {
        try
        {
            await _js.InvokeVoidAsync("indexedDbStore.clearStore", _sessionId.ToString());
        }
        catch { }
        _log.Clear();
    }

    /// <summary>
    /// Serialises all buffered entries to a plain-text log file and triggers
    /// a browser download via <c>URL.createObjectURL</c>.
    /// </summary>
    public async Task<DownloadLogResult> DownloadLogAsync()
    {
        string diagnosticsJson = "[]";
        string diagnosticsSummaryJson = "{}";
        try
        {
            diagnosticsJson = await _js.InvokeAsync<string>("inferenceWorkerBridge.getDiagnosticsJson");
            diagnosticsSummaryJson = await _js.InvokeAsync<string>("inferenceWorkerBridge.getDiagnosticsSummaryJson");
        }
        catch
        {
            diagnosticsJson = "[]";
            diagnosticsSummaryJson = "{}";
        }

        var hasDiagnostics = !string.Equals(diagnosticsJson, "[]", StringComparison.Ordinal);
        if (_log.Count == 0 && !hasDiagnostics)
            return new DownloadLogResult(false, "No session data to download.");

        var sb = new StringBuilder();
        sb.AppendLine($"PoSurvive Session Log - {_sessionId}");
        sb.AppendLine(new string('-', 60));
        foreach (var e in _log)
        {
            sb.AppendLine(
                $"[Turn {e.TurnNumber,3}] [{e.AgentId}] {e.ThoughtText}  ACTION: {e.ActionTaken}");
        }

        if (hasDiagnostics)
        {
            sb.AppendLine();
            sb.AppendLine("Inference Diagnostics Summary");
            sb.AppendLine(new string('-', 60));
            sb.AppendLine(diagnosticsSummaryJson);

            sb.AppendLine();
            sb.AppendLine("Inference Diagnostics");
            sb.AppendLine(new string('-', 60));
            sb.AppendLine(diagnosticsJson);
        }

        var content = sb.ToString();
        var fileName = $"posurvive-{_sessionId}.txt";
        var byteLength = Encoding.UTF8.GetByteCount(content);

        try
        {
            await _js.InvokeVoidAsync("downloadTextFile", fileName, content);
            return new DownloadLogResult(true, $"Downloaded {fileName} ({byteLength} bytes).", fileName, byteLength);
        }
        catch (Exception ex)
        {
            return new DownloadLogResult(false, $"Download failed: {ex.Message}", fileName, byteLength);
        }
    }
}
