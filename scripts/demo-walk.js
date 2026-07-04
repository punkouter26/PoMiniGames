// Test runner: walk through every demo URL, wait for load, capture snapshot data.
// Usage: pasted into run_playwright_code on the active page; iterates the DEMOS array.

const DEMOS = [
  { name: 'poclick',       url: 'http://localhost:5000/poclick/1' },
  { name: 'tictactoe',     url: 'http://localhost:5000/tictactoe/1' },
  { name: 'connectfive',   url: 'http://localhost:5000/connectfive/1' },
  { name: 'couplequiz',    url: 'http://localhost:5000/couplequiz?demo=1' },
  { name: 'poface',        url: 'http://localhost:5000/face/demo' },
  { name: 'porunner',      url: 'http://localhost:5000/porunner/demo' },
  { name: 'poracer',       url: 'http://localhost:5000/poracer/demo' },
  { name: 'pomarblerace',  url: 'http://localhost:5000/pomarblerace?demo=1' },
  { name: 'pojoker',       url: 'http://localhost:5000/pojoker' },
  { name: 'pobrawl',       url: 'http://localhost:5000/pobrawl/1' },
  { name: 'posurvive',     url: 'http://localhost:5000/posurvive?demo=1' },
];

return DEMOS.map(d => ({ name: d.name, url: d.url }));