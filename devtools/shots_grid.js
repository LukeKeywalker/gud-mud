const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const fs = require('fs');
const DIR = '/Users/user/Projects/llm-benchmarks/qwen3.8-27b/mud/devtools/shots';
const FILES = process.argv.slice(2);

(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  for (const f of FILES) {
    const b64 = fs.readFileSync(`${DIR}/${f}`).toString('base64');
    const grid = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      const W = 60, H = 34;
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const chars = ' .:-=+*#%@';
      let out = '';
      for (let y = 0; y < H; y++) {
        let row = '';
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const lum = (0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2]) / 255;
          row += chars[Math.min(9, Math.floor(lum * 10))];
        }
        out += row + '\n';
      }
      // stats
      let sum = 0, min = 255, max = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2];
        sum += l; if (l < min) min = l; if (l > max) max = l;
      }
      out += `MEAN=${(sum / (W * H)).toFixed(1)} MIN=${min} MAX=${max}\n`;
      return out;
    }, b64);
    console.log(`===== ${f} =====`);
    console.log(grid);
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
