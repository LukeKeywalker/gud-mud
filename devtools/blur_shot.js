const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const path = require('path');
const DIR = path.join(__dirname, 'shots');
const URL = process.argv[2] || 'http://localhost:18000';
const NAME = process.argv[3] || 'blurbot';

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
  const canvas = await page.$('#c');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { await canvas.screenshot({ path: `${DIR}/${name}` }); console.log('wrote', name); };
  await shot('blur_idle.png');
  await page.keyboard.press('a');
  await sleep(40);
  await shot('blur_turn_1.png');
  await sleep(50);
  await shot('blur_turn_2.png');
  await sleep(700);
  await page.keyboard.down('e');
  await sleep(110);
  await shot('blur_strafe_1.png');
  await sleep(80);
  await shot('blur_strafe_2.png');
  await page.keyboard.up('e');
  await sleep(900);
  await shot('blur_after.png');
  console.log(errors.length ? errors.slice(0, 8).join('\n') : 'NO_PAGE_ERRORS');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
