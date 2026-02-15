# ApiContract.md - API Specs + Error Handling Policy

## Simplified Version (AI-Friendly)

### Base URL
```
Production: https://pominigames.azure.com
Development: http://localhost:5000
```

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health/ping | Health check |
| GET | /api/{game}/players/{player}/stats | Get player stats |
| PUT | /api/{game}/players/{player}/stats | Save player stats |
| GET | /api/{game}/statistics/leaderboard | Get leaderboard |
| GET | /api/{game}/statistics/all | Get all stats |

### Error Responses
- 404: Player not found
- 500: Server error

---

## Detailed Version (Human Developers)

## 1. API Overview

**Base URL:** `http://localhost:5000` (Dev)  
**Protocol:** REST over HTTP  
**Authentication:** None (player identified by name)

## 2. Endpoints

### 2.1 Health Check

#### GET /api/health/ping

Check if API is running.

**Response:**
```json
{
  "pong": true
}
```

#### GET /api/health

Full health check including storage.

**Response:**
```json
{
  "status": "Healthy",
  "checks": [
    {
      "name": "AzureTableStorage",
      "status": "Healthy"
    }
  ]
}
```

### 2.2 Player Statistics

#### GET /api/{game}/players/{playerName}/stats

Retrieve stats for a player in a specific game.

**Path Parameters:**
| Name | Type | Description |
|------|------|-------------|
| game | string | Game identifier (tictactoe, connectfive) |
| playerName | string | Player's display name |

**Response (200 OK):**
```json
{
  "name": "Player1",
  "game": "tictactoe",
  "stats": {
    "playerId": "player1",
    "playerName": "Player1",
    "easy": {
      "wins": 10,
      "losses": 2,
      "draws": 1,
      "totalGames": 13,
      "winStreak": 5
    },
    "medium": {
      "wins": 5,
      "losses": 5,
      "draws": 0,
      "totalGames": 10,
      "winStreak": 0
    },
    "hard": {
      "wins": 1,
      "losses": 8,
      "draws": 1,
      "totalGames": 10,
      "winStreak": 0
    },
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-15T00:00:00Z"
  }
}
```

**Response (404 Not Found):**
```json
{
  "message": "Player 'Player1' not found in game 'tictactoe'"
}
```

#### PUT /api/{game}/players/{playerName}/stats

Save or update player statistics.

**Path Parameters:**
| Name | Type | Description |
|------|------|-------------|
| game | string | Game identifier |
| playerName | string | Player's display name |

**Request Body:**
```json
{
  "playerId": "player1",
  "playerName": "Player1",
  "easy": {
    "wins": 11,
    "losses": 2,
    "draws": 1,
    "totalGames": 14,
    "winStreak": 6
  },
  "medium": {
    "wins": 5,
    "losses": 5,
    "draws": 0,
    "totalGames": 10,
    "winStreak": 0
  },
  "hard": {
    "wins": 1,
    "losses": 8,
    "draws": 1,
    "totalGames": 10,
    "winStreak": 0
  }
}
```

**Response (204 No Content):** Success (empty body)

**Response (400 Bad Request):**
```json
{
  "error": "Invalid request body"
}
```

### 2.3 Leaderboard

#### GET /api/{game}/statistics/leaderboard?limit={limit}

Get top players sorted by win rate.

**Query Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| limit | int | 10 | Maximum number of results |

**Response (200 OK):**
```json
[
  {
    "name": "Player1",
    "game": "tictactoe",
    "stats": { ... }
  },
  {
    "name": "Player2",
    "game": "tictactoe",
    "stats": { ... }
  }
]
```

#### GET /api/{game}/statistics/all

Get all player statistics for a game.

**Response (200 OK):**
```json
[
  {
    "name": "Player1",
    "game": "tictactoe",
    "stats": { ... }
  }
]
```

## 3. Error Handling

### 3.1 HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 204 | Success (No Content) |
| 400 | Bad Request |
| 404 | Not Found |
| 500 | Internal Server Error |

### 3.2 Error Response Format

```json
{
  "error": "Error message",
  "details": "Additional details (optional)"
}
```

### 3.3 Client-Side Error Handling

The client uses a fire-and-forget pattern:
- Stats saves are attempted but failures are silently ignored
- UI continues immediately without waiting for server response
- LocalStorage provides fallback data

```typescript
// Client-side error handling
async savePlayerStats(game, playerName, stats) {
  try {
    const res = await fetch(url, options);
    return res.ok; // Returns false on error, but doesn't throw
  } catch {
    return false; // Network errors return false
  }
}
```

### 3.4 Retry Policy

| Scenario | Action |
|----------|--------|
| Network timeout | Retry once after 1s |
| 5xx errors | Retry once after 2s |
| 404 errors | Don't retry (player doesn't exist) |
| 400 errors | Don't retry (invalid request) |

### 3.5 Health Check Failures

When storage is unavailable:
1. Health endpoint returns unhealthy status
2. Client continues working with local storage
3. Stats are cached locally until API recovers

## 4. Rate Limiting

Currently not implemented. Future considerations:
- Throttle stats saves to prevent abuse
- Limit leaderboard queries

## 5. CORS Policy

### Allowed Origins (Development)
```
http://localhost:5000
http://localhost:5173
```

### Allowed Origins (Production)
Configured via `Cors:AllowedOrigins` in appsettings.

## 6. Data Validation

### Player Name Rules
- Minimum 1 character
- Maximum 50 characters
- No special characters (alphanumeric + spaces only)

### Stats Validation
- All numeric values must be >= 0
- WinStreak must be >= 0
- TotalGames = Wins + Losses + Draws (verified on save)

## 7. API Versioning

Current version: v1  
Endpoint prefix: `/api/`

Future versions will use: `/api/v2/`

## 8. Deprecation Policy

- Old endpoints will be marked with `Deprecation` header
- Minimum 6-month notice before removal
- Documentation will always reflect current version
