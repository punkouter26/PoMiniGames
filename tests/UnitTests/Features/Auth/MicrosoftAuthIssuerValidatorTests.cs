using FluentAssertions;
using Microsoft.IdentityModel.Tokens;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.UnitTests.Features.Auth;

/// <summary>
/// Tests the §2.2 tenant allow-list. The validator MUST accept the well-known public
/// Entra authorities and any explicitly-configured tenant ID, and reject everything else.
/// </summary>
/// <remarks>
/// <b>§1 100/50/25/25 Rule.</b> Originally 5 single-case <c>[Fact]</c>s + 1
/// <c>[Theory]</c>; consolidated to 2 <c>[Theory]</c>s + 1 <c>[Fact]</c>. The
/// rejection cases (unknown tenant, empty issuer, foreign authority) collapse
/// into one theory parameterized over (issuer, allowedTenants).
/// </remarks>
public class MicrosoftAuthIssuerValidatorTests
{
    [Theory]
    [InlineData("https://login.microsoftonline.com/common/v2.0",                "")]
    [InlineData("https://login.microsoftonline.com/organizations/v2.0",           "")]
    [InlineData("https://login.microsoftonline.com/consumers/v2.0",              "")]
    [InlineData("https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0", "")]
    [InlineData("https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0", "11111111-1111-1111-1111-111111111111")]
    public void Validate_AcceptsAllowedAuthorities(string issuer, string commaSeparatedAllowedTenants)
    {
        var allowed = string.IsNullOrEmpty(commaSeparatedAllowedTenants)
            ? Array.Empty<string>()
            : commaSeparatedAllowedTenants.Split(',', StringSplitOptions.RemoveEmptyEntries);

        var result = MicrosoftAuthIssuerValidator.Validate(issuer, allowed);
        result.Should().Be(issuer);
    }

    [Theory]
    [InlineData("https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0", "")]
    [InlineData("",                                                                            "")]
    [InlineData("https://evil.example.com/v2.0",                                               "")]
    [InlineData("https://login.microsoftonline.com/common/v2.0/extra",                        "11111111-1111-1111-1111-111111111111")]
    public void Validate_RejectsDisallowedIssuers(string issuer, string commaSeparatedAllowedTenants)
    {
        var allowed = string.IsNullOrEmpty(commaSeparatedAllowedTenants)
            ? Array.Empty<string>()
            : commaSeparatedAllowedTenants.Split(',', StringSplitOptions.RemoveEmptyEntries);

        var act = () => MicrosoftAuthIssuerValidator.Validate(issuer, allowed);
        act.Should().Throw<SecurityTokenInvalidIssuerException>();
    }

    [Fact]
    public void Validate_RejectsUnknownTenant_WithIssuerInMessage()
    {
        const string attackerIssuer = "https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0";

        var act = () => MicrosoftAuthIssuerValidator.Validate(attackerIssuer, Array.Empty<string>());

        act.Should().Throw<SecurityTokenInvalidIssuerException>()
           .WithMessage($"*{attackerIssuer}*");
    }
}