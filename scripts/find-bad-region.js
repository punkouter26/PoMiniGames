// Better parser: split every import (single + multi-line) by replacing the
// import/export lines via multiline regex.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/punko/Downloads/PoMiniGames/served-game.js', 'utf8');
// Multi-line aware strippers
const stripped = src
  .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '/* i */')
  .replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '/* i */')
  .replace(/^\s*export\s+\{[\s\S]*?\}\s*;?/gm, '/* e */')
  .replace(/^\s*export\s+default\s+/gm, '')
  .replace(/^\s*export\s+(class|function|const|let|var|async)\s+/gm, '$1 ');
try {
  new Function(stripped);
  console.log('PARSE OK');
} catch (e) {
  console.error('FAIL:', e.message);
  // bisect
  const lines = stripped.split('\n');
  let lo = 0, hi = lines.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try { new Function(lines.slice(0, mid).join('\n')); lo = mid; }
    catch { hi = mid; }
  }
  console.error('First bad line ≈', hi);
  for (let i = Math.max(0, hi - 4); i < Math.min(lines.length, hi + 3); i++) {
    console.error(`${i + 1}: ${lines[i]}`);
  }
}
