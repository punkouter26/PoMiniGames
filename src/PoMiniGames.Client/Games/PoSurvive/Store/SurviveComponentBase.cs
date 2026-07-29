namespace PoMiniGamesClient.Games.PoSurvive.Store;

using Microsoft.AspNetCore.Components;

/// <summary>
/// Base for PoSurvive components that read <see cref="SurviveStore"/>. Re-renders on every
/// state transition, marshalling onto the renderer's sync context because heartbeats
/// transition state from the orchestrator's timer thread.
///
/// Replaces Fluxor.Blazor.Web.Components.FluxorComponent.
/// </summary>
public abstract class SurviveComponentBase : ComponentBase, IDisposable
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
