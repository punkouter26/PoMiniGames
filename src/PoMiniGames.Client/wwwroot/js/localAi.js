// localAi.js — the optional, free, on-device language model (WebLLM over WebGPU). Off by default.
//
// Importing this module costs nothing: WebLLM itself is only fetched (dynamic import from the
// pinned CDN build below) once the player has turned on "On-device AI" in Settings
// (localStorage pomini_local_ai = "on"), the browser has WebGPU, and a game actually asks.
// The first ask starts the one-time model download into the browser's Cache Storage and answers
// null until the model is ready.
//
// Every answer is bounded for its caller: at most one request in flight, 1.5 s per answer, and
// null on anything odd (busy, still loading, timeout, an answer outside the offered options).
// A null means "keep your rule-based answer"; nothing here ever throws to the caller.
//
// Used by: js/pojevarena (serves the "Jev" brain in the browser instead of the paid server path).

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm';
const MODEL = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
const PREF_KEY = 'pomini_local_ai';
const ANSWER_MS = 1500;

let engine = null;
let loading = null;
let progress = 0;
let failed = false;
let busy = false;

/** True when the browser can run the model at all (the Settings row is hidden otherwise). */
export function hasWebGpu() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/** The player's switch; storage errors (private mode, blocked) read as off. */
export function enabled() {
    try { return localStorage.getItem(PREF_KEY) === 'on'; } catch { return false; }
}

/** 'idle' | 'loading NN%' | 'ready' | 'error' — for a HUD line. */
export function status() {
    if (failed) return 'error';
    if (engine) return 'ready';
    if (loading) return `loading ${Math.round(progress * 100)}%`;
    return 'idle';
}

/** Starts the one-time download (no-op when off, unsupported, loading, loaded or failed). */
export function warmUp() {
    if (engine || loading || failed) return;
    if (!enabled() || !hasWebGpu()) return;
    loading = (async () => {
        const webllm = await import(WEBLLM_URL);
        engine = await webllm.CreateMLCEngine(MODEL, {
            initProgressCallback: (report) => { if (typeof report?.progress === 'number') progress = report.progress; },
        });
    })().catch((e) => {
        failed = true;
        console.warn('[localAi] on-device model unavailable; staying on rule-based answers.', e);
    }).finally(() => { loading = null; });
}

/**
 * One choice among offered options.
 * @param {{ situation: string, actions: string[], foci: string[] }} ask
 * @returns {Promise<{ action: string, focus: string | null } | null>}
 */
export async function pick({ situation, actions, foci }) {
    if (!engine) { warmUp(); return null; }
    if (busy || !actions?.length) return null;
    busy = true;
    let release = true;
    try {
        const request = engine.chat.completions.create({
            messages: [
                {
                    role: 'system',
                    content: 'You command one creature in an arena battle. Reply with JSON only, exactly like '
                        + '{"action":"<one action>","focus":"<one focus>"}, choosing only from the lists given.',
                },
                {
                    role: 'user',
                    content: `${situation}\nActions: ${actions.join(', ')}\nFocus options: ${foci.length ? foci.join(', ') : 'none'}`,
                },
            ],
            temperature: 0.2,
            max_tokens: 40,
        });
        let timer = 0;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ANSWER_MS); });
        const reply = await Promise.race([request, timeout]);
        clearTimeout(timer);
        if (!reply) {
            // Too slow: stop the generation, and stay busy until it has really stopped, so there is
            // never more than one request on the GPU.
            release = false;
            try { engine.interruptGenerate(); } catch { /* already done */ }
            request.catch(() => { }).finally(() => { busy = false; });
            return null;
        }
        return parse(reply?.choices?.[0]?.message?.content, actions, foci);
    } catch {
        return null;
    } finally {
        if (release) busy = false;
    }
}

function parse(text, actions, foci) {
    if (typeof text !== 'string') return null;
    const json = text.match(/\{[\s\S]*?\}/);
    if (!json) return null;
    let answer;
    try { answer = JSON.parse(json[0]); } catch { return null; }
    const action = typeof answer?.action === 'string' ? answer.action.trim() : '';
    if (!actions.includes(action)) return null;
    const focus = typeof answer?.focus === 'string' && foci.includes(answer.focus.trim()) ? answer.focus.trim() : null;
    return { action, focus };
}
