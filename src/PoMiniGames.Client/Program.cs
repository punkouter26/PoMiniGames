using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using PoMiniGamesClient;
using PoMiniGamesClient.Services;
using Radzen;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });
builder.Services.AddScoped<ApiService>();
builder.Services.AddScoped<AuthStateService>();
builder.Services.AddScoped<PlayerNameService>();
builder.Services.AddScoped<ToastService>();
builder.Services.AddScoped<GameStatsService>();
builder.Services.AddScoped<PoClickHistoryService>();
builder.Services.AddRadzenComponents();

var host = builder.Build();

// Initialize LocalStorageService with the JS runtime so all localStorage operations work
LocalStorageService.SetJSRuntime(host.Services.GetRequiredService<IJSRuntime>());

await host.RunAsync();
