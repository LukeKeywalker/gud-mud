// Probe: screenshots the sword2 viewmodel + measures its in-frame spread (NDC)
// across the swing timeline. hi/lo are the highest/lowest visible NDC y.
// Usage: node devtools/shots_sword2_swing.js
const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const fs = require('fs');
const DIR = '/Users/user/Projects/llm-benchmarks/qwen3.8-27b/mud/devtools/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 450 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
  await page.goto('http://localhost:18000', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    "document.getElementById('loader').style.display === 'none'",
    { timeout: 120000 }
  );
  await sleep(2500);
  const shot = async (name) => {
    await page.screenshot({ path: `${DIR}/${name}.png` });
    console.log('shot', name);
  };
  const probe = () => page.evaluate(() => {
    const s = window.__scene, cam = s.children.find((c) => c.isPerspectiveCamera);
    const swing = cam.children.find((c) => c.isGroup).children[0];
    const pm = cam.projectionMatrix.elements, wm = cam.matrixWorldInverse.elements;
    let inF = 0, tot = 0, maxY = -9, minY = 9;
    swing.traverse((o) => { if (o.isMesh) {
      const e = o.matrixWorld.elements, pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const X = e[0]*x + e[4]*y + e[8]*z + e[12], Y = e[1]*x + e[5]*y + e[9]*z + e[13], Z = e[2]*x + e[6]*y + e[10]*z + e[14];
        const cx = wm[0]*X + wm[4]*Y + wm[8]*Z + wm[12], cy = wm[1]*X + wm[5]*Y + wm[9]*Z + wm[13], cz = wm[2]*X + wm[6]*Y + wm[10]*Z + wm[14];
        const cw = pm[3]*cx + pm[7]*cy + pm[11]*cz + pm[15];
        if (cw <= 0) continue; tot++;
        const nx = (pm[0]*cx + pm[4]*cy + pm[8]*cz + pm[12]) / cw, ny = (pm[1]*cx + pm[5]*cy + pm[9]*cz + pm[13]) / cw;
        if (Math.abs(nx) <= 1 && Math.abs(ny) <= 1) { inF++; if (ny > maxY) maxY = ny; if (ny < minY) minY = ny; }
      }
    }});
    return { f: +(inF / Math.max(1, tot)).toFixed(2), hi: +maxY.toFixed(2), lo: +minY.toFixed(2) };
  });
  await shot('sword2_idle');
  console.log('IDLE', JSON.stringify(await probe()));
  for (let atk = 0; atk < 3; atk++) {
    const t0 = Date.now();
    await page.keyboard.press('KeyL');
    const line = [];
    for (let i = 0; i < 24; i++) {
      await sleep(30);
      const t = Date.now() - t0;
      const pr = await probe();
      line.push(`${t}:f${pr.f} h${pr.hi} l${pr.lo}`);
      if (t >= 120 && i % 3 === 1) await shot(`sword2_swing_${atk}_${i}`);
    }
    console.log('ATK' + atk, ' ' + line.join(' '));
    await sleep(900);
  }
  console.log('PAGE ERRORS:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
