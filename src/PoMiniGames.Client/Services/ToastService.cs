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

    public void Dismiss(int id)
    {
        _toasts.RemoveAll(t => t.Id == id);
        StateChanged?.Invoke();
    }

    private async Task RemoveAfterDelay(int id, int delayMs)
    {
        await Task.Delay(delayMs);
        _toasts.RemoveAll(t => t.Id == id);
        StateChanged?.Invoke();
    }
}
