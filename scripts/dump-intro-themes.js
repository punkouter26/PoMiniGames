const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve('src/PoMiniGames.Client/wwwroot/js/pobrawl/audio.js'), 'utf8');
const m = src.match(/const INTRO_THEMES = (\{[\s\S]*?\n\};)/);
if (!m) { console.error('INTRO_THEMES not found'); process.exit(1); }
const themes = eval('(' + m[1].slice(0, -2) + '\n)');
const ids = Object.keys(themes);
console.log('themes:', ids.length);
for (const id of ids) {
  const t = themes[id];
  const mel = t.melody.reduce((s, [, d]) => s + d, 0);
  const bas = (t.bass || []).reduce((s, [, d]) => s + d, 0);
  const dur = Math.max(mel, bas) * 60 / t.bpm;
  console.log(id.padEnd(8), 'bpm=' + String(t.bpm).padStart(3), 'notes=' + String(t.melody.length).padStart(2), 'dur=' + dur.toFixed(2) + 's');
}
