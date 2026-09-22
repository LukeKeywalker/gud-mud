"use strict";
const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const URL = process.argv[2] || 'http://localhost:18000';
(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 256, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => localStorage.setItem('mudName', 'fixverify'));
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => { const l = document.getElementById('loader'); return l && l.style.display === 'none'; }, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 1500));
  await page.click('#c');
  const inst = await page.evaluate(() => {
    const s = window.__scene, out = [];
    s.traverse(o => { if (o.isInstancedMesh) {
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      out.push({ n: o.count, sx: Math.round((bb.max.x - bb.min.x) * 1e3) / 1e3, sy: Math.round(bb.max.y * 1e3) / 1e3, sz: Math.round((bb.max.z - bb.min.z) * 1e3) / 1e3 });
    }});
    return out;
  });
  console.log('geo(geom-only per-instance sizes):', JSON.stringify(inst));
  for (let s = 0; s < 5; s++) {
    for (let i = 0; i < 8; i++) { await page.keyboard.press('w'); await new Promise((r) => setTimeout(r, 120)); }
    await new Promise((r) => setTimeout(r, 300));
    const cam = await page.evaluate(() => {
      const c = window.__scene.children.find(o => o.isCamera);
      return c ? c.position.toArray().map(v => Math.round(v * 100) / 100) : null;
    });
    console.log('cam', cam);
    await page.screenshot({ path: 'devtools/shots/fix_' + s + '.png' });
  }
  await browser.close();
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
