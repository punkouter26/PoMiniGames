// theme.js — dynamically loads/unloads PoSurvive's stylesheets so its aggressive
// global resets (*, html/body) only apply while the PoSurvive game page is active,
// keeping the rest of the PoMiniGames platform unaffected.
(function () {
    const SHEETS = [
        { id: 'posurvive-css-c64', href: 'css/posurvive/c64-theme.css' },
        { id: 'posurvive-css-contrast', href: 'css/posurvive/high-contrast.css' },
        { id: 'posurvive-css-app', href: 'css/posurvive/app.css' },
    ];

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
        },
        unload: function () {
            document.body.classList.remove('posurvive-active');
            for (const s of SHEETS) {
                const el = document.getElementById(s.id);
                if (el) el.remove();
            }
        }
    };
})();
