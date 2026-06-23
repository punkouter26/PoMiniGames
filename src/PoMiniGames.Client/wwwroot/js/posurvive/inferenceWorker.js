/**
 * inferenceWorker.js
 * Dedicated Web Worker that hosts the WebLLM engine for on-device LLM inference.
 *
 * Messages from main thread:
 *   { type: "init",  modelId: string, initTimeoutMs: number }
 *   { type: "infer", requestId: string, gridJson: string, dna: object, timeoutMs: number }
 *
 * Messages to main thread:
 *   { type: "init_progress", loaded: number, total: number }
 *   { type: "init_complete" }
 *   { type: "init_error",   error: string }
 *   { type: "infer_result", requestId: string, thought: string, action: string }
 *   { type: "infer_error",  requestId: string, error: string }
 *   { type: "infer_timeout",requestId: string }
 */

// WebLLM is loaded via importScripts from CDN (avoids bundler dependency in WASM app)
// The CDN URL is injected at runtime via the "init" message to allow feature-flag control.
let engine = null;
let engineReady = false;
let currentModelId = 'Phi-4-mini-instruct-q4f16_1-MLC';
let currentUseJsonResponseFormat = false;
let currentEnableDiagnostics = true;
let currentDefaultInferenceTimeoutMs = 15_000;
let activeInferCount = 0;
let maxActiveInferCount = 0;

const defaultCdnCandidates = [
    'https://esm.run/@mlc-ai/web-llm',
    'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm',
];

// ─── System prompt template ───────────────────────────────────────────────────

function buildSystemPrompt(dna) {
    return `You are a ${dna.dominantTrait} agent. Respond ONLY with JSON: {"thought":"<very short reason>","action":"Attack|Forage|Flee|Idle"}`;
}

function buildUserPrompt(gridJson) {
    return `Grid state:\n${gridJson}\nRespond with JSON only.`;
}

// ─── Message handler ──────────────────────────────────────────────────────────

function emitDebug(event, detail = {}) {
    if (!currentEnableDiagnostics) return;

    self.postMessage({
        type: 'debug',
        payload: {
            event,
            modelId: currentModelId,
            activeInferCount,
            maxActiveInferCount,
            ...detail,
        },
    });
}

self.onmessage = async function(event) {
    const msg = event.data;

    if (msg.type === 'init') {
        await handleInit(msg);
    } else if (msg.type === 'infer') {
        await handleInfer(msg);
    }
};

// ─── Init ─────────────────────────────────────────────────────────────────────

async function handleInit({ modelId, cdnUrl, initTimeoutMs = 60000 }) {
    try {
        currentModelId = modelId ?? currentModelId;
        const options = arguments[0]?.options ?? {};
        currentUseJsonResponseFormat = !!options.useJsonResponseFormat;
        currentEnableDiagnostics = options.enableDiagnostics ?? true;
        currentDefaultInferenceTimeoutMs = Number(options.inferenceTimeoutMs ?? currentDefaultInferenceTimeoutMs);

        emitDebug('init_start', {
            initTimeoutMs,
            useJsonResponseFormat: currentUseJsonResponseFormat,
            defaultInferenceTimeoutMs: currentDefaultInferenceTimeoutMs,
        });

        // Dynamically import WebLLM with fallback URLs.
        const { CreateMLCEngine } = await importWebLlmModule(cdnUrl);

        engine = await CreateMLCEngine(modelId, {
            initProgressCallback: (progress) => {
                self.postMessage({
                    type:   'init_progress',
                    loaded: progress.progress ?? 0,
                    total:  1,
                    text:   progress.text ?? '',
                });
            },
        });

        engineReady = true;
        emitDebug('init_complete', {});
        self.postMessage({ type: 'init_complete', modelId: currentModelId });

    } catch (error) {
        emitDebug('init_error', { error: String(error) });
        self.postMessage({ type: 'init_error', error: String(error), modelId: currentModelId });
    }
}

function parseCdnCandidates(cdnUrl) {
    const configured = typeof cdnUrl === 'string'
        ? cdnUrl.split(',').map(u => u.trim()).filter(Boolean)
        : [];

    const unique = new Set([...configured, ...defaultCdnCandidates]);
    return [...unique];
}

