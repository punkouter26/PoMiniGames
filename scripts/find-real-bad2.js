// Find the *first* bad line in a module file.
const fs = require('fs');

const prefix = (n) => `import { default as x } from 'data:text/javascript,';`;  // not used; keep imports intact

const src = fs.readFileSync('C:/Users/punko/Downloads/PoMiniGames/served-game.js', 'utf8');
const lines = src.split('\n');

async function tryImport(s) {
  const tmp = 'C:/Users/punko/Downloads/PoMiniGames/scripts/_tmp2.mjs';
  fs.writeFileSync(tmp, s);
  try {
    await import('file://' + tmp.replace(/\\/g, '/'));
    return 'OK';
  } catch (e) {
    return e.message;
  }
}

(async () => {
  // Just binarily search the source — the parse fails at the IMPORT-prefix
  // boundary until we have a complete module.
  let lo = 1, hi = lines.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    // Slice to lines [0..mid] — enough to bisect.
    // We need a complete declaration by the end, but bisection needs only
    // parseable-at-all characters. So we close any open braces/brackets.
    const prefix = lines.slice(0, mid).join('\n');
    const res = await tryImport(prefix);
    if (res === 'OK') lo = mid;
    else hi = mid;
  }
  console.log('hi =', hi);
  console.log('error at hi lines =', await tryImport(lines.slice(0, hi).join('\n')));
  for (let i = Math.max(0, hi - 6); i < Math.min(lines.length, hi + 3); i++) {
    console.log(`${i + 1}: ${lines[i].slice(0, 200)}`);
  }
})().catch(e => console.error(e));
