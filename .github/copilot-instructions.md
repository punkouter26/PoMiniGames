# PoMiniGames — GitHub Copilot Instructions

## Project Overview

PoMiniGames is an instant-play mini-games platform built with .NET 10 Minimal API (Onion architecture) and a Blazor WebAssembly client. It supports 8 games with AI opponents, real-time 2-player multiplayer via SignalR, and global leaderboards.

## Architecture

The server uses an Onion/Clean Architecture split across four projects:

| Project | Purpose |
|---|---|
| `src/PoMiniGames.Domain` | Domain models, EloCalculator |
| `src/PoMiniGames.Application` | DTOs, contracts, diagnostics interfaces |
| `src/PoMiniGames.Infrastructure` | SQLite storage, health checks |
| `src/PoMiniGames/PoMiniGames` | Host composition, middleware, endpoints |
| `src/PoMiniGames.Client` | Blazor WebAssembly frontend |
| `src/PoShared` | Shared Key Vault + App Insights helpers |

## Tech Stack

- **Backend**: .NET 10 Minimal API, SQLite, Serilog, OpenTelemetry, SignalR
- **Frontend**: Blazor WebAssembly
- **Auth**: Microsoft MSAL (OAuth2 JWT Bearer) + DevCookie bypass for local dev
- **Testing**: xUnit, Testcontainers (Azurite), Playwright (E2E)
- **IaC**: Azure Bicep + `azd`

## Build & Test Commands

```bash
# Build
dotnet build src/PoMiniGames/PoMiniGames/PoMiniGames.csproj

# Unit tests
dotnet test tests/PoMiniGames.UnitTests/PoMiniGames.UnitTests.csproj -v minimal

# Integration tests
dotnet test tests/PoMiniGames.IntegrationTests/PoMiniGames.IntegrationTests.csproj -v minimal
```

## Coding Conventions

- New endpoints go in `src/PoMiniGames/PoMiniGames/` using Minimal API style
- Domain logic stays in `PoMiniGames.Domain`; no infrastructure references there
- DTOs and service contracts live in `PoMiniGames.Application`
- Infrastructure (SQLite, health checks) lives in `PoMiniGames.Infrastructure`
- Follow existing OpenAPI documentation patterns using `WithName`, `WithSummary`, `WithDescription`
- Use `TypedResults` for strongly-typed Minimal API responses

## Available Workspace Skills

This project includes skills from [github/awesome-copilot](https://github.com/github/awesome-copilot). Load a skill's `SKILL.md` file when working on the corresponding task:

| Skill | Path | Use when... |
|---|---|---|
| **architecture-blueprint-generator** | `skills/architecture-blueprint-generator/SKILL.md` | Generating architectural documentation or diagrams |
| **acquire-codebase-knowledge** | `skills/acquire-codebase-knowledge/SKILL.md` | Mapping or documenting the codebase structure |
| **aspnet-minimal-api-openapi** | `skills/aspnet-minimal-api-openapi/SKILL.md` | Creating ASP.NET Minimal API endpoints with OpenAPI docs |
| **add-educational-comments** | `skills/add-educational-comments/SKILL.md` | Adding instructional comments to source files |

## Instructions Reference

Custom instruction authoring guidelines: `instructions/instructions.instructions.md`

## Cookbook

Practical recipes for GitHub Copilot SDK usage: `cookbook/`  
Java recipes (PR Visualization, Accessibility Reports): `cookbook/copilot-sdk/java/`
