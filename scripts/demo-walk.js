// Test runner: walk through every demo URL, wait for load, capture snapshot data.
// Usage: pasted into run_playwright_code on the active page; iterates the DEMOS array.

const DEMOS = [
  { name: 'tictactoe',     url: 'http://localhost:5000/tictactoe/1' },
  { name: 'connectfive',   url: 'http://localhost:5000/connectfive/1' },
  { name: 'couplequiz',    url: 'http://localhost:5000/couplequiz?demo=1' },
  { name: 'poracer',       url: 'http://localhost:5000/poracer/demo' },
  { name: 'pomarblerace',  url: 'http://localhost:5000/pomarblerace?demo=1' },
  { name: 'pojoker',       url: 'http://localhost:5000/pojoker' },
  { name: 'pobrawl',       url: 'http://localhost:5000/pobrawl/1' },
  { name: 'posurvive',     url: 'http://localhost:5000/posurvive?demo=1' },
];

return DEMOS.map(d => ({ name: d.name, url: d.url }));