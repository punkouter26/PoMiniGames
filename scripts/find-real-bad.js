// Bisect the served-game.js to find the exact bad line.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/punko/Downloads/PoMiniGames/served-game.js', 'utf8');
const lines = src.split('\n');

async function tryImport(prefix) {
  // Write the prefix to a temp .mjs file and try dynamic import.
  const tmp = 'C:/Users/punko/Downloads/PoMiniGames/scripts/_tmp_module.mjs';
  fs.writeFileSync(tmp, prefix);
  try {
    await import('file://' + tmp.replace(/\\/g, '/'));
    return true;
  } catch (e) {
    return e.message;
  }
}

(async () => {
  let lo = 0, hi = lines.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const res = await tryImport(lines.slice(0, mid).join('\n') + '\nexport default {};\n');
    if (res === true) lo = mid;
    else hi = mid;
  }
  console.log('First bad line ≈', hi);
  console.log('Error message at that prefix:', await tryImport(lines.slice(0, hi).join('\n') + '\nexport default {};\n'));
  for (let i = Math.max(0, hi - 4); i < Math.min(lines.length, hi + 3); i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
  // cleanup
  try { fs.unlinkSync('C:/Users/punko/Downloads/PoMiniGames/scripts/_tmp_module.mjs'); } catch {}
})();
