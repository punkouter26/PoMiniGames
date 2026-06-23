using System.IdentityModel.Tokens.Jwt;
using FluentAssertions;
using Microsoft.IdentityModel.Tokens;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.UnitTests.Features.Auth;

/// <summary>
/// Tests the §2.2 tenant allow-list. The validator MUST accept the well-known public
/// Entra authorities and any explicitly-configured tenant ID, and reject everything else.
/// </summary>
public class MicrosoftAuthIssuerValidatorTests
{
    [Theory]
    [InlineData("https://login.microsoftonline.com/common/v2.0")]
    [InlineData("https://login.microsoftonline.com/organizations/v2.0")]
    [InlineData("https://login.microsoftonline.com/consumers/v2.0")]
    [InlineData("https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0")]
    public void Validate_AcceptsPublicAuthorities(string issuer)
    {
        var result = MicrosoftAuthIssuerValidator.Validate(issuer, Array.Empty<string>());

        result.Should().Be(issuer);
    }

    [Fact]
    public void Validate_AcceptsExplicitlyAllowedTenant()
    {
        const string tenantId = "11111111-1111-1111-1111-111111111111";
        const string issuer = $"https://login.microsoftonline.com/{tenantId}/v2.0";

        var result = MicrosoftAuthIssuerValidator.Validate(issuer, new[] { tenantId });

        result.Should().Be(issuer);
    }

    [Fact]
    public void Validate_RejectsUnknownTenant()
    {
        const string attackerIssuer = "https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0";

        var act = () => MicrosoftAuthIssuerValidator.Validate(attackerIssuer, Array.Empty<string>());

        act.Should().Throw<SecurityTokenInvalidIssuerException>()
           .WithMessage($"*{attackerIssuer}*");
    }

    [Fact]
    public void Validate_RejectsEmptyIssuer()
    {
        var act = () => MicrosoftAuthIssuerValidator.Validate(string.Empty, Array.Empty<string>());

        act.Should().Throw<SecurityTokenInvalidIssuerException>();
    }

    [Fact]
    public void Validate_RejectsForeignAuthority()
    {
        const string attacker = "https://evil.example.com/v2.0";

        var act = () => MicrosoftAuthIssuerValidator.Validate(attacker, Array.Empty<string>());

        act.Should().Throw<SecurityTokenInvalidIssuerException>();
    }
}
