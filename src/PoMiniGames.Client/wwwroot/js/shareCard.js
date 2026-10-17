// shareCard.js — "Share your result" from the end-of-game modal.
//
// Reads what the modal already shows (title, result line, stat cells, rank) straight from
// its DOM, so no game has to describe its result twice, and draws it onto a 1080x1080 PNG
// card. Shared as a file where the browser can (navigator.canShare({ files })); everywhere
// else the same facts go out as an emoji text summary through poPwa.shareLink, which uses
// the share sheet when there is one and the clipboard when there is not.
//
// Imported on demand by GameOverModal (IJSRuntime "import"), so no page pays for it until
// someone taps Share.

const SIZE = 1080;

function textOf(root, selector) {
    const el = root.querySelector(selector);
    return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

/** The modal's facts, as plain strings. */
function read(dialog) {
    const stats = [];
    for (const cell of dialog.querySelectorAll('.gps-stat')) {
        const value = textOf(cell, '.gps-stat-value');
        const label = textOf(cell, '.gps-stat-label');
        if (value || label) stats.push({ value, label });
    }
    return {
        title: textOf(dialog, '.gps-modal-title'),
        summary: textOf(dialog, '.gps-game-summary'),
        stats: stats.slice(0, 6),
    };
}

const OUTCOME = {
    win: { emoji: '🏆', word: 'Victory', a: '#22c55e', b: '#0ea5e9' },
    loss: { emoji: '💪', word: 'Good game', a: '#64748b', b: '#334155' },
    draw: { emoji: '🤝', word: 'Draw', a: '#f59e0b', b: '#6366f1' },
    done: { emoji: '🎮', word: 'Game over', a: '#6366f1', b: '#0ea5e9' },
};

/** Shrink a font until the text fits the width. */
function fit(g, text, weight, size, family, maxWidth) {
    let s = size;
    do {
        g.font = weight + ' ' + s + 'px ' + family;
        if (g.measureText(text).width <= maxWidth) break;
        s -= 4;
    } while (s > 18);
    return s;
}

function wrap(g, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
        const next = line ? line + ' ' + w : w;
        if (g.measureText(next).width > maxWidth && line) { lines.push(line); line = w; } else { line = next; }
    }
    if (line) lines.push(line);
    return lines.slice(0, 3);
}

function draw(facts, o) {
    const c = document.createElement('canvas');
    c.width = SIZE;
    c.height = SIZE;
    const g = c.getContext('2d');
    if (!g) return null;
    const look = OUTCOME[o.outcome] || OUTCOME.done;
    const family = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    const pad = 84;
    const w = SIZE - pad * 2;

    // The card is an image that leaves the app, so it carries its own fixed palette rather
    // than the viewer's theme: dark ink-blue with the outcome's two-colour glow.
    g.fillStyle = '#0b1120';
    g.fillRect(0, 0, SIZE, SIZE);
    const glow = g.createLinearGradient(0, 0, SIZE, SIZE);
    glow.addColorStop(0, look.a + '55');
    glow.addColorStop(1, look.b + '33');
    g.fillStyle = glow;
    g.fillRect(0, 0, SIZE, SIZE);

    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    let y = pad + 40;

    g.fillStyle = '#cbd5e1';
    g.font = '700 34px ' + family;
    g.fillText((facts.title || 'PoMiniGames').toUpperCase(), pad, y);
    y += 120;

    g.fillStyle = '#ffffff';
    const head = look.emoji + ' ' + look.word;
    fit(g, head, '800', 110, family, w);
    g.fillText(head, pad, y);
    y += 70;

    if (facts.summary) {
        g.fillStyle = '#e2e8f0';
        g.font = '500 40px ' + family;
        for (const line of wrap(g, facts.summary, w)) { g.fillText(line, pad, y); y += 52; }
    }
    y += 30;

    // Stat cells: two per row, value over label.
    const colW = w / 2;
    facts.stats.forEach((s, i) => {
        const x = pad + (i % 2) * colW;
        const top = y + Math.floor(i / 2) * 130;
        g.fillStyle = '#ffffff';
        fit(g, s.value, '800', 64, family, colW - 24);
        g.fillText(s.value, x, top + 64);
        g.fillStyle = '#94a3b8';
        g.font = '600 28px ' + family;
        g.fillText(s.label.toUpperCase(), x, top + 104);
    });
    y += Math.ceil(facts.stats.length / 2) * 130 + 20;

    if (o.rank) {
        g.fillStyle = '#ffffff';
        g.font = '800 56px ' + family;
        let line = '#' + o.rank + (o.of ? ' of ' + o.of : '');
        g.fillText(line, pad, Math.min(y + 56, SIZE - 220));
        if (o.climb > 0) {
            const lw = g.measureText(line + '  ').width;
            g.fillStyle = '#4ade80';
            g.fillText('▲' + o.climb, pad + lw, Math.min(y + 56, SIZE - 220));
        }
    }

    // Footer: the app's name and where to play.
    g.fillStyle = '#ffffff';
    g.font = '800 44px ' + family;
    g.fillText('PoMiniGames', pad, SIZE - pad - 40);
    g.fillStyle = '#94a3b8';
    g.font = '500 32px ' + family;
    g.fillText(o.host, pad, SIZE - pad + 4);
    return c;
}

function summaryText(facts, o) {
    const look = OUTCOME[o.outcome] || OUTCOME.done;
    const lines = [look.emoji + ' ' + (facts.title || 'PoMiniGames') + ' — ' + look.word];
    if (facts.summary) lines.push(facts.summary);
    if (facts.stats.length) lines.push(facts.stats.map((s) => '⭐ ' + s.label + ' ' + s.value).join(' · '));
    if (o.rank) lines.push('📈 #' + o.rank + (o.of ? ' of ' + o.of : '') + (o.climb > 0 ? ' (▲' + o.climb + ')' : ''));
    lines.push('🎮 PoMiniGames');
    return lines.join('\n');
}

/**
 * Share the result shown in `dialog`.
 * @param {HTMLDialogElement} dialog the open end-of-game modal
 * @param {{ outcome: 'win'|'loss'|'draw'|'done', rank?: number, of?: string, climb?: number }} o
 * @returns {Promise<'shared'|'copied'|'failed'>}
 */
export async function share(dialog, o) {
    const opts = o || {};
    const url = location.origin + location.pathname;
    opts.host = location.host;
    const facts = dialog ? read(dialog) : { title: '', summary: '', stats: [] };
    const text = summaryText(facts, opts);
    const title = (facts.title || 'PoMiniGames') + ' on PoMiniGames';

    try {
        const canvas = draw(facts, opts);
        const blob = canvas && await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (blob && typeof File === 'function' && navigator.canShare) {
            const file = new File([blob], 'pominigames-result.png', { type: 'image/png' });
            if (navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title, text: text + '\n' + url });
                    return 'shared';
                } catch (e) {
                    // Dismissed is still a share the player chose not to send.
                    if (e && e.name === 'AbortError') return 'shared';
                }
            }
        }
    } catch { /* fall through to the text summary */ }

    if (window.poPwa && window.poPwa.shareLink) return window.poPwa.shareLink(title, url, text);
    try {
        await window.poCopyToClipboard(text + '\n' + url);
        return 'copied';
    } catch {
        return 'failed';
    }
}
