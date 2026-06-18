using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.JSInterop;
using PoMiniGamesClient;
using PoMiniGamesClient.Games.PoRacer;
using PoMiniGamesClient.Services;
using Radzen;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

// BUG FIX (#3, #7): BaseAddress now points to the API in Development so
// HttpClient calls hit the actual backend, not the SPA fallback. In any
// other environment (Production, Staging) we still use the host origin
// because the API is reverse-proxied under the same origin.
var apiBase = builder.Configuration["PoMiniGames:ApiBaseAddress"]
              ?? builder.Configuration["ApiBaseAddress"];
if (string.IsNullOrWhiteSpace(apiBase))
{
    apiBase = builder.HostEnvironment.IsDevelopment()
        ? "http://localhost:5000/"
        : builder.HostEnvironment.BaseAddress;
}
builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(apiBase)
});
builder.Services.AddScoped<ApiService>();
builder.Services.AddScoped<AuthStateService>();
builder.Services.AddScoped<PlayerNameService>();
builder.Services.AddScoped<ToastService>();
builder.Services.AddScoped<GameStatsService>();
builder.Services.AddScoped<GameResultService>();
builder.Services.AddScoped<PoClickHistoryService>();
builder.Services.AddScoped<PoRacerScoreApiClient>();
// Singleton — manages the shared "Watch All Demos" auto-rotation timer
// across the lifetime of the Blazor session. Fixes the timer-leak /
// hijack-navigation bug (QA finding #1 + #4).
builder.Services.AddSingleton<KioskCoordinator>();
builder.Services.AddRadzenComponents();

var host = builder.Build();

// Initialize LocalStorageService with the JS runtime so all localStorage operations work
LocalStorageService.SetJSRuntime(host.Services.GetRequiredService<IJSRuntime>());

await host.RunAsync();
