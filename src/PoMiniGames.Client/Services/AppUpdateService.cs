using Microsoft.JSInterop;

namespace PoMiniGamesClient.Services;

/// <summary>
/// Registers the service worker and surfaces "a new build is waiting" to the player.
/// </summary>
/// <remarks>
/// A cache-first service worker will otherwise serve the same build indefinitely: the
/// new one downloads, parks in <c>waiting</c>, and never takes over while a tab stays
/// open. Without this prompt, shipping a fix would not reach anyone who keeps the app
/// open — the usual failure mode of offline-first apps.
/// </remarks>
public sealed class AppUpdateService : IAsyncDisposable
{
    private readonly IJSRuntime _js;
    private readonly ToastService _toast;
    private DotNetObjectReference<AppUpdateService>? _selfRef;
    private bool _initialized;

    public AppUpdateService(IJSRuntime js, ToastService toast)
    {
        _js = js;
        _toast = toast;
    }

    /// <summary>True once a newer worker is installed and waiting to activate.</summary>
    public bool UpdateAvailable { get; private set; }

    public event Action? StateChanged;

    /// <summary>Idempotent — see <see cref="OnlineStatusService.InitializeAsync"/>.</summary>
    public async Task InitializeAsync()
    {
        if (_initialized) return;
        _initialized = true;
        try
        {
            _selfRef = DotNetObjectReference.Create(this);
            await _js.InvokeVoidAsync("poPwa.setUpdateListener", _selfRef);
            await _js.InvokeAsync<bool>("poPwa.register");
        }
        catch
        {
            // No service worker support, or registration blocked. Offline support is
            // an enhancement — the app is fully functional without it, so this must
            // never surface as an error to the player.
        }
    }

    [JSInvokable]
    public void OnUpdateAvailable()
    {
        if (UpdateAvailable) return;
        UpdateAvailable = true;
        StateChanged?.Invoke();
        // Deliberately an action, not "press F5": a waiting worker keeps waiting
        // through an ordinary reload (it only activates once every tab controlled by
        // the old worker is gone), so telling the player to reload would be telling
        // them to do something that does not work.
        _toast.ShowAction("A new version is ready.", "Update now", ApplyUpdateAsync, ToastType.Info);
    }

    /// <summary>Activate the waiting worker and reload onto the new build.</summary>
    public async Task ApplyUpdateAsync()
    {
        try
        {
            await _js.InvokeVoidAsync("poPwa.applyUpdate");
        }
        catch
        {
            // If the interop is gone the page is being torn down anyway.
        }
    }

    public ValueTask DisposeAsync()
    {
        _selfRef?.Dispose();
        _selfRef = null;
        return ValueTask.CompletedTask;
    }
}
