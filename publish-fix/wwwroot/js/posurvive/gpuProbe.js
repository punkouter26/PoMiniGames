/**
 * gpuProbe.js
 * Checks WebGPU availability and returns a GPU label for the boot screen.
 *
 * Exported as window.gpuProbe so Blazor can call it via JS Interop:
 *   await JS.InvokeAsync<GpuProbeResult>("gpuProbe.checkGpu")
 */
(() => {
    /**
     * Probes for WebGPU support and requests an adapter.
     * @returns {Promise<{available: boolean, label: string}>}
     *   label is "ACCELERATED" when a real GPU adapter is found,
     *   "CPU FALLBACK" when only a software/CPU adapter is available or WebGPU is absent.
     */
    async function checkGpu() {
        if (!navigator.gpu) {
            return { available: false, label: 'CPU FALLBACK' };
        }

        try {
            const ua = (navigator.userAgent ?? '').toLowerCase();
            const isWindows = ua.includes('windows');
            const requestOptions = isWindows ? undefined : { powerPreference: 'high-performance' };
            const adapter = await navigator.gpu.requestAdapter(requestOptions);

            if (!adapter) {
                emitProbeEvent('gpu_unavailable', { isWindows });
                return { available: false, label: 'CPU FALLBACK' };
            }

            // Distinguish hardware vs software (CPU) adapters
            const info = adapter.info ?? {};
            const isCpu =
                (info.architecture ?? '').toLowerCase().includes('software') ||
                (info.description  ?? '').toLowerCase().includes('software') ||
                (info.vendor       ?? '').toLowerCase().includes('software');

            return isCpu
                ? { available: false, label: 'CPU FALLBACK' }
                : { available: true,  label: 'ACCELERATED' };

        } catch (error) {
            emitProbeEvent('gpu_probe_error', {
                message: error?.message ?? String(error ?? 'Unknown GPU probe error'),
            });
            return { available: false, label: 'CPU FALLBACK' };
        }
    }

    function emitProbeEvent(kind, payload) {
        try {
            fetch('/diag/client-event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    payload,
                    ts: new Date().toISOString(),
                }),
                keepalive: true,
            }).catch(() => {});
        } catch {
            // Ignore telemetry failures.
        }
    }

    window.gpuProbe = { checkGpu };
})();
