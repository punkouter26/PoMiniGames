// ─── Centralized AI globals ─────────────────────────────────────────
// The PoMiniGames host has two AI layers: the consolidated Azure AI
// Foundry hub (AIFoundryClientFactory / AIFoundryChatClientCache /
// AIFoundryOptions / AIFoundryBearerTokenHandler) and the resilience
// pipeline that backs every AI client (AzureOpenAIResilience).
//
// Both now live under the single PoMiniGames.AI namespace; this global
// using keeps the per-slice "using PoMiniGames.AI;" ceremony out of
// every AI-touching file (PoCoupleQuiz, PoFace, PoFunQuiz, PoJoker,
// PoSurvive, AIFoundryCentralizationTests).
global using PoMiniGames.AI;
