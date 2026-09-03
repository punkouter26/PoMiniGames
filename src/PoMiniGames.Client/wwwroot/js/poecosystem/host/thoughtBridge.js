// thoughtBridge.js — main-thread side of the in-browser LLM (plan decision 1: the sim
// worker and the model worker never talk directly, so WebGPU gating, model download UI and
// the inline fallback all stay here).
//
// One request in flight at a time; a request is dropped (not queued) while busy, because
// the sim's round-robin will offer another creature on the next tick anyway.

export const LLM_STATE = Object.freeze({ OFF: 'off', UNSUPPORTED: 'unsupported', LOADING: 'loading', READY: 'ready', ERROR: 'error' });

// Verified against @mlc-ai/web-llm 0.2.84 prebuiltAppConfig (2026-09-02).
export const MODELS = Object.freeze([
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'SmolLM2 360M', vramMb: 376, note: 'Smallest download — starts fastest.' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B', vramMb: 879, note: 'Better sentences, bigger download.' },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Qwen3 0.6B', vramMb: 1403, note: 'Most recent of the three.' },
]);

/**
 * WebGPU probe. Prefers the app's shared gpuProbe (js/posurvive/gpuProbe.js), which also
 * rejects software adapters and carries a Windows powerPreference workaround — reporting a
 * CPU adapter as available would start a several-hundred-MB download that then crawls.
 */
export const hasWebGpuSupport = async () => {
  try {
    const probe = globalThis.gpuProbe?.checkGpu;
    if (probe) return !!(await probe()).available;
    if (!globalThis.navigator?.gpu) return false;
    return !!(await navigator.gpu.requestAdapter());
  } catch { return false; }
};

export function createThoughtBridge({
  WorkerCtor = globalThis.Worker, workerUrl = null, hasWebGpu = hasWebGpuSupport,
  onResult = () => {}, onState = () => {},
} = {}) {
  let worker = null;
  let state = LLM_STATE.OFF;
  let modelId = MODELS[0].id;
  let progress = 0;
  let message = '';
  let nextId = 1;
  let inFlight = null;   // { requestId, handle }
  const stats = { requested: 0, answered: 0, failed: 0 };

  const emit = () => onState({ state, modelId, progress, message, stats: { ...stats } });
  const setState = (s, msg = '') => { state = s; message = msg; emit(); };

  function onWorkerMessage(data) {
    switch (data?.type) {
      case 'progress': progress = data.loaded ?? 0; message = data.text ?? ''; emit(); return;
      case 'ready': progress = 1; setState(LLM_STATE.READY); return;
      case 'initError': setState(LLM_STATE.ERROR, `Model failed to load: ${data.message}`); return;
      case 'result':
        if (!inFlight || data.requestId !== inFlight.requestId) return;   // stale (cancelled or superseded)
        stats.answered++;
        { const { handle } = inFlight; inFlight = null; onResult(handle, data.text ?? ''); }
        emit();
        return;
      case 'inferError':
        if (!inFlight || data.requestId !== inFlight.requestId) return;
        stats.failed++;
        { const { handle } = inFlight; inFlight = null; onResult(handle, ''); }   // empty text ⇒ the sim uses a template
        emit();
        return;
      default:
    }
  }

  const bridge = {
    get state() { return state; },
    get modelId() { return modelId; },
    get progress() { return progress; },
    get stats() { return { ...stats }; },
    get busy() { return inFlight !== null; },

    async start(id) {
      modelId = id ?? modelId;
      if (!(await hasWebGpu())) { setState(LLM_STATE.UNSUPPORTED, 'This browser has no WebGPU, so creature thoughts come from templates.'); return false; }
      bridge.dispose(false);
      try {
        worker = new WorkerCtor(workerUrl ?? new URL('../thoughtWorker.js', import.meta.url), { type: 'module' });
      } catch (err) {
        setState(LLM_STATE.ERROR, `Could not start the model worker: ${err?.message ?? err}`);
        return false;
      }
      worker.onmessage = (e) => onWorkerMessage(e.data);
      worker.onerror = (err) => setState(LLM_STATE.ERROR, `Model worker error: ${err?.message ?? err}`);
      progress = 0;
      setState(LLM_STATE.LOADING, 'Downloading the model…');
      worker.postMessage({ type: 'init', modelId });
      return true;
    },

    /** Send one prompt; false when unsupported, still loading, or one is already in flight. */
    request({ handle, prompt, system }) {
      if (state !== LLM_STATE.READY || inFlight || !worker) return false;
      const requestId = nextId++;
      inFlight = { requestId, handle };
      stats.requested++;
      worker.postMessage({ type: 'infer', requestId, prompt, system });
      return true;
    },

    cancel() { inFlight = null; },

    dispose(reset = true) {
      if (worker) { try { worker.terminate(); } catch { /* already gone */ } worker = null; }
      inFlight = null;
      if (reset) setState(LLM_STATE.OFF);
    },
  };
  return bridge;
}
