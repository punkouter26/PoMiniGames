// Mobile portrait test for all demos
// Already on home page in 390x844 viewport. Visit each demo and capture state.

const DEMOS = [
  { name: 'poclick',       url: 'http://localhost:5000/poclick/1' },
  { name: 'tictactoe',     url: 'http://localhost:5000/tictactoe/1' },
  { name: 'connectfive',   url: 'http://localhost:5000/connectfive/1' },
  { name: 'couplequiz',    url: 'http://localhost:5000/couplequiz?demo=1' },
  { name: 'poface',        url: 'http://localhost:5000/face/demo' },
  { name: 'poracer',       url: 'http://localhost:5000/poracer/demo' },
  { name: 'pomarblerace',  url: 'http://localhost:5000/pomarblerace?demo=1' },
  { name: 'pojoker',       url: 'http://localhost:5000/pojoker' },
  { name: 'pobrawl',       url: 'http://localhost:5000/pobrawl/1' },
  { name: 'posurvive',     url: 'http://localhost:5000/posurvive?demo=1' },
];

const results = [];
for (const d of DEMOS) {
  await page.goto(d.url);
  await page.waitForTimeout(3500); // give Blazor + demo loops time to settle
  const snap = await page.evaluate(() => {
    const m = document.querySelector('main');
    const mainR = m ? m.getBoundingClientRect() : null;
    return {
      url: location.href,
      main: mainR ? { w: mainR.width, h: mainR.height } : null,
      overflow: { x: document.documentElement.scrollWidth, y: document.documentElement.scrollHeight, vw: window.innerWidth, vh: window.innerHeight },
      hasDemoBadge: document.body.textContent.includes('Demo mode'),
      hasGuest: document.body.textContent.includes('Guest'),
      hasSignOut: !!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Sign out'),
      hasBottomTab: !!document.querySelector('.btb'),
      mainText: m ? m.textContent.replace(/\s+/g, ' ').trim().substring(0, 200) : '',
    };
  });
  results.push({ name: d.name, ...snap });
}
return results;