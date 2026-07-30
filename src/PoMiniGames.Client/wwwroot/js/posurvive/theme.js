// theme.js — dynamically loads/unloads PoSurvive's stylesheets so its aggressive
// global resets (*, html/body) only apply while the PoSurvive game page is active,
// keeping the rest of the PoMiniGames platform unaffected.
(function () {
    const SHEETS = [
        { id: 'posurvive-css-c64', href: 'css/posurvive/c64-theme.css' },
        { id: 'posurvive-css-contrast', href: 'css/posurvive/high-contrast.css' },
        { id: 'posurvive-css-app', href: 'css/posurvive/app.css' },
    ];

    // high-contrast.css keys off `body.high-contrast`. The C# toggle called
    // PoSurviveTheme.setHighContrast, which did not exist here — so the button threw a
    // JSException, the class was never applied, and the whole high-contrast stylesheet
    // (loaded above on every visit) was dead weight. The preference is persisted because
    // an accessibility choice that resets on navigation is not a usable one.
    const STORAGE_KEY = 'PoSurvive.highContrast';

    function apply(enabled) {
        document.body.classList.toggle('high-contrast', !!enabled);
    }

    function isEnabled() {
        try {
            return localStorage.getItem(STORAGE_KEY) === '1';
        } catch {
            return false; // private mode / storage disabled
        }
    }

    window.PoSurviveTheme = {
        load: function () {
            document.body.classList.add('posurvive-active');
            for (const s of SHEETS) {
                if (document.getElementById(s.id)) continue;
                const link = document.createElement('link');
                link.id = s.id;
                link.rel = 'stylesheet';
                link.href = s.href;
                document.head.appendChild(link);
            }
            // Re-apply the stored preference as part of mounting the theme.
            apply(isEnabled());
        },
        unload: function () {
            document.body.classList.remove('posurvive-active');
            // The class travels with the stylesheet: leaving it on would restyle the rest
            // of the platform against a sheet that is no longer loaded.
            document.body.classList.remove('high-contrast');
            for (const s of SHEETS) {
                const el = document.getElementById(s.id);
                if (el) el.remove();
            }
        },
        setHighContrast: function (enabled) {
            apply(enabled);
            try {
                localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
            } catch {
                // Non-fatal: the class is applied either way, it just won't persist.
            }
        },
        isHighContrast: isEnabled
    };
})();
