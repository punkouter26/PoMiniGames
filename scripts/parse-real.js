// Use Node's vm to parse ONLY (no eval) — this preserves module semantics.
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('C:/Users/punko/Downloads/PoMiniGames/served-game.js', 'utf8');
try {
  // Wrap in a script and try to compile (no execution)
  new vm.Script(src, { filename: 'served-game.js' });
  console.log('PARSE OK');
} catch (e) {
  console.error('FAIL:', e.message);
  // vm.Script gives stack trace; extract line number
  const m = e.stack && e.stack.match(/served-game\.js:(\d+)/);
  if (m) {
    const ln = parseInt(m[1]);
    const lines = src.split('\n');
    console.error('Line', ln);
    for (let i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 3); i++) {
      console.error(`${i + 1}: ${lines[i]}`);
    }
  }
}
