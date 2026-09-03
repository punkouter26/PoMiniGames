import { describe, expect, it, vi } from 'vitest';
import { LLM_STATE, MODELS, createThoughtBridge } from '../../../src/PoMiniGames.Client/wwwroot/js/poecosystem/host/thoughtBridge.js';

/** A fake module worker: records what it was posted, lets the test answer. */
function fakeWorker() {
  const posted = [];
  const w = {
    posted, onmessage: null, onerror: null, terminated: false,
    postMessage: (m) => posted.push(m),
    terminate: () => { w.terminated = true; },
    reply: (msg) => w.onmessage?.({ data: msg }),
    fail: (message) => w.onerror?.({ message }),
    of: (type) => posted.filter(p => p.type === type),
  };
  return w;
}

const bridgeWith = (over = {}) => {
  const worker = fakeWorker();
  const results = [];
  const states = [];
  const bridge = createThoughtBridge({
    WorkerCtor: function () { return worker; },
    hasWebGpu: async () => true,
    onResult: (handle, text) => results.push({ handle, text }),
    onState: (s) => states.push(s),
    ...over,
  });
  return { bridge, worker, results, states };
};

describe('thought bridge', () => {
  it('publishes the three offered models with sizes', () => {
    expect(MODELS.length).toBe(3);
    expect(MODELS[0].id).toBe('SmolLM2-360M-Instruct-q4f16_1-MLC');
    for (const m of MODELS) {
      expect(m.id).toMatch(/-MLC$/);
      expect(m.label.length).toBeGreaterThan(3);
      expect(m.vramMb).toBeGreaterThan(300);
    }
  });

  it('reports unsupported and never starts a worker without WebGPU', async () => {
    const { bridge, worker, states } = bridgeWith({ hasWebGpu: async () => false });
    await bridge.start('SmolLM2-360M-Instruct-q4f16_1-MLC');
    expect(bridge.state).toBe(LLM_STATE.UNSUPPORTED);
    expect(worker.posted.length).toBe(0);
    expect(states.map(s => s.state)).toContain(LLM_STATE.UNSUPPORTED);
    expect(bridge.request({ handle: 1, prompt: 'p', system: 's' })).toBe(false);
    bridge.dispose();
  });

  it('loads a model, reports progress, then answers one request at a time', async () => {
    const { bridge, worker, results, states } = bridgeWith();
    await bridge.start('Qwen3-0.6B-q4f16_1-MLC');
    expect(worker.of('init')[0].modelId).toBe('Qwen3-0.6B-q4f16_1-MLC');
    expect(bridge.state).toBe(LLM_STATE.LOADING);
    worker.reply({ type: 'progress', loaded: 0.42, text: 'fetching' });
    expect(states[states.length - 1].progress).toBeCloseTo(0.42, 5);
    expect(bridge.request({ handle: 7, prompt: 'p', system: 's' })).toBe(false); // not ready yet
    worker.reply({ type: 'ready' });
    expect(bridge.state).toBe(LLM_STATE.READY);
    expect(bridge.request({ handle: 7, prompt: 'why', system: 'sys' })).toBe(true);
    const infer = worker.of('infer')[0];
    expect(infer.prompt).toBe('why'); expect(infer.system).toBe('sys'); expect(infer.requestId).toBeGreaterThan(0);
    expect(bridge.request({ handle: 8, prompt: 'p2', system: 's' })).toBe(false); // one in flight
    worker.reply({ type: 'result', requestId: infer.requestId, text: '{"thought":"Hm.","trait":"greed","delta":0.1}' });
    expect(results).toEqual([{ handle: 7, text: '{"thought":"Hm.","trait":"greed","delta":0.1}' }]);
    expect(bridge.request({ handle: 8, prompt: 'p2', system: 's' })).toBe(true);
    const second = worker.of('infer')[1];
    worker.reply({ type: 'inferError', requestId: second.requestId, message: 'timeout' });
    expect(results[1]).toEqual({ handle: 8, text: '' });   // the sim templates on empty text
    expect(bridge.stats.requested).toBe(2);
    expect(bridge.stats.answered).toBe(1);
    expect(bridge.stats.failed).toBe(1);
    bridge.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('ignores stale answers and clears the flight on cancel', async () => {
    const { bridge, worker, results } = bridgeWith();
    await bridge.start(MODELS[0].id);
    worker.reply({ type: 'ready' });
    bridge.request({ handle: 5, prompt: 'p', system: 's' });
    const first = worker.of('infer')[0];
    bridge.cancel();
    expect(bridge.request({ handle: 6, prompt: 'p', system: 's' })).toBe(true);
    worker.reply({ type: 'result', requestId: first.requestId, text: 'late' });
    expect(results.length).toBe(0);                        // the stale answer is dropped
    const second = worker.of('infer')[1];
    worker.reply({ type: 'result', requestId: second.requestId, text: 'ok' });
    expect(results).toEqual([{ handle: 6, text: 'ok' }]);
  });

  it('surfaces load failures and a dead worker as an error state', async () => {
    const { bridge, worker, states } = bridgeWith();
    await bridge.start(MODELS[0].id);
    worker.reply({ type: 'initError', message: 'CDN blocked' });
    expect(bridge.state).toBe(LLM_STATE.ERROR);
    expect(states[states.length - 1].message).toContain('CDN blocked');
    expect(bridge.request({ handle: 1, prompt: 'p', system: 's' })).toBe(false);

    const second = bridgeWith();
    await second.bridge.start(MODELS[0].id);
    second.worker.fail('worker exploded');
    expect(second.bridge.state).toBe(LLM_STATE.ERROR);
  });

  it('falls back to a fresh worker when the constructor throws', async () => {
    const onState = vi.fn();
    const bridge = createThoughtBridge({
      WorkerCtor: function () { throw new Error('no worker'); },
      hasWebGpu: async () => true, onResult: () => {}, onState,
    });
    await bridge.start(MODELS[0].id);
    expect(bridge.state).toBe(LLM_STATE.ERROR);
    expect(onState).toHaveBeenCalled();
    bridge.dispose();
  });
});
