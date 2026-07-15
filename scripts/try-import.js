const fs = require('fs');
// Just try the original served file directly
try {
  await import('file:///C:/Users/punko/Downloads/PoMiniGames/served-game.js');
  console.log('IMPORT OK');
} catch (e) {
  console.error('IMPORT FAIL:', e.message);
  console.error(e.stack);
}