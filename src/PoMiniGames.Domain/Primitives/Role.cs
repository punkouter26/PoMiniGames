namespace PoMiniGames.Domain.Primitives;

/// <summary>
/// Strongly-typed auth scheme identifier. Replaces the raw-string conventions
/// (<c>"FakeAuth"</c>, <c>"DevCookie"</c>, <c>"Composite"</c>) used throughout
/// the auth pipeline.
/// </summary>
/// <remarks>
/// Pattern: Closed Enum + String conversion. The wire-form string is preserved
/// for compatibility with ASP.NET Core's scheme-name registry; the C# layer uses
/// the value type so a typo is a compile error, not a silent scheme miss.
/// </remarks>
public readonly record struct Role(string Value)
{
    public string Value { get; } = Value ?? string.Empty;

    public bool IsEmpty => string.IsNullOrEmpty(Value);

    public override string ToString() => Value;

    public static readonly Role FakeAuth  = new("FakeAuth");
    public static readonly Role DevCookie = new("DevCookie");
    public static readonly Role Composite = new("Composite");
    public static readonly Role JwtBearer = new("Bearer");
    public static readonly Role Bff       = new("BFF");

    public static readonly Role Admin = new("admin");
    public static readonly Role User  = new("user");

    public static Role Parse(string? raw) => string.IsNullOrWhiteSpace(raw) ? default : new(raw.Trim());

    public bool Equals(Role other) => string.Equals(Value, other.Value, StringComparison.Ordinal);
    public override int GetHashCode() => Value.GetHashCode(StringComparison.Ordinal);
}