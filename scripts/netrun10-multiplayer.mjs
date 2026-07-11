import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";
const require = createRequire(process.env.APPDATA + "/npm/node_modules/@mermaid-js/mermaid-cli/node_modules/");
const puppeteer = require("puppeteer");
const BASE = "http://localhost:5000";
const OUT = "C:/Users/punko/Downloads/PoMiniGames/docs/audit-2026-07-11";
mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-gpu-sandbox","--disable-dev-shm-usage"],
    defaultViewport: { width: 1366, height: 768 }
  });
  try {
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const consoleErrs = [];
    for (const p of [{p:pageA,who:"A"}, {p:pageB,who:"B"}]) {
      p.p.on("console", m => { if (m.type()==="error") consoleErrs.push("["+p.who+"] "+m.text().slice(0,200)); });
      p.p.on("pageerror", e => consoleErrs.push("["+p.who+"][pageerror] "+e.message.slice(0,200)));
    }
    // Auth as different users
    await pageA.goto(BASE+"/auth/login/fake?displayName=NetRun10-Alice", { waitUntil:"domcontentloaded" });
    await pageB.goto(BASE+"/auth/login/fake?displayName=NetRun10-Bob", { waitUntil:"domcontentloaded" });
    await new Promise(r=>setTimeout(r,2000));
    // Verify both authed
    const idA = await pageA.evaluate(()=>fetch("/api/auth/me").then(r=>r.json()).catch(e=>"ERR"));
    const idB = await pageB.evaluate(()=>fetch("/api/auth/me").then(r=>r.json()).catch(e=>"ERR"));
    // Go to /poracer/lobby in both
    await pageA.goto(BASE+"/poracer/lobby", { waitUntil:"domcontentloaded" });
    await new Promise(r=>setTimeout(r,1500));
    await pageB.goto(BASE+"/poracer/lobby", { waitUntil:"domcontentloaded" });
    await new Promise(r=>setTimeout(r,3500));
    const lobbyA = await pageA.evaluate(()=>document.body.innerText.replace(/\s+/g," ").trim().slice(0,400));
    const lobbyB = await pageB.evaluate(()=>document.body.innerText.replace(/\s+/g," ").trim().slice(0,400));
    await pageA.screenshot({ path: OUT+"/mp_lobby_A.png" });
    await pageB.screenshot({ path: OUT+"/mp_lobby_B.png" });
    // Try funquiz multiplayer
    await pageA.goto(BASE+"/funquiz/multiplayer", { waitUntil:"domcontentloaded" });
    await new Promise(r=>setTimeout(r,2000));
    await pageB.goto(BASE+"/funquiz/multiplayer", { waitUntil:"domcontentloaded" });
    await new Promise(r=>setTimeout(r,4000));
    const fqA = await pageA.evaluate(()=>document.body.innerText.replace(/\s+/g," ").trim().slice(0,400));
    const fqB = await pageB.evaluate(()=>document.body.innerText.replace(/\s+/g," ").trim().slice(0,400));
    await pageA.screenshot({ path: OUT+"/mp_funquiz_A.png" });
    await pageB.screenshot({ path: OUT+"/mp_funquiz_B.png" });
    // Couplequiz lobby
    await pageA.goto(BASE+"/couplequiz/lobby", { waitUntil:"domcontentloaded" });
    await new Promise(r=>setTimeout(r,2000));
    await pageB.goto(BASE+"/couplequiz/lobby", { waitUntil:"domcontentloaded" });
    await new Promise(r=>setTimeout(r,4000));
    const cqA = await pageA.evaluate(()=>document.body.innerText.replace(/\s+/g," ").trim().slice(0,400));
    const cqB = await pageB.evaluate(()=>document.body.innerText.replace(/\s+/g," ").trim().slice(0,400));
    await pageA.screenshot({ path: OUT+"/mp_couplequiz_A.png" });
    await pageB.screenshot({ path: OUT+"/mp_couplequiz_B.png" });
    writeFileSync(OUT+"/mp_results.json", JSON.stringify({idA,idB,lobbyA,lobbyB,fqA,fqB,cqA,cqB,consoleErrs},null,2));
    console.log("Alice /auth/me:", JSON.stringify(idA));
    console.log("Bob   /auth/me:", JSON.stringify(idB));
    console.log("\n[poracer/lobby A]", lobbyA.slice(0,200));
    console.log("\n[poracer/lobby B]", lobbyB.slice(0,200));
    console.log("\n[funquiz/mp A]", fqA.slice(0,200));
    console.log("\n[funquiz/mp B]", fqB.slice(0,200));
    console.log("\n[couplequiz/lobby A]", cqA.slice(0,200));
    console.log("\n[couplequiz/lobby B]", cqB.slice(0,200));
    console.log("\nConsole errors:", consoleErrs.length);
    for (const e of consoleErrs) console.log("  "+e);
  } finally { await browser.close(); }
})();
