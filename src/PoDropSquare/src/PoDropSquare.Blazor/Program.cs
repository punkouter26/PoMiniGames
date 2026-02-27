using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Radzen;
using PoDropSquare.Blazor;
using PoDropSquare.Blazor.Services;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

// Add Radzen components and services
builder.Services.AddRadzenComponents();

// Configure HttpClient for API access
// Priority:
// 1. Explicit ApiBaseUrl from configuration
// 2. Local dev fallback to API port 5000 when running standalone Blazor dev server
// 3. Same-origin base address when hosted by the API
var hostBaseAddress = new Uri(builder.HostEnvironment.BaseAddress);
var configuredApiBaseUrl = builder.Configuration["ApiBaseUrl"];

Uri apiBaseAddress;
if (Uri.TryCreate(configuredApiBaseUrl, UriKind.Absolute, out var configuredApiUri))
{
	apiBaseAddress = configuredApiUri;
}
else if (hostBaseAddress.IsLoopback && hostBaseAddress.Port is not 5000 and not 5001 and not 5010 and not 5011)
{
	apiBaseAddress = new Uri($"{hostBaseAddress.Scheme}://{hostBaseAddress.Host}:5010/");
}
else
{
	apiBaseAddress = hostBaseAddress;
}

builder.Services.AddScoped(_ => new HttpClient { BaseAddress = apiBaseAddress });

// Register services
builder.Services.AddScoped<PhysicsInteropService>();

// Configure logging - use browser console
builder.Logging.SetMinimumLevel(LogLevel.Information);

await builder.Build().RunAsync();
