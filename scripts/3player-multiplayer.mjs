// 3-player multiplayer smoke test
// Drives 3 browser contexts (Alice/Bob/Cara) through:
//   1) Couple Quiz lobby: 3-player create/join/ready/start, verify the King input + 2 guessers render
//   2) PoRacer lobby: 3 humans join the single global lobby, ready, host starts race, observe standings
//
// Usage:  node scripts/3player-multiplayer.mjs
//
// Requires playwright to be installed (npm i -D playwright && npx playwright install chromium).
// Already-installed globally via npx -y playwright@1.61.1, so we resolve from there.

import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "fs";

const require = createRequire(process.env.APPDATA + "/npm/node_modules/playwright-core/");
let playwright;
try {
  playwright = require("playwright");
} catch (e) {
  // Fall back to the playwright root module (not playwright-core)
  playwright = await import("playwright").catch(() => null);
}
if (!playwright) {
  console.error("playwright not installed. Run:  npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

const { chromium } = playwright;
const BASE = "http://localhost:5000";
const OUT = "C:/Users/punko/Downloads/PoMiniGames/docs/3player-2026-07-18";
mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function authAs(ctx, displayName) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/auth/login/fake?displayName=${displayName}`, { waitUntil: "domcontentloaded" });
  await wait(1500);
  const me = await page.evaluate(() => fetch("/api/auth/me").then((r) => r.json()).catch(() => "ERR"));
  return { page, me };
}

// CoupleQuiz / Racer GameShell wrap the intro card first; click OK to surface the join card.
async function passIntro(page) {
  // The intro's OK button uses the .gps-play-again-btn class with text "OK" (default).
  await page.waitForSelector(".gps-play-again-btn", { timeout: 20_000 });
  await page.click(".gps-play-again-btn");
}

async function setName(page, name) {
  // The first <input maxlength="24"> in the join card is the name field.
  const handle = await page.waitForSelector("input[maxlength='24']", { timeout: 10_000 });
  await handle.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
}

async function fillJoinCode(page, code) {
  const handle = await page.waitForSelector("input[maxlength='6']", { timeout: 10_000 });
  await handle.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, code);
}

async function clickByText(page, text, opts = {}) {
  await page.waitForFunction(
    (t) => Array.from(document.querySelectorAll("button")).some((b) => b.textContent.trim().includes(t)),
    text,
    { timeout: 15_000 }
  );
  await page.evaluate((t) => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim().includes(t));
    btn.click();
  }, text);
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 600));
}

async function screenshot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

const errors = [];
function hook(page, who) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${who}] console: ${m.text().slice(0, 240)}`);
  });
  page.on("pageerror", (e) => errors.push(`[${who}] pageerror: ${e.message.slice(0, 240)}`));
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const log = [];
  function step(name, payload) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${name}: ${JSON.stringify(payload)}`;
    log.push(line);
    console.log(line);
  }

  try {
    // ── Authenticate three contexts as distinct guests ───────────────────────────
    const [ctxA, ctxB, ctxC] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const [alice, bob, cara] = await Promise.all([
      authAs(ctxA, "Alice"),
      authAs(ctxB, "Bob"),
      authAs(ctxC, "Cara"),
    ]);
    [alice, bob, cara].forEach((p) => hook(p.page, p.me?.displayName ?? "?"));
    step("auth", {
      alice: alice.me?.displayName,
      bob: bob.me?.displayName,
      cara: cara.me?.displayName,
    });

    // ── Phase 1: Couple Quiz 3-player ───────────────────────────────────────────
    step("phase", "couple_quiz");

    // Alice opens first → becomes host of an empty global lobby (JoinOrCreate).
    await alice.page.goto(`${BASE}/couplequiz/lobby`, { waitUntil: "domcontentloaded" });
    await passIntro(alice.page);
    await wait(2000);
    await setName(alice.page, "Alice");
    await wait(500);
    await clickByText(alice.page, "Find or create a lobby");
    await wait(4000);
    const aliceLobby1 = await bodyText(alice.page);
    step("alice_created", aliceLobby1.slice(0, 200));
    await screenshot(alice.page, "cq_01_alice_host");

    // Extract Alice's game code from the rendered lobby text.
    // The actual separator on the page is "LOBBY · YY7B7" or "Lobby · YY7B7"
    // (uppercase H2 + middot). Accept either case and capture a 5-char code.
    const codeMatch = aliceLobby1.match(/(?:Lobby|LOBBY)\s*[\u00b7·]\s*([A-Z0-9]{4,8})/);
    const code = codeMatch?.[1];
    step("code", code);

    if (!code) {
      throw new Error("Could not extract game code from Alice's lobby");
    }

    // Bob and Cara join by code.
    for (const [who, page] of [[bob, bob.page], [cara, cara.page]]) {
      await page.goto(`${BASE}/couplequiz/lobby`, { waitUntil: "domcontentloaded" });
      await passIntro(page);
      await wait(2000);
      await setName(page, who.me.displayName);
      await fillJoinCode(page, code);
      await wait(500);
      await clickByText(page, "Join by code");
      await wait(3500);
      step(`joined_${who.me.displayName}`, await bodyText(page));
      await screenshot(page, `cq_02_${who.me.displayName}_joined`);
    }

    // Alice's view should now show 3 players.
    step("alice_after_joins", await bodyText(alice.page));
    await screenshot(alice.page, "cq_03_alice_three");

    // All three hit "I'm ready".
    for (const [who, page] of [["Alice", alice.page], ["Bob", bob.page], ["Cara", cara.page]]) {
      await clickByText(page, "I'm ready");
      step(`ready_${who}`, "clicked");
      await wait(1500);
    }
    await wait(3000);
    await screenshot(alice.page, "cq_04_all_ready_alice");
    await screenshot(bob.page, "cq_04_all_ready_bob");
    await screenshot(cara.page, "cq_04_all_ready_cara");

    // The game auto-starts when all ready + >=2 players. Give it time and capture
    // what each player sees (king input, guesser inputs, round text).
    await wait(7000);
    const cqRoundA = await bodyText(alice.page);
    const cqRoundB = await bodyText(bob.page);
    const cqRoundC = await bodyText(cara.page);
    step("round_alice", cqRoundA.slice(0, 300));
    step("round_bob", cqRoundB.slice(0, 300));
    step("round_cara", cqRoundC.slice(0, 300));
    await screenshot(alice.page, "cq_05_round_alice");
    await screenshot(bob.page, "cq_05_round_bob");
    await screenshot(cara.page, "cq_05_round_cara");

    // Alice (King) submits a secret answer; Bob & Cara submit guesses.
    async function submitAnswer(page, value) {
      const handle = await page.waitForSelector("input[maxlength='60']", { timeout: 5000 }).catch(() => null);
      if (!handle) return false;
      await handle.evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
      await wait(300);
      await clickByText(page, "Submit");
      return true;
    }

    await submitAnswer(alice.page, "Paris");
    await wait(500);
    await submitAnswer(bob.page, "Paris");
    await wait(500);
    await submitAnswer(cara.page, "Tokyo");
    await wait(3500);

    await screenshot(alice.page, "cq_06_answers_alice");
    await screenshot(bob.page, "cq_06_answers_bob");
    await screenshot(cara.page, "cq_06_answers_cara");

    // ── Phase 2: PoRacer 3-player ───────────────────────────────────────────────
    step("phase", "poracer");

    // The racer lobby is a single global room — having Couple Quiz still open
    // shouldn't affect it, but each tab needs to leave the Couple Quiz screen
    // first to free up the host's brain; CoupleQuiz's session is per-tab.
    await alice.page.goto(`${BASE}/poracer/lobby`, { waitUntil: "domcontentloaded" });
    await passIntro(alice.page);
    await wait(3000);
    await bob.page.goto(`${BASE}/poracer/lobby`, { waitUntil: "domcontentloaded" });
    await passIntro(bob.page);
    await wait(3000);
    await cara.page.goto(`${BASE}/poracer/lobby`, { waitUntil: "domcontentloaded" });
    await passIntro(cara.page);
    await wait(5000);

    const racerAlice = await bodyText(alice.page);
    const racerBob = await bodyText(bob.page);
    const racerCara = await bodyText(cara.page);
    step("racer_lobby_alice", racerAlice.slice(0, 250));
    step("racer_lobby_bob", racerBob.slice(0, 250));
    step("racer_lobby_cara", racerCara.slice(0, 250));
    await screenshot(alice.page, "pr_01_lobby_alice");
    await screenshot(bob.page, "pr_01_lobby_bob");
    await screenshot(cara.page, "pr_01_lobby_cara");

    // First arrival = host (Alice). Bob and Cara mark Ready; Alice starts the race.
    await clickByText(bob.page, "Ready!");
    await wait(1500);
    await clickByText(cara.page, "Ready!");
    await wait(1500);
    await screenshot(alice.page, "pr_02_all_ready_alice");
    await screenshot(bob.page, "pr_02_all_ready_bob");
    await screenshot(cara.page, "pr_02_all_ready_cara");

    await clickByText(alice.page, "Start Race");
    await wait(8000);

    await screenshot(alice.page, "pr_03_race_alice");
    await screenshot(bob.page, "pr_03_race_bob");
    await screenshot(cara.page, "pr_03_race_cara");
    step("race_alice", await bodyText(alice.page));
    step("race_bob", await bodyText(bob.page));
    step("race_cara", await bodyText(cara.page));

    writeFileSync(`${OUT}/results.json`, JSON.stringify({ errors, log }, null, 2));
    console.log("\n--- console errors:", errors.length);
    for (const e of errors.slice(0, 25)) console.log("  " + e);
  } catch (err) {
    console.error("TEST FAILED:", err?.stack ?? err);
    writeFileSync(`${OUT}/error.txt`, String(err?.stack ?? err));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();