// Probe: drives a headless client against a live server, screenshots the
// view while turning in place and after walking into a wall, to inspect
// doorway rendering. Usage: node devtools/shots_doors.js
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
  for (let i = 0; i < 4; i++) {
    await shot('door_dir' + i);
    await page.keyboard.press('KeyD');
  }
  await page.keyboard.down('KeyW');
  await sleep(4000);
  await page.keyboard.up('KeyW');
  await sleep(500);
  for (let i = 0; i < 4; i++) {
    await shot('door_wall' + i);
    await page.keyboard.press('KeyD');
  }
  console.log('PAGE ERRORS:', errors.length ? errors.join(' | ') : 'none');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
