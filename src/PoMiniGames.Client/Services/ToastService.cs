namespace PoMiniGamesClient.Services;

public enum ToastType
{
    Info,
    Error,
    Success,
    Warning
}

public class ToastItem
{
    public int Id { get; init; }
    public string Message { get; init; } = "";
    public ToastType Type { get; init; }
    /// <summary>Label for an optional action button; null renders a plain toast.</summary>
    public string? ActionLabel { get; init; }
    /// <summary>Invoked when the action button is pressed.</summary>
    public Func<Task>? Action { get; init; }
}

public class ToastService
{
    private readonly List<ToastItem> _toasts = [];
    private int _nextId;

    public IReadOnlyList<ToastItem> Toasts => _toasts;

    public event Action? StateChanged;

    public void Show(string message, ToastType type = ToastType.Info)
    {
        var id = ++_nextId;
        var toast = new ToastItem { Id = id, Message = message, Type = type };
        _toasts.Add(toast);
        StateChanged?.Invoke();

        _ = RemoveAfterDelay(id, 5000);
    }

    /// <summary>
    /// A toast the user must act on or dismiss — it never auto-expires.
    /// </summary>
    /// <remarks>
    /// Used for the service-worker update prompt, where the action is not optional
    /// decoration: a waiting worker does not activate on an ordinary reload, so
    /// without pressing this the player stays on the old build indefinitely. A
    /// 5-second auto-dismiss would routinely expire before it was read.
    /// </remarks>
    public void ShowAction(string message, string actionLabel, Func<Task> action, ToastType type = ToastType.Info)
    {
        var toast = new ToastItem
        {
            Id = ++_nextId,
            Message = message,
            Type = type,
            ActionLabel = actionLabel,
            Action = action,
        };
        _toasts.Add(toast);
        StateChanged?.Invoke();
    }

    public void Dismiss(int id)
    {
        _toasts.RemoveAll(t => t.Id == id);
        StateChanged?.Invoke();
    }

    /// <summary>
    /// Dismiss every active toast. Used by the kiosk reel's entry point so a
    /// persistent toast (the PWA "Update now" prompt, an error toast from the
    /// previous page) does not survive into the attract loop and compete for
    /// taps with the reel's Skip/Exit controls.
    /// </summary>
    public void DismissAll()
    {
        if (_toasts.Count == 0) return;
        _toasts.Clear();
        StateChanged?.Invoke();
    }

    private async Task RemoveAfterDelay(int id, int delayMs)
    {
        await Task.Delay(delayMs);
        _toasts.RemoveAll(t => t.Id == id);
        StateChanged?.Invoke();
    }
}
