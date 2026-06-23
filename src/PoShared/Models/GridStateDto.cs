namespace PoSurvive.Shared.Models;

public record GridStateDto(
    int                          TurnNumber,
    IReadOnlyList<AgentDto>      Agents,
    IReadOnlyList<FoodNodeDto>   FoodNodes,
    IReadOnlyList<GridCoordinateDto> Rocks
);
