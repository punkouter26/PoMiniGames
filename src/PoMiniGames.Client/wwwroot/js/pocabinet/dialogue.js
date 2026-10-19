// pocabinet/dialogue.js
//
// Client-side dialogue bubble renderer. Lines come from the server's sim online
// and from the banter pool in solo races; this module mounts a DOM bubble over the
// race view that fades in on each line and fades out after a short delay.
//
// API:
//   const handle = dialogue.mount(parentEl);
//   dialogue.show(handle, name, text);   — name: the official's display name (PoCabinetCatalog.Officials)
//   dialogue.unmount(handle);

const VISIBLE_MS = 2400;

class DialogueHandle {
    constructor(root, nameEl, bodyEl) {
        this.root = root;
        this.nameEl = nameEl;
        this.bodyEl = bodyEl;
        this.disposed = false;
        this.hideTimer = null;
    }

    show(name, text) {
        if (this.disposed || !this.root) return;
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.nameEl.textContent = name || '';
        this.bodyEl.textContent = text || '';
        this.root.classList.add('pocabinet-dialogue--visible');
        this.hideTimer = setTimeout(() => {
            this.hideTimer = null;
            if (!this.disposed) this.root.classList.remove('pocabinet-dialogue--visible');
        }, VISIBLE_MS);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.hideTimer) clearTimeout(this.hideTimer);
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    }
}

export function mount(parent) {
    if (typeof parent === 'string') parent = document.getElementById(parent);
    if (!parent) throw new Error('pocabinet/dialogue: parent element is required');

    const root = document.createElement('div');
    root.className = 'pocabinet-dialogue';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    const nameEl = document.createElement('div');
    nameEl.className = 'pocabinet-dialogue__name';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'pocabinet-dialogue__body';

    root.appendChild(nameEl);
    root.appendChild(bodyEl);
    parent.appendChild(root);

    return new DialogueHandle(root, nameEl, bodyEl);
}

export function unmount(handle) {
    if (!handle) return;
    handle.dispose();
}

/** Show a line on the bubble; facade for window.PoCabinet.showDialogue. */
export function show(handle, name, text) {
    if (!handle) return;
    handle.show(name, text);
}
