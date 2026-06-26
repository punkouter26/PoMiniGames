using System.Net.Http.Headers;
using Azure.Core;
using Azure.Identity;

namespace PoMiniGames.AI;

/// <summary>
/// Delegating handler that attaches an AAD bearer token acquired via
/// <see cref="DefaultAzureCredential"/> to every outbound request to the
/// Azure AI Foundry hub. Used by <see cref="PoMiniGames.Features.PoFace.AzureAIFaceAnalysisService"/>.
///
/// <para>
/// Mirrors the AAD-auth pattern used by the Azure SDK clients
/// (<see cref="AzureOpenAIClient"/> with <c>DefaultAzureCredential</c>) so a single
/// deployment posture (<c>disableLocalAuth: true</c>) covers every AI call.
/// </para>
/// </summary>
/// <remarks>
/// The token is acquired once at handler construction and cached; the handler is
/// registered as a singleton so the <see cref="DefaultAzureCredential"/> chain is
/// resolved only at first request. Refresh is handled by
/// <see cref="AccessToken.RefreshOn"/>; for long-lived processes an explicit refresh
/// policy can be added without changing call sites.
/// </remarks>
public sealed class AIFoundryBearerTokenHandler : DelegatingHandler
{
    private const string CognitiveServicesScope = "https://cognitiveservices.azure.com/.default";

    private readonly TokenCredential _credential = new DefaultAzureCredential();
    private AccessToken _cachedToken;

    public AIFoundryBearerTokenHandler()
    {
        InnerHandler = new HttpClientHandler();
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(_cachedToken.Token)
            || (_cachedToken.ExpiresOn - DateTimeOffset.UtcNow) < TimeSpan.FromMinutes(5))
        {
            _cachedToken = await _credential.GetTokenAsync(
                new TokenRequestContext(new[] { CognitiveServicesScope }),
                cancellationToken);
        }

        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _cachedToken.Token);
        return await base.SendAsync(request, cancellationToken);
    }
}