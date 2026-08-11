using System.Security.Claims;
using FluentAssertions;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Unit;

/// <summary>
/// Exercises the dev-login intake rules directly — the sanitisation, ANON-suffixing, and claim
/// shape that previously lived inside an endpoint lambda and could only be reached over HTTP.
/// </summary>
public class DevLoginIntakeTests
{
    // The six-digit suffix below is not incidental: since 2026-08-10 EVERY dev
    // login gets one, so two tabs of the same browser produce distinct identities
    // instead of colliding on one name-keyed session (see DevLoginIntake). These
    // assertions therefore pin the stem and the shape of the suffix, never the
    // whole literal — the suffix is Random.Shared and differs per call.
    [Fact]
    public void BuildProfile_WithNoInput_UsesLocalDeveloperFallback()
    {
        var profile = DevLoginIntake.BuildProfile(request: null, userName: null);

        profile.DisplayName.Should().MatchRegex(@"^Local Developer-[0-9]{6}$");
        // UserId and Email are slugged from the suffixed display name, so they
        // carry the same suffix — that is what keeps the two tabs distinct all
        // the way down to the leaderboard row.
        profile.UserId.Should().MatchRegex(@"^dev-local-developer-[0-9]{6}$");
        profile.Email.Should().MatchRegex(@"^local-developer-[0-9]{6}@local\.dev$");
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

        // The angle brackets are stripped, not escaped — and nothing of the tag
        // survives between the stem and the suffix.
        profile.DisplayName.Should().MatchRegex(@"^Bobscript-[0-9]{6}$");
    }

    [Fact]
    public void BuildProfile_PrefersExplicitRequestFields()
    {
        var profile = DevLoginIntake.BuildProfile(
            new DevLoginRequest(UserId: "  custom-id ", DisplayName: "Alice", Email: " alice@x.io "),
            userName: null);

        // An explicit UserId/Email is taken verbatim (trimmed) and never suffixed —
        // the caller asked for that exact identity. Only the display name, which
        // the caller does not own the uniqueness of, picks up the suffix.
        profile.UserId.Should().Be("custom-id");
        profile.DisplayName.Should().MatchRegex(@"^Alice-[0-9]{6}$");
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
