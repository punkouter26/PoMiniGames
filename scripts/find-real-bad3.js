const fs = require('fs');
const src = fs.readFileSync('C:/Users/punko/Downloads/PoMiniGames/served-game.js', 'utf8');
const lines = src.split('\n');

async function tryImport(s) {
  const tmp = 'C:/Users/punko/Downloads/PoMiniGames/scripts/_t.mjs';
  fs.writeFileSync(tmp, s);
  try { await import('file://' + tmp.replace(/\\/g,'/')); return 'OK'; }
  catch (e) { return e.message; }
}

(async () => {
  for (let i = 1; i < lines.length; i++) {
    const res = await tryImport(lines.slice(0, i).join('\n'));
    if (res !== 'OK') {
      console.log('First fail at', i, '-', res);
      for (let k = Math.max(0, i - 2); k < Math.min(lines.length, i + 3); k++) {
        console.log(k + 1, '::', lines[k].slice(0, 180));
      }
      break;
    }
  }
  try { fs.unlinkSync('C:/Users/punko/Downloads/PoMiniGames/scripts/_t.mjs'); } catch {}
})();