async function importWebLlmModule(cdnUrl) {
    const candidates = parseCdnCandidates(cdnUrl);
    const errors = [];

    for (const candidate of candidates) {
        try {
            emitDebug('import_attempt', { candidate });
            return await import(candidate);
        } catch (error) {
            emitDebug('import_failed', { candidate, error: String(error) });
            errors.push(`${candidate}: ${String(error)}`);
        }
    }

    throw new Error(`WebLLM import failed for all candidates. ${errors.join(' | ')}`);
}

// ─── Infer ────────────────────────────────────────────────────────────────────

async function handleInfer({ requestId, gridJson, dna, timeoutMs = 10000, sourceContext = null }) {
    if (!engineReady || !engine) {
        self.postMessage({ type: 'infer_error', requestId, error: 'Engine not initialised.' });
        return;
    }

    const effectiveTimeoutMs = Number(timeoutMs ?? currentDefaultInferenceTimeoutMs);
    const startedAt = performance.now();
    const requestPayloadBytes = typeof gridJson === 'string' ? gridJson.length : 0;

    activeInferCount += 1;
    maxActiveInferCount = Math.max(maxActiveInferCount, activeInferCount);

    let completed = false;

    emitDebug('infer_start', {
        requestId,
        timeoutMs: effectiveTimeoutMs,
        useJsonResponseFormat: currentUseJsonResponseFormat,
        gridJsonBytes: requestPayloadBytes,
        dominantTrait: dna?.dominantTrait ?? null,
        sourceContext,
    });

    const timeoutHandle = setTimeout(() => {
        if (completed) {
            return;
        }
        completed = true;
        activeInferCount = Math.max(0, activeInferCount - 1);
        const elapsedMs = Math.round(performance.now() - startedAt);
        emitDebug('infer_timeout', {
            requestId,
            elapsedMs,
            timeoutMs: effectiveTimeoutMs,
            gridJsonBytes: requestPayloadBytes,
            sourceContext,
        });
        self.postMessage({ type: 'infer_timeout', requestId, elapsedMs, sourceContext });
    }, effectiveTimeoutMs);

    try {
        const requestPayload = {
            messages: [
                { role: 'system', content: buildSystemPrompt(dna) },
                { role: 'user',   content: buildUserPrompt(gridJson) },
            ],
            temperature: 0.2,
            max_tokens:  16,
        };

        if (currentUseJsonResponseFormat) {
            requestPayload.response_format = { type: 'json_object' };
        }

        const response = await engine.chat.completions.create(requestPayload);

        clearTimeout(timeoutHandle);

        if (completed) {
            const elapsedMs = Math.round(performance.now() - startedAt);
            emitDebug('infer_result_after_timeout', {
                requestId,
                elapsedMs,
                sourceContext,
                note: 'Result arrived after timeout path already completed.',
            });
            return;
        }
        completed = true;
        activeInferCount = Math.max(0, activeInferCount - 1);

        const raw  = response.choices[0]?.message?.content ?? '{}';
        let thought = 'Observing.';
        let action  = 'Idle';

        try {
            const parsed = JSON.parse(raw);
            thought = parsed.thought ?? thought;
            action  = parsed.action  ?? action;
        } catch {
            // Malformed JSON — fall back to defaults; never crash the worker
        }

        const elapsedMs = Math.round(performance.now() - startedAt);
        emitDebug('infer_result', {
            requestId,
            elapsedMs,
            action,
            sourceContext,
            rawChars: raw.length,
            responseChoiceCount: Array.isArray(response.choices) ? response.choices.length : 0,
        });
        self.postMessage({ type: 'infer_result', requestId, thought, action, elapsedMs, sourceContext });

    } catch (error) {
        clearTimeout(timeoutHandle);
        if (completed) {
            const elapsedMs = Math.round(performance.now() - startedAt);
            emitDebug('infer_error_after_timeout', {
                requestId,
                elapsedMs,
                sourceContext,
                error: String(error),
            });
            return;
        }
        completed = true;
        activeInferCount = Math.max(0, activeInferCount - 1);
        const elapsedMs = Math.round(performance.now() - startedAt);
        emitDebug('infer_error', {
            requestId,
            elapsedMs,
            error: String(error),
            gridJsonBytes: requestPayloadBytes,
            sourceContext,
        });
        self.postMessage({ type: 'infer_error', requestId, error: String(error), elapsedMs, sourceContext });
    }
}
