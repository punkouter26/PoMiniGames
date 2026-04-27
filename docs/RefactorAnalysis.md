# PoMiniGames - Refactor Analysis with Blast Radius Assessment

> Based on ServiceMap_MASTER.mmd — Source of Truth for Dependency Impact

---

## Executive Summary

This document provides blast radius assessments for potential refactoring scenarios in the PoMiniGames platform. Each assessment details the impact on downstream dependencies, enabling informed decision-making before architectural changes.

---

## Service Dependency Map

```
Client Layer (Browser)
├── Blazor WASM → ApiService, MSAL Client, SignalR Client, localStorage
├── API Service → MinimalAPI, localStorage (offline fallback)
├── MSAL Client → Microsoft Identity (external)
└── SignalR Client → LobbyHub, MultiplayerHub

API Layer (.NET 10)
├── MinimalAPI → Auth, Leaderboard, HighScore, Multiplayer, Lobby, Health
├── Auth Feature → MSID (external)
├── Leaderboard Feature → StorageService
├── HighScore Feature → StorageService
├── Multiplayer Feature → MultiplayerService
├── Lobby Feature → LobbyService
├── Health Feature → (standalone)
├── LobbyHub → LobbyService, SignalR
└── MultiplayerHub → MultiplayerService, SignalR

Application Services
├── StorageService → SQLite DB
├── MultiplayerService → SQLite DB, In-memory state
└── LobbyService → In-memory state

External Dependencies
├── SQLite DB (shared disk)
├── Key Vault (kv-poshared)
├── Application Insights
└── Microsoft Identity
```

---

## Blast Radius Assessments

### REF-001: StorageService Refactoring

**Change Description:** Migrate from SQLite ADO.NET to Entity Framework Core with PostgreSQL

**Affected Components:**
| Component | Impact Level | Reason |
|-----------|--------------|--------|
| StorageService | HIGH | Core implementation change — requires new abstraction layer |
| LeaderFeature | HIGH | Direct dependency on storage queries |
| HSFeature | HIGH | Direct dependency on high score inserts |
| MultiplayerService | MEDIUM | Currently writes match state to SQLite |
| DbInitializer | HIGH | Schema migration scripts would change |
| All endpoints writing stats | HIGH | UPSERT logic would change |

**Downstream Dependencies:**
- PlayerStats persistence (all games)
- SnakeHighScores persistence
- PoDropSquareHighScores persistence
- MultiplayerMatch state (optional migration target)

**Testing Requirements:**
- Unit tests for EloCalculator (no dependency, isolated)
- Integration tests for all UPSERT paths
- E2E tests for leaderboard queries
- Performance benchmarking on new query patterns

**Risk Level:** HIGH
**Rollback Complexity:** MEDIUM (requires DB migration rollback)

**Mitigation Strategy:**
1. Implement IStorageService interface abstraction first
2. Run both implementations in parallel during transition
3. Maintain SQLite as fallback for 30 days post-migration
4. Extensive integration test suite before cutover

---

### REF-002: SignalR Hub Migration

**Change Description:** Consolidate LobbyHub and MultiplayerHub into single GameHub

