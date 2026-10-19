// Regenerates tests/Shared/Fixtures/pocabinet-lap-proofs.txt from the browser physics.
// PoCabinetScoreStorageTests needs capitol messy < clean < wild; the field is chaotic, so the
// messy driver's line offset is searched until that holds.
import fs from 'node:fs';
import { race } from './harness.mjs';

const out = process.argv[2];
const line = (name, r) => `${name} ${r.id} ${r.wet ? 1 : 0} ${r.inputs} ${r.playerBest}`;
const clean = race('capitol', 'clean');
const wild = race('capitol', 'wild');
if (!(wild.playerBest > clean.playerBest)) throw new Error(`wild ${wild.playerBest} not slower than clean ${clean.playerBest}`);
let messy = null;
for (const off of [0.3, 0.2, 0.4, 0.1, 0.5, 0.6, -0.1, -0.2, 0.7, 0.15, 0.25, 0.35, 0.45, -0.3, 0.05]) {
    const r = race('capitol', 'messy', false, { messyOffset: off });
    console.log('messy offset', off, r.playerBest);
    if (r.playerBest > 0 && r.playerBest < clean.playerBest) { messy = r; break; }
}
if (!messy) throw new Error('no messy offset beats clean');
const maralago = race('maralago', 'clean');
const playground = race('playground', 'clean');
for (const r of [clean, messy, wild, maralago, playground]) if (!(r.playerBest > 0)) throw new Error(`no lap: ${r.id} ${r.driver}`);
const lines = [
    line('capitol-clean', clean),
    line('capitol-messy', messy),
    line('capitol-wild', wild),
    line('maralago-clean', maralago),
    line('playground-run', playground),
];
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log({ clean: clean.playerBest, messy: messy.playerBest, wild: wild.playerBest, maralago: maralago.playerBest, playground: playground.playerBest });
