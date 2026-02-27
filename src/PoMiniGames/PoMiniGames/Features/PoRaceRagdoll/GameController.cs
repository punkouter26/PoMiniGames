using Microsoft.AspNetCore.Mvc;

namespace PoMiniGames.Features.PoRaceRagdoll;

[ApiController]
[Route("api/[controller]")]
public class GameController : ControllerBase
{
    private readonly IGameSessionService _gameSessionService;
    private readonly IRacerService _racerService;
    private readonly ILogger<GameController> _logger;

    public GameController(
        IGameSessionService gameSessionService,
        IRacerService racerService,
        ILogger<GameController> logger)
    {
        _gameSessionService = gameSessionService;
        _racerService = racerService;
        _logger = logger;
    }

    [HttpPost("session")]
    public IActionResult CreateSession()
    {
        var sessionId = _gameSessionService.CreateSession();
        var state = _gameSessionService.GetSession(sessionId);
        _logger.LogInformation("New PoRaceRagdoll session created: {SessionId}", sessionId);
        return Ok(new { sessionId, state });
    }

    [HttpGet("session/{sessionId}")]
    public IActionResult GetSession(string sessionId)
    {
        var state = _gameSessionService.GetSession(sessionId);
        if (state is null) return NotFound(new { error = "Session not found" });
        return Ok(state);
    }

    [HttpPost("session/{sessionId}/bet")]
    public IActionResult PlaceBet(string sessionId, [FromBody] PlaceBetRequest request)
    {
        if (request.RacerId < 0) return BadRequest(new { error = "Invalid racer ID" });

        _logger.LogInformation("Placing bet on racer {RacerId} in session {SessionId}", request.RacerId, sessionId);
        var state = _gameSessionService.PlaceBet(sessionId, request.RacerId);

        if (state is null) return NotFound(new { error = "Session not found" });
        if (state.SelectedRacerId is null)
            return BadRequest(new { error = "Failed to place bet. Ensure you have sufficient balance and a valid racer is selected." });

        return Ok(state);
    }

    [HttpPost("session/{sessionId}/finish")]
    public IActionResult FinishRace(string sessionId, [FromBody] FinishRaceRequest request)
    {
        _logger.LogInformation("Finishing race in session {SessionId}, winner {WinnerId}", sessionId, request.WinnerId);
        var (state, result) = _gameSessionService.FinishRace(sessionId, request.WinnerId);

        if (state is null) return NotFound(new { error = "Session not found" });
        return Ok(new { state, result });
    }

    [HttpPost("session/{sessionId}/next")]
    public IActionResult NextRound(string sessionId)
    {
        var state = _gameSessionService.NextRound(sessionId);
        if (state is null) return NotFound(new { error = "Session not found" });
        return Ok(state);
    }

    [HttpGet("species")]
    public IActionResult GetSpecies() => Ok(_racerService.GetAvailableSpecies());
}
