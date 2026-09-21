"use strict";
// Lean direction/gate check: samples the rotation-blur uniform (window.__mud.blur.x,
// driven by roll deltas) while E-strafing, Q-strafing and W-walking.
// Expect: E => positive peak, Q => negative peak, W => ~0 (no lean).
const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const URL = process.argv[2] || "http://localhost:18000";
const NAME = process.argv[3] || "leanbot";

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
  await new Promise((r) => setTimeout(r, 2500));
  await page.evaluate(() => { window.__samples = []; });
  const sampler = (ms) => page.evaluate((dur) => new Promise((res) => {
    const t0 = performance.now();
    const f = () => {
      const b = window.__mud.blur;
      window.__samples.push([b.x, b.y]);
      if (performance.now() - t0 < dur) requestAnimationFrame(f); else res();
    };
    requestAnimationFrame(f);
  }), ms);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const who = () => page.evaluate(() => {
    const cam = window.__scene.children.find((o) => o.type === "PerspectiveCamera");
    return { pos: cam.position.toArray().map((v) => Math.round(v * 100) / 100), rot: cam.rotation.toArray().map((v) => Math.round(v * 1000) / 1000), active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) };
  });
  const report = async (label) => {
    const [n, pos, neg, yMax] = await page.evaluate(() => {
      const cur = window.__samples.splice(0);
      return [
        cur.length,
        cur.reduce((a, v) => Math.max(a, v[0]), 0),
        cur.reduce((a, v) => Math.min(a, v[0]), 0),
        cur.reduce((a, v) => Math.max(a, Math.abs(v[1])), 0),
      ];
    });
    console.log(label, "n=" + n, "x+max=" + pos.toFixed(3), "x-max=" + neg.toFixed(3), "|y|max=" + yMax.toFixed(3));
  };
  const rollPeak = async (key, ms) => {
    await page.keyboard.down(key);
    const zs = [];
    for (let i = 0; i < 14; i++) {
      await sleep(50);
      zs.push((await who()).rot[2]);
    }
    await page.keyboard.up(key);
    console.log(key.toUpperCase() + " rolls: " + zs.map((z) => (z >= 0 ? "+" : "") + z.toFixed(3)).join(" "));
    void ms;
  };
  console.log("at boot:", JSON.stringify(await who()));
  await sampler(600); await sleep(100); await report("idle    (expect ~0):         ", 0);

  await page.keyboard.down("w");
  await sampler(1200);
  await page.keyboard.up("w");
  await sleep(400);
  await report("W-hold (expect ~0):        ", 0);

  await rollPeak("e"); await sleep(400);
  await rollPeak("q");
  await browser.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
