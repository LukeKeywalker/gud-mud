"use strict";
// Glide smoothness check: holds W (turning if the forward direction is a
// wall) and samples the camera position every frame; reports the spread of
// per-frame travel (a constant-velocity glide => tight spread, ~no stalls).
const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const URL = process.argv[2] || "http://localhost:18000";
const NAME = process.argv[3] || "glidebot";
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
  await sleep(300);
  const grabPts = (dur) => page.evaluate((d) => new Promise((res) => {
    const pts = [];
    const t0 = performance.now();
    const f = () => {
      const cam = window.__scene.children.find((o) => o.type === "PerspectiveCamera");
      pts.push([performance.now() - t0, cam.position.x, cam.position.z]);
      if (performance.now() - t0 < d) requestAnimationFrame(f); else res(pts);
    };
    requestAnimationFrame(f);
  }), dur);
  const movedDist = (pts) => Math.hypot(pts[pts.length - 1][1] - pts[0][1], pts[pts.length - 1][2] - pts[0][2]);
  await page.keyboard.down("w");
  await sleep(400);
  let pts = await grabPts(300);
  for (let t = 0; t < 3 && movedDist(pts) < 0.1 && pts.length > 3; t++) {
    await page.keyboard.up("w");
    await page.keyboard.press("a");
    await sleep(700);
    await page.keyboard.down("w");
    await sleep(300);
    pts = await grabPts(300);
  }
  await sleep(200);
  pts = await grabPts(2200);
  await page.keyboard.up("w");
  const ds = [];
  for (let i = 1; i < pts.length; i++) ds.push(Math.hypot(pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  if (ds.length < 5) { console.log("FATAL: no camera samples", pts.length); process.exit(1); }
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const std = Math.sqrt(ds.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ds.length);
  const max = Math.max(...ds);
  let stopped = 0, stall = 0, stallM = 0;
  for (const d of ds) {
    if (d < 0.0015) { stopped++; stall++; if (stall > stallM) stallM = stall; } else stall = 0;
  }
  const nonStop = ds.filter((d) => d >= 0.0015);
  const min = nonStop.length ? Math.min(...nonStop) : 0;
  console.log(`travel=${movedDist(pts).toFixed(2)}m frames=${ds.length}`);
  console.log(`per-frame mm: mean=${(mean * 1000).toFixed(1)} std=${(std * 1000).toFixed(1)} min=${(min * 1000).toFixed(1)} max=${(max * 1000).toFixed(1)}`);
  console.log(`stalled=${stopped}/${ds.length} longestStall=${stallM} frames`);
  await browser.close();
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
