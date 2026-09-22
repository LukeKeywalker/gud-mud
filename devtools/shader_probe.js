"use strict";
// Renders the LIVE post shader (window.__mud.mat) on synthetic vertical
// stripes with forced blur uniforms and reports laplacian energy per case:
// sharp (0,0,0), rotation (x only), strafe shift (y only), both. Rotation
// must drop BOTH channels diagonally... i.e. L_h and L_v; a horizontal shift
// drops L_h only. This isolates shader math from game timing/capture noise.
const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const URL = process.argv[2] || 'http://localhost:18000';

function lapsOf(img) {
  const W = img.w, H = img.h, px = img.px;
  let hE = 0, vE = 0, n = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      hE += Math.abs(px[i + 4 + c] - 2 * px[i + c] + px[i - 4 + c]);
      vE += Math.abs(px[i + W * 4 + c] - 2 * px[i + c] + px[i - W * 4 + c]);
    }
    n += 3;
  }
  return { h: hE / n, v: vE / n };
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.setItem('mudName', 'shadprobe'));
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => { const l = document.getElementById('loader'); return l && l.style.display === 'none'; }, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 2000));
  const out = await page.evaluate(() => {
    const PRE_VS = ['#version 300 es', 'precision mediump sampler2DArray;', '#define attribute in', '#define varying out', '#define texture2D texture'].join('\n') + '\n';
    const PRE_FS = ['precision mediump sampler2DArray;', '#define varying in', 'layout(location = 0) out highp vec4 pc_fragColor;', '#define gl_FragColor pc_fragColor', '#define texture2D texture'].join('\n') + '\n';
    const VS = 'attribute vec3 position; attribute vec2 uv; varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const mat = window.__mud && window.__mud.mat;
    if (!mat) return { err: 'no mat' };
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { err: 'no webgl2' };
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return { err: 'compile: ' + gl.getShaderInfoLog(s) };
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, PRE_VS + VS);
    if (vs.err) return vs;
    const fs = mk(gl.FRAGMENT_SHADER, '#version 300 es\n' + PRE_FS + mat.fragmentShader);
    if (fs.err) return fs;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { err: 'link: ' + gl.getProgramInfoLog(prog) };
    gl.useProgram(prog);
    const W = 256, H = 192;
    const c = document.createElement('canvas'); c.width = W; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, 64); g.fillStyle = '#000';
    for (let i = 0; i < 8; i++) g.fillRect(i * 32, 0, 16, 64);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'exposure'), mat.uniforms.exposure.value);
    gl.uniform1f(gl.getUniformLocation(prog, 'aspect'), W / H);
    gl.uniform1f(gl.getUniformLocation(prog, 'fisheye'), 0.05);
    gl.uniform1f(gl.getUniformLocation(prog, 'cover'), 0.7);
    const ub = gl.getUniformLocation(prog, 'blur');
    const b1 = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b1);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    const b2 = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b2);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 2, 0, 0, 2]), gl.STATIC_DRAW);
    const aUv = gl.getAttribLocation(prog, 'uv');
    gl.enableVertexAttribArray(aUv); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, W, H);
    const grab = (b) => {
      gl.uniform3f(ub, b[0], b[1], b[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { w: W, h: H, px: Array.from(px) };
    };
    return { sharp: grab([0, 0, 0]), rot: grab([0.246, 0, 0]), shift: grab([0, 0.026, 0]), both: grab([0.02, 0.026, 0]) };
  });
  if (out && out.err) { console.log('ERR', out.err); await browser.close(); process.exit(1); }
  for (const k of Object.keys(out)) {
    const e = lapsOf(out[k]);
    console.log(k + '\t L_h=' + e.h.toFixed(3) + ' L_v=' + e.v.toFixed(3));
  }
  await browser.close();
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
