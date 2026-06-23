/**
 * inferenceWorkerBridge.js
 * Main-thread bridge between Blazor (C#) and the inferenceWorker.js Web Worker.
 *
 * Manages the single Worker instance and routes messages back to Blazor
 * via DotNet.invokeMethodAsync or Promise resolution.
 *
 * Exported as window.inferenceWorkerBridge for JS Interop:
 *   await JS.InvokeVoidAsync("inferenceWorkerBridge.init", dotNetRef, modelId, cdnUrl)
 *   const json = await JS.InvokeAsync<string>("inferenceWorkerBridge.infer", gridJson, dnaObj, timeoutMs)
 */
(() => {
    let worker = null;
    let dotNetRef = null;
    const pending = new Map(); // requestId -> { resolve, reject, createdAt, timeoutMs, sourceContext }

    // Serial inference queue — ensures WebLLM engine processes one request at a time
    const inferQueue = []; // { requestId, gridJson, dna, timeoutMs, sourceContext }
    let inferBusy = false;

    let requestCounter = 0;
    const diagnostics = [];
    const maxDiagnostics = 500;
    let diagnosticsEnabled = true;
    let defaultInferenceTimeoutMs = 15_000;
    let shortCircuitOnBackpressure = true;
    let backpressureThreshold = 4;
    let globalRuntimeHandlersAttached = false;

    function notifyRuntimeError(message, source) {
        const text = String(message ?? 'Unknown runtime inference error.');
        addDiagnostic('runtime_error', {
            source,
            message: text,
            ...currentSnapshot(),
        });
        postClientRuntimeEvent('runtime_error', { source, message: text });

        if (dotNetRef && /bindingerror|web-llm|inference/i.test(text)) {
            dotNetRef.invokeMethodAsync('OnModelInitError', `Runtime inference error: ${text}`).catch(() => {});
        }
    }

    function ensureGlobalRuntimeHandlers() {
        if (globalRuntimeHandlersAttached || typeof window === 'undefined') return;
        globalRuntimeHandlersAttached = true;

        window.addEventListener('error', (event) => {
            const message = event?.error?.message ?? event?.message ?? 'Unknown window error.';
            notifyRuntimeError(message, 'window.error');
        });

        window.addEventListener('unhandledrejection', (event) => {
            const reason = event?.reason;
            const message = typeof reason === 'string'
                ? reason
                : (reason?.message ?? String(reason ?? 'Unknown unhandled rejection.'));
            notifyRuntimeError(message, 'window.unhandledrejection');
        });
    }
    let inferRequestCounter = 0;
    let maxPendingObserved = 0;
    const runtimeEventCooldown = new Map();

    function currentSnapshot() {
        return {
            pendingCount: pending.size,
            queueLength: inferQueue.length,
            inferBusy,
            maxPendingObserved,
            inferRequestCounter,
        };
    }

    function postClientRuntimeEvent(kind, payload) {
        try {
            const now = Date.now();
            const gateKey = `${kind}:${payload?.sourceContext?.agentId ?? 'global'}`;
            const lastSent = runtimeEventCooldown.get(gateKey) ?? 0;
            if (now - lastSent < 5000) {
                return;
            }
            runtimeEventCooldown.set(gateKey, now);

            fetch('/diag/client-event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    payload,
                    snapshot: currentSnapshot(),
                    ts: new Date().toISOString(),
                }),
                keepalive: true,
            }).catch(() => {});
        } catch {
            // Best effort telemetry only.
        }
    }

    function chooseBackpressureFallback(dnaObj, sourceContext) {
        const dominantTrait = String(dnaObj?.dominantTrait ?? '').toLowerCase();
        const sequences = {
            predatory: ['Attack', 'Flee', 'Forage'],
            scavenger: ['Forage', 'Idle', 'Flee'],
            paranoid: ['Flee', 'Forage', 'Idle'],
            altruistic: ['Idle', 'Forage', 'Flee'],
            methodical: ['Forage', 'Idle', 'Attack'],
        };

        const sequence = sequences[dominantTrait] ?? ['Idle', 'Forage', 'Flee'];
        const turnSeed = Number(sourceContext?.turnNumber ?? 0);
        const agentId = String(sourceContext?.agentId ?? 'unknown');
        const seed = Math.abs(hashString(`${agentId}:${turnSeed}:${dominantTrait}`));
        const action = sequence[seed % sequence.length];

        return {
            action,
            thought: 'Inference deferred due to queue backpressure; degraded fallback selected for this turn.',
        };
    }

    function hashString(value) {
        let hash = 0;
        for (let i = 0; i < value.length; i += 1) {
            hash = ((hash << 5) - hash) + value.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    /** Dispatches the next queued infer request to the worker (if not already busy). */
    function processQueue() {
        if (inferBusy || inferQueue.length === 0) return;
        inferBusy = true;
        const item = inferQueue.shift();
        addDiagnostic('queue_dispatch', {
            requestId: item.requestId,
            queueRemaining: inferQueue.length,
            sourceContext: item.sourceContext ?? null,
            ...currentSnapshot(),
        });
        worker.postMessage({
            type: 'infer',
            requestId: item.requestId,
            gridJson: item.gridJson,
            dna: item.dna,
            timeoutMs: item.timeoutMs,
            sourceContext: item.sourceContext ?? null,
        });
    }

    function addDiagnostic(event, detail) {
        if (!diagnosticsEnabled) return;

        diagnostics.push({
            ts: new Date().toISOString(),
            event,
            detail,
        });

        if (diagnostics.length > maxDiagnostics) {
            diagnostics.splice(0, diagnostics.length - maxDiagnostics);
        }
    }

    function ensureWorker() {
        if (!worker) {
            worker = new Worker('js/posurvive/inferenceWorker.js', { type: 'module' });
            worker.onmessage = handleWorkerMessage;
            worker.onerror = (e) => {
                addDiagnostic('worker_error', {
                    message: e.message ?? 'Unknown worker error',
                    filename: e.filename ?? null,
                    lineno: e.lineno ?? null,
                    colno: e.colno ?? null,
                    ...currentSnapshot(),
                });
                console.error('[inferenceWorkerBridge] worker error:', e);
            };
            addDiagnostic('worker_created', { module: 'js/posurvive/inferenceWorker.js' });
        }
        return worker;
    }

    function handleWorkerMessage(event) {
        const msg = event.data;

        addDiagnostic('worker_message', {
            type: msg.type ?? 'unknown',
            requestId: msg.requestId ?? null,
            ...currentSnapshot(),
        });

        if (msg.type === 'debug') {
            addDiagnostic('worker_debug', msg.payload ?? {});
            return;
        }

        if (msg.type === 'init_progress' && dotNetRef) {
            // Byte counter: progress is 0..1 float; we convert to byte-like counts
            const loaded = Math.round(msg.loaded * 2_400_000_000); // approx 2.4GB model
            const total  = 2_400_000_000;
            dotNetRef.invokeMethodAsync('OnModelProgress', loaded, total).catch(console.error);
            addDiagnostic('init_progress', {
                loaded,
                total,
                text: msg.text ?? null,
            });
        }

        if (msg.type === 'init_complete' && dotNetRef) {
            dotNetRef.invokeMethodAsync('OnModelReady').catch(console.error);
            addDiagnostic('init_complete', {
                modelId: msg.modelId ?? null,
            });
        }

        if (msg.type === 'init_error') {
            console.error('[inferenceWorkerBridge] init error:', msg.error);
            addDiagnostic('init_error', {
                modelId: msg.modelId ?? null,
                error: String(msg.error ?? 'Unknown inference init error'),
            });
            if (dotNetRef) {
                dotNetRef.invokeMethodAsync('OnModelInitError', String(msg.error ?? 'Unknown inference init error')).catch(console.error);
            }
        }

        if (msg.type === 'infer_result') {
            const entry = pending.get(msg.requestId);
            if (entry) {
                pending.delete(msg.requestId);
                inferBusy = false;
                processQueue();
                entry.resolve(JSON.stringify({ thought: msg.thought, action: msg.action }));
                addDiagnostic('infer_result', {
                    requestId: msg.requestId,
                    elapsedMs: msg.elapsedMs ?? null,
                    roundTripMs: Date.now() - entry.createdAt,
                    sourceContext: msg.sourceContext ?? entry.sourceContext ?? null,
                    pendingCountAfterResolve: pending.size,
                });
            } else {
                addDiagnostic('late_infer_result', {
                    requestId: msg.requestId,
                    elapsedMs: msg.elapsedMs ?? null,
                    reason: 'No pending entry when infer_result arrived (likely timeout/cleanup race).',
                    ...currentSnapshot(),
                });
            }
        }

        if (msg.type === 'infer_error' || msg.type === 'infer_timeout') {
            const entry = pending.get(msg.requestId);
            if (entry) {
                pending.delete(msg.requestId);
                inferBusy = false;
                processQueue();
                const detail = typeof msg.error === 'string' && msg.error.length > 0
                    ? msg.error
                    : (msg.type === 'infer_timeout' ? 'Timed out waiting for inference.' : 'Inference unavailable.');

                if (dotNetRef && /bindingerror|std::string|jsonschema|grammarcompiler/i.test(detail)) {
                    dotNetRef.invokeMethodAsync('OnModelInitError', `Runtime inference error: ${detail}`).catch(() => {});
                }

                entry.resolve(JSON.stringify({ thought: `Inference error: ${detail}`, action: 'Idle' }));
                addDiagnostic(msg.type, {
                    requestId: msg.requestId,
                    detail,
                    elapsedMs: msg.elapsedMs ?? null,
                    roundTripMs: Date.now() - entry.createdAt,
                    timeoutMs: entry.timeoutMs,
                    sourceContext: msg.sourceContext ?? entry.sourceContext ?? null,
                    pendingCountAfterResolve: pending.size,
                });
            } else {
                addDiagnostic(`late_${msg.type}`, {
                    requestId: msg.requestId,
                    detail: msg.error ?? null,
                    elapsedMs: msg.elapsedMs ?? null,
                    reason: 'No pending entry when infer_error/infer_timeout arrived (already resolved/cleaned).',
                    ...currentSnapshot(),
                });
            }
        }

        if (msg.type !== 'debug' && msg.type !== 'init_progress' && msg.type !== 'init_complete' && msg.type !== 'init_error' && msg.type !== 'infer_result' && msg.type !== 'infer_error' && msg.type !== 'infer_timeout') {
            addDiagnostic('worker_message_unhandled', {
                type: msg.type ?? 'unknown',
                requestId: msg.requestId ?? null,
                payloadKeys: Object.keys(msg ?? {}),
                ...currentSnapshot(),
            });
        }
    }

    /**
     * Initialises the Web Worker and starts model download.
     * @param {object} netRef    - DotNet object reference for progress callbacks
     * @param {string} modelId   - WebLLM model ID (e.g. "Phi-4-mini-instruct-q4f16_1-MLC")
     * @param {string} cdnUrl    - Optional CDN URL for the WebLLM ESM module
     * @param {object} options   - Optional init flags
     */
    function init(netRef, modelId, cdnUrl, options) {
        dotNetRef = netRef;
        ensureGlobalRuntimeHandlers();

        diagnosticsEnabled = options?.enableDiagnostics ?? true;
        defaultInferenceTimeoutMs = Number(options?.inferenceTimeoutMs ?? defaultInferenceTimeoutMs);
        shortCircuitOnBackpressure = false; // Fallback removed, queue requests instead
        backpressureThreshold = Math.max(1, Number(options?.backpressureThreshold ?? backpressureThreshold));

        const w = ensureWorker();
        const payload = {
            type: 'init',
            modelId: modelId ?? 'Phi-4-mini-instruct-q4f16_1-MLC',
            cdnUrl,
            options: {
                enableDiagnostics: diagnosticsEnabled,
                inferenceTimeoutMs: defaultInferenceTimeoutMs,
                useJsonResponseFormat: options?.useJsonResponseFormat ?? false,
            },
        };

        addDiagnostic('init_requested', payload);
        w.postMessage(payload);
    }

    /**
     * Sends an infer message to the worker and returns a Promise<string> (JSON).
     * @returns {Promise<string>} JSON: {"thought": "...", "action": "..."}
     */
    function infer(gridJson, dnaObj, timeoutMs, sourceContext) {
        const w = ensureWorker();
        const requestId = String(++requestCounter);
        const timeout = Number(timeoutMs ?? defaultInferenceTimeoutMs);
        inferRequestCounter += 1;

        return new Promise((resolve, reject) => {
            const predictedPending = pending.size + 1;
            if (shortCircuitOnBackpressure && predictedPending >= backpressureThreshold) {
                addDiagnostic('infer_short_circuit_backpressure', {
                    requestId,
                    pendingCount: pending.size,
                    predictedPending,
                    queueLength: inferQueue.length,
                    threshold: backpressureThreshold,
                    timeoutMs: timeout,
                    sourceContext: sourceContext ?? null,
                    ...currentSnapshot(),
                });

                postClientRuntimeEvent('backpressure_short_circuit', {
                    requestId,
                    pendingCount: pending.size,
                    predictedPending,
                    threshold: backpressureThreshold,
                    sourceContext: sourceContext ?? null,
                });

                const fallback = chooseBackpressureFallback(dnaObj, sourceContext);

                resolve(JSON.stringify({
                    thought: fallback.thought,
                    action: fallback.action,
                }));

                return;
            }

            pending.set(requestId, {
                resolve,
                reject,
                createdAt: Date.now(),
                timeoutMs: timeout,
                sourceContext: sourceContext ?? null,
            });

            maxPendingObserved = Math.max(maxPendingObserved, pending.size);

            const gridSize = typeof gridJson === 'string' ? gridJson.length : 0;

            addDiagnostic('infer_requested', {
                requestId,
                timeoutMs: timeout,
                dna: dnaObj,
                gridJsonBytes: gridSize,
                dominantTrait: dnaObj?.dominantTrait ?? null,
                sourceContext: sourceContext ?? null,
                pendingCountAfterEnqueue: pending.size,
                queueLengthAfterEnqueue: inferQueue.length + 1,
                maxPendingObserved,
            });

            if (pending.size >= backpressureThreshold) {
                addDiagnostic('pending_backpressure', {
                    requestId,
                    pendingCount: pending.size,
                    queueLength: inferQueue.length,
                    threshold: backpressureThreshold,
                    timeoutMs: timeout,
                });
            }

            // Queue the request; processQueue() will dispatch it when the engine is free
            inferQueue.push({ requestId, gridJson, dna: dnaObj, timeoutMs: timeout, sourceContext: sourceContext ?? null });
            processQueue();
        });
    }

    function getDiagnostics() {
        return diagnostics.slice();
    }

    function getDiagnosticsJson() {
        return JSON.stringify(getDiagnostics(), null, 2);
    }

    function getDiagnosticsSummary() {
        const byEvent = {};
        const bySource = {};
        for (const d of diagnostics) {
            byEvent[d.event] = (byEvent[d.event] ?? 0) + 1;

            const src = d?.detail?.sourceContext;
            if (src?.agentId) {
                const key = `T${src.turnNumber ?? '?'}:${src.team ?? '?'}:${src.agentId}`;
                bySource[key] ??= { requested: 0, results: 0, timeouts: 0, errors: 0 };
                if (d.event === 'infer_requested') bySource[key].requested += 1;
                if (d.event === 'infer_result') bySource[key].results += 1;
                if (d.event === 'infer_timeout') bySource[key].timeouts += 1;
                if (d.event === 'infer_error') bySource[key].errors += 1;
            }
        }

        const inferTimeouts = byEvent.infer_timeout ?? 0;
        const inferErrors = byEvent.infer_error ?? 0;
        const inferResults = byEvent.infer_result ?? 0;
        const lateResults = byEvent.late_infer_result ?? 0;
        const lateTimeouts = byEvent.late_infer_timeout ?? 0;
        const lateErrors = byEvent.late_infer_error ?? 0;
        const backpressure = byEvent.pending_backpressure ?? 0;

        return {
            totalDiagnostics: diagnostics.length,
            byEvent,
            infer: {
                requested: byEvent.infer_requested ?? 0,
                results: inferResults,
                timeouts: inferTimeouts,
                errors: inferErrors,
                lateResults,
                lateTimeouts,
                lateErrors,
                backpressureSignals: backpressure,
            },
            bySource,
            snapshot: currentSnapshot(),
            generatedAt: new Date().toISOString(),
        };
    }

    function getDiagnosticsSummaryJson() {
        return JSON.stringify(getDiagnosticsSummary(), null, 2);
    }

    function resetDiagnostics() {
        diagnostics.length = 0;
        maxPendingObserved = pending.size;
        addDiagnostic('diagnostics_reset', {});
    }

    window.inferenceWorkerBridge = { init, infer, getDiagnostics, getDiagnosticsJson, getDiagnosticsSummary, getDiagnosticsSummaryJson, resetDiagnostics };
})();
