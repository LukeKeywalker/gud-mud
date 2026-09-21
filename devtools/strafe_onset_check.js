"use strict";
// Strafe onset check: holds E (right strafe) for 1.5 s, sampling camera roll
// (rotation.z), position, and the move-tween lifecycle (window.__mud.tw)
// every frame; keeps sampling 0.4 s after release.
// Expect: exactly one roll pump (onset, first step), then a smooth glide with
// no further pumps; every step tween spans the full step period (~260 ms, so
// held movement chains at constant velocity with no dead-stop between steps).
const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const URL = process.argv[2] || "http://localhost:18000";
const NAME = process.argv[3] || "onsetbot";
const HOLD = 1500;
const SAMPLE = 1900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument((name) => localStorage.setItem('mudName', name), NAME);
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(
    () => { const l = document.getElementById('loader'); return l && l.style.display === 'none'; },
    { timeout: 90000 }
  );
  await sleep(2500);

  // Self-heal: if the strafe direction is wall-blocked (persisted player
  // position), turn until a 350 ms E-tap actually moves the camera.
  const tapMove = () => page.evaluate(() => new Promise((res) => {
    const ms = 350;
    const cam = () => {
      const c = window.__scene.children.find((o) => o.type === "PerspectiveCamera");
      return [c.position.x, c.position.z];
    };
    const [x0, z0] = cam();
    const t0 = performance.now();
    const f = () => {
      if (performance.now() - t0 < ms) requestAnimationFrame(f);
      else { const [x1, z1] = cam(); res(Math.hypot(x1 - x0, z1 - z0)); }
    };
    requestAnimationFrame(f);
  }));
  let turns = 0;
  while (turns < 8) {
    await page.keyboard.down("e");
    const m = await tapMove();
    await page.keyboard.up("e");
    if (m >= 0.5) break;
    await page.keyboard.press("d");
    await sleep(400);
    turns += 1;
  }
  if (turns === 8) { console.log("FATAL could not find an open strafe direction"); process.exit(1); }
  console.log("self-heal: turns=" + turns);
  await sleep(300);

  await page.keyboard.down("e");
  const result = await Promise.all([
    page.evaluate(() => new Promise((res) => {
      const ms = 1900;
      const frames = [];
      const segs = [];
      const t0 = performance.now();
      const tw = window.__mud && window.__mud.tw;
      let prevOn = false, curStart = 0;
      const f = () => {
        const c = window.__scene.children.find((o) => o.type === "PerspectiveCamera");
        frames.push([performance.now() - t0, c.position.x, c.position.z, c.rotation.z]);
        if (tw) {
          if (tw.on && !prevOn) curStart = tw.t0 - t0;
          else if (prevOn && !tw.on) segs.push({ start: curStart, dur: performance.now() - (curStart + t0) });
        }
        prevOn = tw ? tw.on : false;
        if (performance.now() - t0 < ms) requestAnimationFrame(f);
        else res({ frames, segs: tw ? segs : null });
      };
      requestAnimationFrame(f);
    })),
    (async () => { await sleep(HOLD); await page.keyboard.up("e"); })(),
  ]);
  const { frames, segs } = result[0];

  const TH = 0.04; // half the LEAN_MAX pump; each walk pump crosses it once
  let pumps = 0, lastPumpAt = -1, tooLatePump = false;
  for (let i = 1; i < frames.length; i++) {
    const below = Math.abs(frames[i - 1][3]) < TH, above = Math.abs(frames[i][3]) >= TH;
    if (below && above && frames[i][0] < HOLD) {
      pumps += 1; lastPumpAt = frames[i][0];
      if (frames[i][0] > 500) tooLatePump = true;
    }
  }
  const [t0f, x0, z0] = frames[0];
  const [t1f, x1, z1] = frames[frames.length - 1];
  const moved = Math.hypot(x1 - x0, z1 - z0);
  const idleTail = frames.slice(-8).every((s) => Math.abs(s[3]) < TH);

  console.log(`  frames=${frames.length}  segsRawLen=${segs ? segs.length : -1}`);
  const heldSegs = segs ? segs.filter((s) => s.start < HOLD) : null;
  const DUR_LO = 235, DUR_HI = 300;  // full step period tweens (~260 ms)
  const GAP_MAX = 70;                // dead-stop between chained steps
  let durOk = false, gapOk = false;
  if (heldSegs && heldSegs.length >= 2) {
    durOk = heldSegs.every((s) => s.dur >= DUR_LO && s.dur <= DUR_HI);
    gapOk = heldSegs.every((s, i) => i === 0 || s.start - (heldSegs[i - 1].start + heldSegs[i - 1].dur) <= GAP_MAX);
  }
  console.log(`hold=${HOLD}ms  pumps=${pumps}  lastPumpAt=${Math.round(lastPumpAt)}ms  moved=${moved.toFixed(2)}m  settledAtEnd=${idleTail}`);
  if (heldSegs) {
    console.log("  segs (start,dur): " + heldSegs.map((s) => `${Math.round(s.start)},${Math.round(s.dur)}`).join("  "));
    console.log("  fullPeriodDurs=" + durOk + "  gaps<=GAP_MAX=" + gapOk);
  } else {
    console.log("  no tween handle (old build) — duration assertion cannot pass");
  }
  const ok = pumps === 1 && lastPumpAt <= 500 && !tooLatePump && moved >= 1.0 && idleTail && durOk && gapOk;
  console.log(ok ? "PASS (onset once, then smooth, no dead-stop)" : "FAIL");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
