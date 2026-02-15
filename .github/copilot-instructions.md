General Engineering Principles + .NET API
Unified Identity: Use Po{SolutionName} as the master prefix for all namespaces, Azure Resource Groups, and Aspire resources (e.g., PoTask1.API, rg-PoTask1-prod).
Global Cleanup: Maintain a "zero-waste" codebase by deleting unused files, dead code, and obsolete assets.
Safety Standards: Use Directory.Build.props at the root to enforce <TreatWarningsAsErrors>true</TreatWarningsAsErrors> and <Nullable>enable</Nullable>.
Health Checks: Implement a /health endpoint to verify connections to all APIs and databases.
Context Management: Use .copilotignore to exclude bin/, obj/, and node_modules/ from AI focus.
Telemetry: Enable OpenTelemetry globally; aggregate to Application Insights in PoShared.
Tooling & Packages: Use Context7 MCP for latest SDKs and Central Package Management (CPM) via Directory.Packages.props with transitive pinning.
API UI: Use OpenApi 
Secrets & Config:
Local: Use dotnet user-secrets; backup in PoShared Key Vault.
Cloud: Use Azure Key Vault via Managed Identity within subscription Punkouter26 (Bbb8dfbe-9169-432f-9b7a-fbf861b51037).
Shared Resources: Locate common services and secrets in the PoShared resource group.
Development:
Create .http files for API debugging.
Implement robust server/browser logging for function calls.
Apply GoF/SOLID patterns + explanatory comments when possible
Ports: Use 5000 (HTTP) and 5001 (HTTPS).
For any major feature created , create corresponding UNIT/INTEGRATION/E2E tests
All apps should have /diag page that exposes all connection string, keys, values, secrets in json format / hide middle of values for security
In Plan Mode, if there is any ambiguity or need for further input, you must use the #tool:vscode/askQuestions tool to stop and consult me before proceeding with implementation.
Testing Strategy
Unit (C#): Pure logic and domain rules.
Integration (C#): API/DB testing using Testcontainers (SQL/Redis).
E2E (Playwright/TS): Headless Chromium/Mobile for critical paths. Run headed in dev. Auth Bypass: Use a test-only login endpoint or custom AuthenticationHandler.
If app uses Google or Microsoft login: add AddTestAuth() in Dev to allow faking OAuth via /dev-login / Use dev login for e2e testing and testing manually running locally
Create http endpoints for all main functions so it can easily be tested  via curl or http endpoints 














App Stacks
Blazor Web App (Azure App Service)
Framework: .NET 10 Unified (SSR + WASM).
Architecture: Vertical Slice (VSA)—group DTOs, logic, and endpoints by feature.
