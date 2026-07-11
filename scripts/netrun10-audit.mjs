import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
const require = createRequire(process.env.APPDATA + "/npm/node_modules/@mermaid-js/mermaid-cli/node_modules/");
const puppeteer = require("puppeteer");
const BASE = "http://localhost:5000";
const OUT = "C:/Users/punko/Downloads/PoMiniGames/docs/audit-2026-07-11";
mkdirSync(OUT, { recursive: true });
const ROUTES = [
  "/", "/leaderboards", "/profile", "/diag", "/test",
  "/connectfive/1", "/pobrawl/1", "/poclick/1",
  "/face/demo", "/face", "/face/leaderboard",
  "/face/recap/00000000-0000-0000-0000-000000000000",
  "/pomarblerace?demo=1", "/pomarblerace",
  "/poracer/demo", "/poracer",
  "/posurvive?demo=1",
  "/tictactoe/1", "/funquiz/1", "/funquiz",
  "/couplequiz", "/couplequiz/lobby", "/couplequiz/leaderboard",
  "/funquiz/multiplayer", "/poracer/lobby",
  "/poclick/stats/00000000-0000-0000-0000-000000000000",
];
(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-gpu-sandbox","--disable-dev-shm-usage"],
    defaultViewport: { width: 1366, height: 768 }
  });
  const results = [];
  const VPS = [
    { name: "desktop", config: { width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false } },
    { name: "mobile",  config: { width: 390,  height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } }
  ];
  try {
    const page = await browser.newPage();
    await page.goto(BASE + "/auth/login/fake?displayName=NetRun10", { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise(r => setTimeout(r, 1500));
    for (const vp of VPS) {
      await page.setViewport(vp.config);
      for (const route of ROUTES) {
        const errs = []; const netErrs = []; const bad4xx = [];
        const onC = m => { if (m.type()==="error"||m.type()==="warning") errs.push("["+m.type()+"] "+m.text().slice(0,300)); };
        const onP = e => errs.push("[pageerror] "+((e.stack||e.message||"").slice(0,400)));
        const onR = r => netErrs.push(r.method()+" "+r.url()+" :: "+(r.failure()&&r.failure().errorText));
        const onH = r => { const s=r.status(); if (s>=400 && s<600) bad4xx.push(s+" "+r.request().method()+" "+r.url()); };
        page.on("console", onC); page.on("pageerror", onP); page.on("requestfailed", onR); page.on("response", onH);
        let httpStatus=null, bodyText="", docH=0, vh=0, overflow="no", cc=0, title="", rs="", bi=[], navErr=null;
        const t0 = Date.now();
        try {
          const resp = await page.goto(BASE+route, { waitUntil:"domcontentloaded", timeout:12000 });
          httpStatus = resp?resp.status():null;
          await new Promise(r => setTimeout(r, 1100));
          const st = await page.evaluate(() => ({
            title: document.title, readyState: document.readyState,
            docH: document.documentElement.scrollHeight, vh: window.innerHeight,
            overflow: window.innerHeight < document.documentElement.scrollHeight ? "yes" : "no",
            bodyText: document.body.innerText.slice(0,500),
            cc: document.querySelectorAll("canvas").length,
            bi: [...document.querySelectorAll("img")].filter(i=>!i.complete||i.naturalWidth===0).map(i=>i.src)
          }));
          title=st.title; rs=st.readyState; docH=st.docH; vh=st.vh; overflow=st.overflow;
          bodyText=st.bodyText; cc=st.cc; bi=st.bi;
        } catch (e) { navErr = e.message.slice(0,200); }
        const dt = Date.now()-t0;
        page.off("console", onC); page.off("pageerror", onP);
        page.off("requestfailed", onR); page.off("response", onH);
        results.push({ vp:vp.name, route, httpStatus, title, rs, docH, vh, overflow, cc, bodyText:bodyText.replace(/\s+/g," ").trim().slice(0,200), bi, errs, netErrs, bad4xx, navErr, dt });
        console.log(vp.name+" "+route+" "+(httpStatus||"??")+" overflow="+overflow+" err="+errs.length+" net="+netErrs.length+" bad="+bad4xx.length+" nav="+(navErr?"Y":"-")+" "+dt+"ms");
      }
    }
  } finally {
    writeFileSync(OUT+"/audit.json", JSON.stringify(results, null, 2));
    await browser.close();
    const tot=results.length, ce=results.reduce((a,r)=>a+r.errs.length,0),
      ne=results.reduce((a,r)=>a+r.netErrs.length,0), br=results.reduce((a,r)=>a+r.bad4xx.length,0),
      of=results.filter(r=>r.overflow==="yes").length;
    console.log("DONE routes="+tot+" err="+ce+" net="+ne+" bad="+br+" overflows="+of);
  }
})();
