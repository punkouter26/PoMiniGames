window.PoSurviveUi = window.PoSurviveUi || {};

window.PoSurviveUi.focusElementById = function (elementId) {
    if (!elementId) {
        return;
    }

    document.getElementById(elementId)?.focus();
};

window.PoSurviveUi.flashElement = function (elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.classList.remove('c64-btn--flash');
    // force reflow so re-adding the class restarts animation
    void el.offsetWidth;
    el.classList.add('c64-btn--flash');
    el.addEventListener('animationend', () => el.classList.remove('c64-btn--flash'), { once: true });
};