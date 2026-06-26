using Azure.Security.KeyVault.Secrets;
using FluentAssertions;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.UnitTests;

/// <summary>Unit tests for <see cref="PrefixKeyVaultSecretManager"/>.</summary>
public sealed class PrefixKeyVaultSecretManagerTests
{
    private readonly PrefixKeyVaultSecretManager _sut = new("PoMiniGames");

    // ─── Load ────────────────────────────────────────────────────────────

    [Fact]
    public void Load_ReturnsTrue_WhenSecretNameStartsWithPrefix()
    {
        var props = new SecretProperties("PoMiniGames--ConnectionStrings--Default");
        _sut.Load(props).Should().BeTrue();
    }

    [Fact]
    public void Load_ReturnsFalse_WhenSecretNameHasDifferentPrefix()
    {
        var props = new SecretProperties("OtherApp--ConnectionStrings--Default");
        _sut.Load(props).Should().BeFalse();
    }

    [Fact]
    public void Load_IsCaseInsensitive()
    {
        var props = new SecretProperties("pominiGAMES--SomeKey");
        _sut.Load(props).Should().BeTrue();
    }

    [Fact]
    public void Load_ReturnsFalse_WhenSecretNameIsEmpty()
    {
        var props = new SecretProperties("NoPrefix");
        _sut.Load(props).Should().BeFalse();
    }

    // ─── GetKey ──────────────────────────────────────────────────────────

    [Fact]
    public void GetKey_ReplacesDoubleDashWithColon()
    {
        var secret = new KeyVaultSecret("PoMiniGames--ConnectionStrings--Default", "value");
        var key = _sut.GetKey(secret);
        key.Should().Be($"PoMiniGames{ConfigurationPath.KeyDelimiter}ConnectionStrings{ConfigurationPath.KeyDelimiter}Default");
    }

    [Fact]
    public void GetKey_SingleSegment_ReturnsPrefixAndKey()
    {
        var secret = new KeyVaultSecret("PoMiniGames--ApiKey", "value");
        var key = _sut.GetKey(secret);
        key.Should().Be($"PoMiniGames{ConfigurationPath.KeyDelimiter}ApiKey");
    }

    [Fact]
    public void GetKey_PreservesPrefix_InConfigurationKey()
    {
        var secret = new KeyVaultSecret("PoMiniGames--ApplicationInsights--ConnectionString", "value");
        var key = _sut.GetKey(secret);
        key.Should().StartWith("PoMiniGames:");
    }
}
