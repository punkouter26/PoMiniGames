const fs = require('fs');
const src = fs.readFileSync('C:/Users/punko/Downloads/PoMiniGames/served-game.js', 'utf8');
const start = src.indexOf('fragmentShader: /* glsl */');
const after = start + 24;
let positions = [];
for (let i = after; i < src.length; i++) {
  if (src.charCodeAt(i) === 96) positions.push(i);  // 96 == `
}
console.log('first 8 backticks after marker:', positions.slice(0, 8));
console.log('chars around each:');
for (const p of positions.slice(0, 6)) {
  console.log('---');
  console.log(src.slice(Math.max(0, p - 50), p + 50));
}
