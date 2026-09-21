// Probe: screenshots the rat/spider prop models in room A to inspect their
// look. Usage: node devtools/shots_enemies.js
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
  const assetStatus = {};
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/assets/')) assetStatus[u] = r.status();
    if (r.status() >= 400) console.log('HTTP', r.status(), u);
  });
  await page.goto('http://localhost:18000', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    "document.getElementById('loader').style.display === 'none'",
    { timeout: 120000 }
  );
  await sleep(3000);
  const shot = async (name) => {
    await sleep(700);
    await page.screenshot({ path: `${DIR}/${name}.png` });
    console.log('shot', name);
  };
  const turn8 = async (prefix) => {
    for (let i = 0; i < 4; i++) {
      await shot(`${prefix}_d${i}`);
      await page.keyboard.press('KeyD');
      await sleep(250);
    }
  };
  await turn8('enemy_spawn');
  await page.keyboard.down('KeyW');
  await sleep(2600);
  await page.keyboard.up('KeyW');
  await sleep(500);
  await turn8('enemy_south');
  const probe = await page.evaluate(() => {
    const s = window.__scene;
    if (!s) return { error: 'no scene handle' };
    const out = [];
    for (const o of s.children) {
      if (o.isGroup) {
        let verts = 0;
        const colors = new Set();
        o.traverse((c) => {
          if (c.isMesh) { verts += c.geometry.attributes.position.count; colors.add(c.material.color.getHexString()); }
        });
        out.push({ t: 'group', x: +o.position.x.toFixed(2), y: +o.position.y.toFixed(2), z: +o.position.z.toFixed(2), verts, scale: +o.scale.x.toFixed(2), colors: [...colors] });
      } else if (o.isMesh) {
        out.push({ t: 'mesh', x: +o.position.x.toFixed(2), y: +o.position.y.toFixed(2), z: +o.position.z.toFixed(2), verts: o.geometry.attributes.position ? o.geometry.attributes.position.count : null });
      }
    }
    return { children: s.children.length, objs: out };
  });
  const box = await page.evaluate(() => {
    const c = document.getElementById('c');
    return { css: c.style.width + 'x' + c.style.height, buf: c.width + 'x' + c.height, win: innerWidth + 'x' + innerHeight };
  });
  console.log('CANVAS:', JSON.stringify(box));
  console.log('SCENE PROBE:', JSON.stringify(probe, null, 1));
  console.log('ASSET STATUS:', JSON.stringify(assetStatus));
  console.log('PAGE ERRORS:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
