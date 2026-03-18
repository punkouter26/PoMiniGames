namespace PoMiniGames.IntegrationTests.Testcontainers;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class SqlServerCollectionDefinition : ICollectionFixture<SqlServerContainerFixture>
{
    public const string Name = "sqlserver-container";
}
