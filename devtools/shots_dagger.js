// Probe: screenshots the first-person dagger viewmodel — idle pose and
// mid-swing frames (L triggers a random overhead/undercut swing).
// Usage: node devtools/shots_dagger.js
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
  page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
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
  await shot('dagger_idle');
  const grab = () => page.evaluate(() => {
    const s = window.__scene;
    const cam = s.children.find((c) => c.isPerspectiveCamera);
    const pivot = cam.children.find((c) => c.isGroup);
    const swing = pivot.children[0];
    let best = 1e9, tipX = 0, tipY = 0, meshes = 0, verts = 0;
    const meshList = [];
    swing.traverse((o) => { if (o.isMesh) meshList.push(o); });
    const inv = cam.matrixWorldInverse.elements;  // vertex -> camera frame
    for (const m of meshList) {
      meshes++;
      verts += m.geometry.attributes.position.count;
      const e = m.matrixWorld.elements;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const X = e[0]*x + e[4]*y + e[8]*z + e[12];
        const Y = e[1]*x + e[5]*y + e[9]*z + e[13];
        const Z = e[2]*x + e[6]*y + e[10]*z + e[14];
        const Zl = inv[2]*X + inv[6]*Y + inv[10]*Z + inv[14];
        if (Zl < best) {
          best = Zl;
          tipX = inv[0]*X + inv[4]*Y + inv[8]*Z + inv[12];
          tipY = inv[1]*X + inv[5]*Y + inv[9]*Z + inv[13];
        }
      }
    }
    return { meshes, verts, rx: +swing.rotation.x.toFixed(2), ry: +swing.rotation.y.toFixed(2), rz: +swing.rotation.z.toFixed(2), tip: { x: +tipX.toFixed(2), y: +tipY.toFixed(2), fwd: +(-best).toFixed(2) } };
  });
  console.log('VIEWMODEL IDLE:', JSON.stringify(await grab()));
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    await page.keyboard.press('KeyL');
    await sleep(90 + 8 * i);  // catch different points of the swing arc
    const mid = await grab();
    await shot(`dagger_swing_${i}`);
    console.log(`SWING_${i}:`, JSON.stringify(mid));
    await sleep(900 - (Date.now() - t0));  // let recover finish before the next
  }
  console.log('PAGE ERRORS:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
