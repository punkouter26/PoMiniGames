/**
 * webcam.js — PoFace camera capture module (consolidation import).
 * Exposed at window.webcamInterop for .NET JS interop.
 *
 * C# callers (see contracts/blazor-interop.md):
 *   JS.InvokeVoidAsync("webcamInterop.initCamera",   "webcam-preview")
 *   JS.InvokeAsync<string>("webcamInterop.captureFrame", "webcam-preview")
 *   JS.InvokeVoidAsync("webcamInterop.releaseCamera")
 *   JS.InvokeVoidAsync("webcamInterop.flashShutter", "frozen-frame-overlay")
 */

(function () {
    'use strict';

    /** @type {MediaStream | null} */
    let _stream = null;

    /** @type {HTMLCanvasElement | null} */
    let _canvas = null;

    /** @type {CanvasRenderingContext2D | null} */
    let _ctx = null;

    /** Whether stub mode is active (no camera available; uses a static JPEG). */
    let _stubMode = false;

    /**
     * Demo override: when set, captureFrame renders the supplied SVG markup
     * to a canvas and returns the JPEG. Used by PoFace demo mode to feed a
     * synthetic face through the same capture pipeline the live camera uses.
     */
    let _demoSvgMarkup = null;

    /**
     * Minimal valid 1×1 white JPEG — used when stub mode is active so the
     * scoring API receives a real (if unscored) JPEG rather than nothing.
     */
    const STUB_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';

    const CANVAS_W = 640;
    const CANVAS_H = 480;
    const QUALITY_NORMAL = 0.92;
    const QUALITY_LOW_BW = 0.75;

    function mapCameraError(error) {
        const name = error?.name ?? '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
            return 'permission-denied';
        }
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'NotReadableError') {
            return 'camera-unavailable';
        }
        return 'error';
    }

    async function initCamera(videoElementId) {
        const video = document.getElementById(videoElementId);
        if (!video) return 'error';
        if (!navigator.mediaDevices?.getUserMedia) return 'camera-unavailable';

        try {
            _stream = await navigator.mediaDevices.getUserMedia({ video: true });
            video.srcObject = _stream;

            if (!_canvas) {
                _canvas = document.createElement('canvas');
                _canvas.width = CANVAS_W;
                _canvas.height = CANVAS_H;
                _canvas.style.display = 'none';
                document.body.appendChild(_canvas);
                _ctx = _canvas.getContext('2d');
            }

            await new Promise((resolve, reject) => {
                video.onplaying = resolve;
                video.onerror = reject;
                video.play().catch(reject);
            });
            return 'ok';
        } catch (error) {
            releaseCamera();
            return mapCameraError(error);
        }
    }

    async function getCameraPermissionState() {
        if (!navigator.mediaDevices?.getUserMedia) return 'camera-unavailable';
        if (!navigator.permissions?.query) return 'unknown';
        try {
            const status = await navigator.permissions.query({ name: 'camera' });
            return status?.state ?? 'unknown';
        } catch {
            return 'unknown';
        }
    }

    async function captureFrame(videoElementId) {
        // NetRun10 follow-up: when demo mode has registered a synthetic
        // SVG markup via setDemoSvgMarkup(), render it to the same canvas
        // the live camera path uses and return the JPEG. This lets the
        // demo exercise the real scoring pipeline end-to-end without a
        // webcam. Falls back to STUB_DATA_URL if the SVG fails to render.
        if (_demoSvgMarkup) {
            try {
                if (!_canvas) {
                    _canvas = document.createElement('canvas');
                    _canvas.width = CANVAS_W;
                    _canvas.height = CANVAS_H;
                    _canvas.style.display = 'none';
                    document.body.appendChild(_canvas);
                    _ctx = _canvas.getContext('2d');
                }
                const img = await svgMarkupToImage(_demoSvgMarkup, CANVAS_W, CANVAS_H);
                _ctx.fillStyle = '#000';
                _ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
                _ctx.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
                const downlink = navigator.connection?.downlink ?? Infinity;
                const quality  = downlink < 1.0 ? QUALITY_LOW_BW : QUALITY_NORMAL;
                return _canvas.toDataURL('image/jpeg', quality);
            } catch (e) {
                console.warn('[webcam] demo SVG render failed, falling back to stub JPEG', e);
                return STUB_DATA_URL;
            }
        }
        if (_stubMode) return STUB_DATA_URL;
        const video = document.getElementById(videoElementId);
        if (!video) throw new Error(`Video element #${videoElementId} not found.`);
        if (!_canvas || !_ctx) throw new Error('Camera not initialized. Call initCamera first.');

        _ctx.drawImage(video, 0, 0, CANVAS_W, CANVAS_H);

        const downlink = navigator.connection?.downlink ?? Infinity;
        const quality  = downlink < 1.0 ? QUALITY_LOW_BW : QUALITY_NORMAL;
        return _canvas.toDataURL('image/jpeg', quality);
    }

    /**
     * Render an SVG markup string to an HTMLImageElement (CORS-safe; we
     * inline via data: URL so no fetch is needed). Returns a Promise that
     * resolves on the image's onload or rejects on onerror / 5 s timeout.
     */
    function svgMarkupToImage(svgMarkup, width, height) {
        return new Promise((resolve, reject) => {
            const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);
            const img = new Image();
            img.width = width;
            img.height = height;
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('svg image load failed'));
            const timeout = setTimeout(() => reject(new Error('svg image load timeout')), 5000);
            img.onload = () => { clearTimeout(timeout); resolve(img); };
            img.onerror = () => { clearTimeout(timeout); reject(new Error('svg image load failed')); };
            img.src = dataUrl;
        });
    }

    function setDemoSvgMarkup(svgMarkup) {
        // Pass null/empty to clear; the next captureFrame falls back to stub.
        _demoSvgMarkup = (svgMarkup && svgMarkup.length > 0) ? svgMarkup : null;
    }

    function releaseCamera() {
        if (_stream) {
            _stream.getTracks().forEach(t => t.stop());
            _stream = null;
        }
        if (_canvas) {
            _canvas.remove();
            _canvas = null;
            _ctx    = null;
        }
    }

    function activateStubMode() { _stubMode = true; }

    async function flashShutter(overlayElementId) {
        const overlay = document.getElementById(overlayElementId);
        if (!overlay) return;
        overlay.classList.add('shutter-flash');
        await new Promise(resolve => setTimeout(resolve, 160));
        overlay.classList.remove('shutter-flash');
    }

    window.webcamInterop = {
        initCamera,
        getCameraPermissionState,
        captureFrame,
        releaseCamera,
        flashShutter,
        activateStubMode,
        setDemoSvgMarkup
    };
})();
