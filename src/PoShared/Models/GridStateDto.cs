namespace PoShared.Simulation.Models;

public record GridStateDto(
    int                          TurnNumber,
    IReadOnlyList<AgentDto>      Agents,
    IReadOnlyList<FoodNodeDto>   FoodNodes,
    IReadOnlyList<GridCoordinateDto> Rocks
);
