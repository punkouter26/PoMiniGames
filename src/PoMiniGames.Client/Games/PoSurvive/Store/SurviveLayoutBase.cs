namespace PoMiniGamesClient.Games.PoSurvive.Store;

using Microsoft.AspNetCore.Components;

/// <summary>
/// Layout counterpart to <see cref="SurviveComponentBase"/>.
/// Replaces Fluxor.Blazor.Web.Components.FluxorLayout.
/// </summary>
public abstract class SurviveLayoutBase : LayoutComponentBase, IDisposable
{
    [Inject] protected SurviveStore Store { get; set; } = default!;

    private Action? _onChanged;

    protected override void OnInitialized()
    {
        base.OnInitialized();
        _onChanged = () => InvokeAsync(StateHasChanged);
        Store.Changed += _onChanged;
    }

    public virtual void Dispose()
    {
        if (_onChanged is not null)
            Store.Changed -= _onChanged;
        GC.SuppressFinalize(this);
    }
}
