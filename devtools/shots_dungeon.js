// Verify the Modular Dungeon pack assets: instanced wall/floor/arch counts
// vs the map, prop groups present, zero console/page errors, and lit
// screenshots (start + turned 180 deg + a few steps).
// Usage: node devtools/shots_dungeon.js
const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');
const ROOT = '/Users/user/Projects/llm-benchmarks/qwen3.8-27b/mud';
const DIR = path.join(ROOT, 'devtools/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function expectedFromMap() {
  const rows = fs.readFileSync(path.join(ROOT, 'maps/starter.txt'), 'utf8').split('\n').filter(Boolean);
  const h = rows.length, w = rows[0].length;
  let wall = 0, door = 0, floor = 0;
  for (const r of rows)
    for (const c of r) {
      if (c === '#') wall++;
      else if (c === 'd') door++;
      else floor++;
    }
  return { wall, door, floor, w, h, codes: [...rows.join('')].map(c => c === '#' ? 0 : 1) };
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const ex = expectedFromMap();
  const { wallPanels } = await import('../client/static/wall-panels.mjs');
  const panelCounts = new Map();
  for (const panel of wallPanels(ex.codes, ex.w, ex.h))
    panelCounts.set(panel.width, (panelCounts.get(panel.width) || 0) + 1);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(
    (testName) => localStorage.setItem('mudName', testName),
    'dungeon-test-' + process.pid
  );
  await page.setViewport({ width: 800, height: 450 });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !String(m.location().url).includes('favicon')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('favicon')) errors.push('HTTP ' + r.status() + ' ' + r.url());
  });
  await page.goto('http://localhost:18000', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction("document.getElementById('loader').style.display === 'none'", { timeout: 180000 });
  await page.waitForFunction(
    "window.__scene && window.__scene.children.some((o) => o.isInstancedMesh)",
    { timeout: 30000 }
  );
  await sleep(1000);

  const stats = await page.evaluate(() => {
    const s = window.__scene;
    let meshes = 0, tri = 0;
    const counts = [];
    for (const o of s.children) {
      if (o.isInstancedMesh) counts.push(o.count);
      o.traverse((c) => {
        if (!c.isMesh && !c.isInstancedMesh) return;
        meshes++;
        const g = c.geometry;
        const t = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        tri += c.isInstancedMesh ? t * c.count : t;
      });
    }
    // room-count via prop group children (cobwebs + crates/barrels are Groups of meshes)
    let groups = 0;
    for (const o of s.children) if (o.isGroup) { o.children[0] && o.children[0].isMesh && groups++; }
    return { counts: counts.sort((a, b) => a - b), meshes, tri: Math.round(tri), groups };
  });

  const fail = (msg) => { errors.push(msg); };
  const wantCounts = [...[...panelCounts.values()].flatMap(n => [n, n, n]), ex.w * ex.h, ex.door, ex.door, ex.door].sort((a, b) => a - b);
  const got = JSON.stringify(stats.counts);
  const want = JSON.stringify(wantCounts);
  if (got === want) console.log('instanced counts OK:', got);
  else fail(`instanced counts mismatch got=${got} want=${want}`);
  console.log('scene: meshes=' + stats.meshes, 'tris=' + stats.tri, 'prop groups=' + stats.groups);
  if (stats.groups < 60) fail('expected 60+ prop groups (cobwebs/crates/barrels), got ' + stats.groups);

  const shot = async (name) => {
    await page.screenshot({ path: `${DIR}/${name}.png` });
    console.log('shot', name);
  };
  await shot('dungeon_start');
  for (let i = 0; i < 2; i++) { await page.keyboard.press('d'); await sleep(450); }
  for (let i = 0; i < 4; i++) { await page.keyboard.press('w'); await sleep(340); }
  await sleep(700);
  await shot('dungeon_walked');
  await browser.close();

  if (errors.length) {
    console.error('FAIL:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('ALL PASS');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
