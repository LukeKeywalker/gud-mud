const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const path = require('path');
const DIR = path.join(__dirname, 'shots');
const URL = process.argv[2] || 'http://localhost:18000';
const NAME = process.argv[3] || 'texbot';

(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.evaluateOnNewDocument((name) => localStorage.setItem('mudName', name), NAME);
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => { const l = document.getElementById('loader'); return l && l.style.display === 'none'; },
    { timeout: 90000 }
  );
  await new Promise((r) => setTimeout(r, 2500));
  const glOk = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  });
  console.log('WEBGL=' + (glOk ? 'OK' : 'MISSING'));
  const canvas = await page.$('#c');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { await canvas.screenshot({ path: `${DIR}/${name}` }); console.log('wrote', name); };
  await shot('tex_game_0.png');
  await page.keyboard.press('a');
  await sleep(700);
  await shot('tex_game_turn1.png');
  await page.keyboard.press('a');
  await sleep(700);
  await shot('tex_game_turn2.png');
  await page.keyboard.down('w');
  await sleep(180);
  await page.keyboard.up('w');
  await sleep(900);
  await shot('tex_game_step.png');
  console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NO_PAGE_ERRORS');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
