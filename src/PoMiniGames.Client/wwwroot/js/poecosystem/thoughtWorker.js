// thoughtWorker.js — WebLLM in its own module worker (pattern: posurvive/inferenceWorker.js).
//
// Two things are learned from PoSurvive's experience with @mlc-ai/web-llm:
//   1. the module is imported from a list of CDN candidates, because one of them is often
//      blocked and a single failure would take the whole feature down;
//   2. JSON-schema ("grammar") mode crashes on some builds — we try it once, and on a
//      grammar-shaped error permanently fall back to free-form text. nudges.js validates
//      whatever comes back either way, so a bad answer only costs a template thought.

const CDN_CANDIDATES = [
  'https://esm.run/@mlc-ai/web-llm',
  'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm',
];

const SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    trait: { type: 'string', enum: ['boldness', 'sociability', 'curiosity', 'greed', 'diligence'] },
    delta: { type: 'number' },
  },
  required: ['thought', 'trait', 'delta'],
};

const GRAMMAR_ERROR = /bindingerror|std::string|jsonschema|grammar|schema/i;
const TIMEOUT_MS = 20_000;

let engine = null;
let useSchema = true;

async function importWebLlm() {
  let lastError = null;
  for (const url of CDN_CANDIDATES) {
    try { return await import(/* @vite-ignore */ url); } catch (err) { lastError = err; }
  }
  throw lastError ?? new Error('web-llm could not be imported');
}

async function init(modelId) {
  const webllm = await importWebLlm();
  engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (p) => self.postMessage({ type: 'progress', loaded: p.progress ?? 0, text: p.text ?? '' }),
  });
  self.postMessage({ type: 'ready' });
}

async function infer(requestId, system, prompt) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  const base = { messages, temperature: 0.7, max_tokens: 96 };
  const attempt = (withSchema) => engine.chat.completions.create(
    withSchema ? { ...base, response_format: { type: 'json_object', schema: JSON.stringify(SCHEMA) } } : base,
  );
  let reply;
  try {
    reply = await attempt(useSchema);
  } catch (err) {
    if (useSchema && GRAMMAR_ERROR.test(String(err?.message ?? err))) {
      useSchema = false;                                   // this build cannot do grammars; never try again
      self.postMessage({ type: 'progress', loaded: 1, text: 'structured output unavailable — using free-form' });
      reply = await attempt(false);
    } else throw err;
  }
  return reply?.choices?.[0]?.message?.content ?? '';
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg?.type === 'init') {
    try { await init(msg.modelId); }
    catch (err) { self.postMessage({ type: 'initError', message: String(err?.message ?? err) }); }
    return;
  }
  if (msg?.type === 'infer') {
    if (!engine) { self.postMessage({ type: 'inferError', requestId: msg.requestId, message: 'engine not ready' }); return; }
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; self.postMessage({ type: 'inferError', requestId: msg.requestId, message: 'timeout' }); } }, TIMEOUT_MS);
    try {
      const text = await infer(msg.requestId, msg.system, msg.prompt);
      if (!done) { done = true; self.postMessage({ type: 'result', requestId: msg.requestId, text }); }
    } catch (err) {
      if (!done) { done = true; self.postMessage({ type: 'inferError', requestId: msg.requestId, message: String(err?.message ?? err) }); }
    } finally { clearTimeout(timer); }
    return;
  }
  if (msg?.type === 'dispose') {
    try { await engine?.unload?.(); } catch { /* ignore */ }
    engine = null;
  }
};
