using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Components.WebAssembly.Http;

namespace PoMiniGamesClient.Services;

/// <summary>
/// §Cross-origin credentials: the Blazor WASM <see cref="HttpClient"/> defaults
/// to <c>credentials: 'omit'</c> on the underlying browser fetch, which means
/// cross-origin requests (e.g. the standalone Blazor client on
/// <c>http://localhost:5261</c> calling the API on
/// <c>http://localhost:5000</c>) drop the auth cookie set by
/// <c>/api/auth/dev-login</c> and every subsequent protected endpoint returns
/// 401 "Requires an authenticated user".
///
/// This handler sets the WASM-native
/// <see cref="WebAssemblyHttpRequestMessageExtensions.SetBrowserRequestCredentials"/>
/// option on every outgoing request, restoring the same-origin behaviour for
/// cookie auth without callers needing to remember to set it per-request.
/// </summary>
/// <remarks>
/// Used as a child handler that the framework inserts into the WASM
/// HttpClient pipeline via <c>IHttpMessageHandlerBuilderFilter</c> (see
/// <c>Program.cs</c>). It is intentionally not registered as a primary
/// handler — that would replace the browser fetch shim and break all
/// requests, because Blazor WASM ships its own <c>BrowserHttpMessageHandler</c>
/// implementation that must be the innermost handler in the chain.
/// </remarks>
public sealed class IncludeCredentialsHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        // Idempotent: SetBrowserRequestCredentials overwrites any prior value
        // stored under the same key, so calling it on every request is safe.
        request.SetBrowserRequestCredentials(BrowserRequestCredentials.Include);
        return base.SendAsync(request, cancellationToken);
    }
}