**Affected Components:**
| Component | Impact Level | Reason |
|-----------|--------------|--------|
| LobbyHub | HIGH | Removed — logic must transfer |
| MultiplayerHub | HIGH | Removed — logic must transfer |
| LobbyService | HIGH | Hub method handlers change |
| MultiplayerService | HIGH | Hub method handlers change |
| SignalR Client | CRITICAL | Connection pattern changes |
| Client Services | HIGH | API calls to /hubs/* change |
| Game Modules (TicTacToe, ConnectFive, Snake) | HIGH | Real-time move sync affected |

**Downstream Dependencies:**
- All multiplayer game flows
- Matchmaking queue
- Lobby formation
- Real-time input broadcast
- Spectator mode

**Testing Requirements:**
- E2E tests for complete multiplayer flow (queue → lobby → game → stats)
- Load testing for concurrent connections
- WebSocket handshake validation

**Risk Level:** CRITICAL
**Rollback Complexity:** HIGH (client and server must be deployed together)

**Mitigation Strategy:**
1. Maintain backward compatibility with versioned hub routes
2. Gradual client migration with feature flag
3. Comprehensive E2E test suite
4. Staged rollout with monitoring

---

### REF-003: Authentication Provider Change

**Change Description:** Switch from Microsoft Identity to Auth0 or similar third-party provider

**Affected Components:**
| Component | Impact Level | Reason |
|-----------|--------------|--------|
| AuthFeature | CRITICAL | JWT validation logic changes |
| MSAL Client | CRITICAL | Must be replaced with new SDK |
| AuthStateService | CRITICAL | State machine changes |
| Key Vault | HIGH | Secret names change |
| Client routing | HIGH | Callback URLs change |
| All authenticated endpoints | HIGH | Token validation changes |

**Downstream Dependencies:**
- All Bearer JWT endpoints
- Token refresh flows
- User profile retrieval
- Dev bypass in development mode

**Testing Requirements:**
- OAuth flow E2E tests
- Token refresh tests
- Popup blocking fallback tests
- Dev bypass functionality (if supported by new provider)

**Risk Level:** CRITICAL
**Rollback Complexity:** HIGH (authentication affects entire user base)

**Mitigation Strategy:**
1. Dual-provider authentication during transition
2. User migration script for existing accounts
3. Extensive testing across all auth flows
4. Gradual user migration with communication

---

### REF-004: Client State Management Migration

**Change Description:** Replace Blazor component local state with Redux pattern

**Affected Components:**
| Component | Impact Level | Reason |
|-----------|--------------|--------|
| All Pages (6 routes) | MEDIUM | State access patterns change |
| GameShell Component | HIGH | Wraps state for all games |
| Game Modules (TicTacToe, ConnectFive, Snake, PoRunner) | MEDIUM | State subscription changes |
| ApiService | MEDIUM | How results are dispatched changes |
| AuthStateService | MEDIUM | How auth state is managed changes |
| GameStatsService | MEDIUM | How stats are aggregated changes |
| localStorage | LOW | Read/write patterns may change |

**Downstream Dependencies:**
- UI rendering consistency
- Offline state persistence
- Stats synchronization

**Testing Requirements:**
- Component rendering tests
- State hydration tests
- Offline resume tests

**Risk Level:** MEDIUM
**Rollback Complexity:** LOW (component-level change)

**Mitigation Strategy:**
1. Implement new state layer alongside existing
2. Feature flag to switch between patterns
3. Visual regression testing
4. Incremental migration by page

---

### REF-005: Minimal API to Controller Migration

**Change Description:** Convert Minimal API endpoints to MVC Controllers

**Affected Components:**
| Component | Impact Level | Reason |
|-----------|--------------|--------|
| All Endpoint Groups | HIGH | Route registration changes |
| ApiService (client) | LOW | Routes remain same |
| Middleware Pipeline | MEDIUM | Filter registration changes |
| OpenAPI Metadata | MEDIUM | How docs are generated changes |

**Downstream Dependencies:**
- API routing
- Authorization policies
- Response serialization

**Testing Requirements:**
- API contract tests
- HTTP verb validation
- Response format tests

**Risk Level:** MEDIUM
**Rollback Complexity:** LOW (routes remain compatible)

**Mitigation Strategy:**
1. Incremental migration by feature group
2. Maintain route compatibility
3. Parallel running during transition

---

### REF-006: Add Redis for Session State

**Change Description:** Introduce Redis for in-memory state (LobbyService, MultiplayerService)

**Affected Components:**
| Component | Impact Level | Reason |
|-----------|--------------|--------|
| LobbyService | HIGH | In-memory → Redis |
| MultiplayerService | HIGH | In-memory → Redis |
| Redis Connection | HIGH | New external dependency |
| Health Checks | MEDIUM | Must check Redis connectivity |
| Deployment Config | HIGH | App Service must have Redis binding |

**Downstream Dependencies:**
- Lobby persistence across server restarts
- Match state recovery after disconnections
- Horizontal scaling support

**Testing Requirements:**
- Connection failure tests
- Timeout handling tests
- Redis health check integration tests

**Risk Level:** MEDIUM
**Rollback Complexity:** MEDIUM (requires infrastructure rollback)

**Mitigation Strategy:**
1. Hybrid approach: Redis primary, in-memory fallback
2. Connection string in Key Vault
3. Health check that degrades gracefully

---

### REF-007: EloCalculator Algorithm Change

**Change Description:** Modify ELO rating computation (e.g., add time-based decay)

**Affected Components:**
| Component | Impact Level | Reason |
|-----------|--------------|--------|
| EloCalculator | CRITICAL | Core algorithm change |
| StorageService | MEDIUM | When Calculate is called |
| Unit Tests | HIGH | Test fixtures must update |
| Leaderboard Queries | LOW | Results format unchanged |

**Downstream Dependencies:**
- Player rating display
- Leaderboard ranking
- Match history (backfill consideration)

**Testing Requirements:**
- Unit tests for all rating scenarios
- Backfill validation (deterministic verification)
- Comparison against expected ratings

**Risk Level:** MEDIUM
**Rollback Complexity:** LOW (can recompute from W/L/D)

**Mitigation Strategy:**
1. Maintain deterministic computation (always recomputable)
2. Version the algorithm with feature flag
3. Test against known rating progressions
4. Document change in ADR

---

## Service Dependency Matrix

| Service | Depends On | Used By | Change Risk |
|---------|------------|---------|-------------|
| Blazor WASM | ApiService, SignalR, MSAL | — | LOW |
| ApiService | MinimalAPI, localStorage | Blazor, Game Modules | MEDIUM |
| MSAL Client | MSID | AuthStateService | CRITICAL |
| MinimalAPI | All features | ApiService | HIGH |
| AuthFeature | MSID, StorageService | MinimalAPI | CRITICAL |
| LeaderFeature | StorageService | MinimalAPI | HIGH |
| HSFeature | StorageService | MinimalAPI | HIGH |
| MPFeature | MultiplayerService | MinimalAPI | HIGH |
| LobbyFeature | LobbyService | MinimalAPI | HIGH |
| LobbyHub | LobbyService, SignalR | SignalR Client | CRITICAL |
| MPHub | MultiplayerService, SignalR | SignalR Client | CRITICAL |
| StorageService | SQLite | Auth, Leader, HS, MP | HIGH |
| MultiplayerService | SQLite, In-memory | MPFeature, MPHub | HIGH |
| LobbyService | In-memory | LobbyFeature, LobbyHub | HIGH |
| SQLite | App Service Disk | StorageService, MultiplayerService | HIGH |
| Key Vault | Azure | API startup, Secrets | CRITICAL |
| App Insights | OTLP | API startup, All operations | LOW |
| MSID | — | Auth, MSAL Client | CRITICAL |

---

## Recommended Refactoring Priority

| Priority | Refactor | Reason |
|----------|----------|--------|
| 1 | REF-007 EloCalculator | Low risk, self-contained, easy rollback |
| 2 | REF-005 API Migration | Incremental, routes compatible |
| 3 | REF-004 State Management | Feature flaggable, component-level |
| 4 | REF-006 Redis Addition | Hybrid approach available |
| 5 | REF-001 Storage Migration | High complexity, requires full testing |
| 6 | REF-002 Hub Consolidation | Client+server, critical blast radius |
| 7 | REF-003 Auth Provider | User-facing, critical blast radius |

---

## Change Approval Checklist

Before any refactoring:

- [ ] Blast radius assessment completed
- [ ] Affected services documented
- [ ] Rollback strategy defined
- [ ] Test coverage verified (unit, integration, E2E)
- [ ] Monitoring/alerting plan in place
- [ ] Staged rollout approach defined
- [ ] Feature flag or version strategy identified
- [ ] Stakeholder sign-off obtained

---

*Generated from ServiceMap_MASTER.mmd — 2026-04-27*