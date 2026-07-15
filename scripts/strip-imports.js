// Parse-only diagnostic for the served pobrawl/game.js using esprima
const fs = require('fs');
const src = fs.readFileSync('C:/Users/punko/Downloads/PoMiniGames/served-game.js', 'utf8');
// The Node 18+ shipped with --experimental-vm-modules but we don't need it.
// Just hand-parse with a regex strip, then validate via Function().
const stripped = src
  .split('\n')
  .map((l) => l
    .replace(/^\s*import\s+.+;\s*$/, '// import')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?/, '// export')
    .replace(/^\s*export\s+default\s+/, '')
    .replace(/^\s*export\s+(class|function|const|let|var|async)\s+/, '$1 '))
  .join('\n');
try {
  new Function(stripped);
  console.log('PARSE OK');
} catch (e) {
  // Find line near the failure. esprima gives us better info but is not
  // installed; locate via line counts at incremental prefixes.
  console.error('FAIL:', e.message);
  // Bisect: find max prefix that still parses
  const lines = stripped.split('\n');
  let lo = 0, hi = lines.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try { new Function(lines.slice(0, mid).join('\n')); lo = mid; }
    catch { hi = mid; }
  }
  console.error('First bad line ≈', hi + 1);
  for (let i = Math.max(0, hi - 4); i < Math.min(lines.length, hi + 2); i++) {
    console.error(`${i + 1}: ${lines[i].slice(0, 120)}`);
  }
}
