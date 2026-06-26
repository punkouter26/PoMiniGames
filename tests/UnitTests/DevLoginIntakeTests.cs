using System.Security.Claims;
using FluentAssertions;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.UnitTests;

/// <summary>
/// Exercises the dev-login intake rules directly — the sanitisation, ANON-suffixing, and claim
/// shape that previously lived inside an endpoint lambda and could only be reached over HTTP.
/// </summary>
public class DevLoginIntakeTests
{
    [Fact]
    public void BuildProfile_WithNoInput_UsesLocalDeveloperFallback()
    {
        var profile = DevLoginIntake.BuildProfile(request: null, userName: null);

        profile.DisplayName.Should().Be("Local Developer");
        profile.UserId.Should().Be("dev-local-developer");
        profile.Email.Should().Be("local-developer@local.dev");
    }

    [Fact]
    public void BuildProfile_WithAnon_AppendsSixDigitSuffix()
    {
        var profile = DevLoginIntake.BuildProfile(request: null, userName: "ANON");

        profile.DisplayName.Should().MatchRegex("^ANON[0-9]{6}$");
        profile.UserId.Should().StartWith("dev-anon");
    }

    [Fact]
    public void BuildProfile_StripsDisallowedCharactersFromDisplayName()
    {
        var profile = DevLoginIntake.BuildProfile(
            new DevLoginRequest(UserId: null, DisplayName: "Bob<script>", Email: null), userName: null);

        profile.DisplayName.Should().Be("Bobscript");
    }

    [Fact]
    public void BuildProfile_PrefersExplicitRequestFields()
    {
        var profile = DevLoginIntake.BuildProfile(
            new DevLoginRequest(UserId: "  custom-id ", DisplayName: "Alice", Email: " alice@x.io "),
            userName: null);

        profile.UserId.Should().Be("custom-id");
        profile.DisplayName.Should().Be("Alice");
        profile.Email.Should().Be("alice@x.io");
    }

    [Fact]
    public void BuildClaims_CarriesIdNameAndEmailUnderBothSchemes()
    {
        var profile = new AuthenticatedUserProfile("dev-alice", "Alice", "alice@local.dev");

        var claims = DevLoginIntake.BuildClaims(profile);

        claims.Should().Contain(c => c.Type == "oid" && c.Value == "dev-alice");
        claims.Should().Contain(c => c.Type == ClaimTypes.NameIdentifier && c.Value == "dev-alice");
        claims.Should().Contain(c => c.Type == "name" && c.Value == "Alice");
        claims.Should().Contain(c => c.Type == "preferred_username" && c.Value == "alice@local.dev");
        claims.Should().Contain(c => c.Type == ClaimTypes.Email && c.Value == "alice@local.dev");
    }
}
