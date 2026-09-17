// Route-scoped input and canvas sizing. AbortController releases every listener.
let canvas = null, reference = null, listeners = null, enabled = false;
let input = { up: false, down: false, left: false, right: false, space: false };
const pressedKeys = new Set();
const pointers = new Map();
const keyMap = { arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', ' ': 'space' };

function emit(next) {
    if (Object.keys(input).every(key => input[key] === next[key])) return;
    input = next;
    if (reference) reference.invokeMethodAsync('OnInputChange', input.up, input.down, input.left, input.right, input.space).catch(() => {});
}
function update() {
    const active = new Set([...pressedKeys].map(key => keyMap[key]));
    for (const { key } of pointers.values()) active.add(key);
    emit(Object.fromEntries(Object.keys(input).map(key => [key, enabled && active.has(key)])));
}
function reset() {
    pressedKeys.clear();
    for (const { element } of pointers.values()) element.classList.remove('is-pressed');
    pointers.clear();
    update();
}
function keyboard(event, down) {
    const key = event.key.toLowerCase();
    if (!enabled || !keyMap[key] || event.target.closest?.('input,select,textarea,summary,button,a,[contenteditable]')) return;
    event.preventDefault();
    if (down) pressedKeys.add(key); else pressedKeys.delete(key);
    update();
}
function pointerDown(event) {
    const element = event.target.closest?.('[data-po-input]');
    const key = element?.dataset.poInput;
    if (!enabled || !Object.hasOwn(input, key)) return;
    event.preventDefault();
    try { element.setPointerCapture(event.pointerId); } catch { /* synthetic pointer or released contact */ }
    pointers.set(event.pointerId, { key, element });
    element.classList.add('is-pressed');
    update();
}
function pointerUp(event) {
    const pressed = pointers.get(event.pointerId);
    if (!pressed) return;
    pointers.delete(event.pointerId);
    if (![...pointers.values()].some(p => p.element === pressed.element)) pressed.element.classList.remove('is-pressed');
    update();
}
export function startInput(canvasId, dotnetReference) {
    stopInput();
    canvas = document.getElementById(canvasId);
    reference = dotnetReference;
    listeners = new AbortController();
    const options = { signal: listeners.signal };
    window.addEventListener('keydown', event => keyboard(event, true), options);
    window.addEventListener('keyup', event => keyboard(event, false), options);
    window.addEventListener('blur', reset, options);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); }, options);
    document.addEventListener('pointerdown', pointerDown, { ...options, passive: false });
    document.addEventListener('pointerup', pointerUp, options);
    document.addEventListener('pointercancel', pointerUp, options);
    document.addEventListener('lostpointercapture', pointerUp, options);
    getSize();
}
export function setInputEnabled(value) { enabled = value; reset(); }
export function stopInput() {
    enabled = false;
    reset();
    listeners?.abort();
    listeners = reference = canvas = null;
}
export function getSize() {
    if (!canvas) return { w: 0, h: 0 };
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = window.PoCanvasDpr.resolve(w, h);
    const width = Math.max(1, Math.floor(w * dpr)), height = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
        window.PoRacerRender?.invalidateBitmaps();
    }
    return { w, h };
}
