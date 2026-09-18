const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'shots');
const TEXGEN = path.join(__dirname, '..', 'client', 'static', 'texgen.js');
const SEEDS = { wallStone: 7, floorStone: 21, ceilStone: 5 };

(async () => {
  const src = fs.readFileSync(TEXGEN, 'utf8');
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<html><body style="margin:0;background:#fff"></body></html>');
  await page.evaluate((code) => {
    const factory = new Function(code.replace(/^export /gm, '') + '\nreturn { wallStone, floorStone, ceilStone };');
    window.__tex = factory();
  }, src);
  const out = await page.evaluate((seeds) => {
    const t = window.__tex;
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const raw = {};
    for (const k of Object.keys(t)) raw[k] = t[k](seeds[k]);
    const RAMP = ' .,:;irsxu/ach|]muck$?@*';
    const ascii = (cv) => {
      const g = cv.getContext('2d');
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const W = cv.width, H = cv.height;
      let sum = 0, min = 255, max = 0;
      let s = '';
      for (let y = 0; y < H; y += 2) {
        let row = '';
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          sum += l; if (l < min) min = l; if (l > max) max = l;
          row += RAMP[Math.min(RAMP.length - 1, Math.floor((1 - l / 255) * RAMP.length))];
        }
        s += row + '\n';
      }
      return s + `MEAN=${(sum / (W * (H / 2))).toFixed(1)} MIN=${min} MAX=${max}\n`;
    };
    const tile = (cv, n) => {
      const c = mk(128 * n, 128 * n);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g.drawImage(cv, x * 128, y * 128);
      return c.toDataURL();
    };
    const face = (cv) => {
      const c = mk(128, 384);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(cv, 0, 0, 128, 384);
      return c.toDataURL();
    };
    const ok =
      t.wallStone(seeds.wallStone).toDataURL() === raw.wallStone.toDataURL() &&
      t.floorStone(seeds.floorStone).toDataURL() === raw.floorStone.toDataURL() &&
      t.ceilStone(seeds.ceilStone).toDataURL() === raw.ceilStone.toDataURL();
    return {
      det: ok,
      ascii: {
        wall: ascii(raw.wallStone),
        floor: ascii(raw.floorStone),
        ceil: ascii(raw.ceilStone),
      },
      shots: {
        'stone_wall_1x.png': raw.wallStone.toDataURL(),
        'stone_wall_face.png': face(raw.wallStone),
        'stone_wall_tile.png': tile(raw.wallStone, 4),
        'stone_floor_1x.png': raw.floorStone.toDataURL(),
        'stone_floor_tile.png': tile(raw.floorStone, 4),
        'stone_ceil_1x.png': raw.ceilStone.toDataURL(),
        'stone_ceil_tile.png': tile(raw.ceilStone, 4),
      },
    };
  }, SEEDS);
  console.log('DETERMINISM=' + (out.det ? 'OK' : 'FAIL'));
  for (const [k, s] of Object.entries(out.ascii)) {
    console.log(`===== ${k} =====`);
    console.log(s.trimEnd());
  }
  for (const [name, url] of Object.entries(out.shots)) {
    fs.writeFileSync(path.join(DIR, name), Buffer.from(url.split(',')[1], 'base64'));
    console.log('wrote', name);
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
