using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace PoMiniGames.IntegrationTests;

/// <summary>
/// Custom <see cref="WebApplicationFactory{TEntryPoint}"/> that replaces
/// Azure Table Storage with in-memory fakes so integration tests
/// run without Azurite / network.
/// </summary>
public class TestWebApplicationFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureServices(services =>
        {
            // Remove real Table Storage registrations and add a fake
            var tableDescriptor = services.FirstOrDefault(
                d => d.ServiceType == typeof(Azure.Data.Tables.TableServiceClient));
            if (tableDescriptor is not null)
            {
                services.Remove(tableDescriptor);
            }

            // Use Azurite connection string for integration tests
            services.AddSingleton(new Azure.Data.Tables.TableServiceClient(
                "UseDevelopmentStorage=true"));
        });
    }
}
