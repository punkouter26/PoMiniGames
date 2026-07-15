// Parse-only diagnostic for the served pobrawl/game.js
const fs = require('fs');
const src = fs.readFileSync('C:/Users/punko/Downloads/PoMiniGames/served-game.js', 'utf8');
// Strip ESM imports/exports for use as a function body
const stripped = src
  .replace(/^export\s+\{[^}]*\}\s*;?/gm, '')
  .replace(/^export\s+default\s+/gm, '')
  .replace(/^export\s+class\s+/gm, 'class ')
  .replace(/^export\s+function\s+/gm, 'function ')
  .replace(/^export\s+const\s+/gm, 'const ');
try {
  // Try to find a syntax problem before runtime.
  new Function(stripped);
  console.log('PARSE OK');
} catch (e) {
  console.error('PARSE FAIL:', e.message);
}
