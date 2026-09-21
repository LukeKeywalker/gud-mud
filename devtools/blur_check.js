"use strict";
// Gradient-energy check for motion blur: decodes PNGs and reports mean
// horizontal/vertical pixel differences. Motion-blurred frames must show a
// clear energy drop (esp. horizontal channel) vs settled frames.
const fs = require("fs");
const zlib = require("zlib");

function decodePng(buf) {
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error("bitdepth " + depth);
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 0 ? 1 : null;
  if (!ch) throw new Error("colortype " + ctype);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  let r = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[r++];
    const row = raw.subarray(r, r + stride);
    r += stride;
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    const out = px.subarray(y * stride, (y + 1) * stride);
    if (f === 0 || f === 2 && !prev) out.set(row);
    else if (f === 1) for (let x = ch; x < stride; x++) out[x] = (row[x] + out[x - ch]) & 255;
    else if (f === 2) for (let x = 0; x < stride; x++) out[x] = (row[x] + prev[x]) & 255;
    else if (f === 3) for (let x = 0; x < stride; x++) out[x] = (row[x] + ((x >= ch ? out[x - ch] : 0) + prev[x]) >> 1) & 255;
    else if (f === 4) {
      let a = 0, b = prev ? prev[0] : 0, c = 0;
      for (let x = 0; x < stride; x++) {
        a = x >= ch ? out[x - ch] : 0;
        c = x >= ch && prev ? prev[x - ch] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[x] = (row[x] + pr) & 255;
        b = a;
      }
    } else throw new Error("filter " + f);
  }
  return { w, h, ch, px };
}

// Laplacian energy (2nd-order): blur-safe. Sum of |grad| is invariant to
// edge smearing (an edge gets wider, total variation conserved); the
// Laplacian mean falls as the smear widens. H = horizontal 2nd diff only
// (strafe signature), V vertical, Tboth.
function energy(img) {
  const { w, h, ch, px } = img;
  let hE = 0, vE = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * ch;
      for (let c = 0; c < ch; c++) {
        hE += Math.abs(px[i + ch + c] - 2 * px[i + c] + px[i - ch + c]);
        vE += Math.abs(px[(y + 1) * w * ch + x * ch + c] - 2 * px[i + c] + px[(y - 1) * w * ch + x * ch + c]);
      }
      n += ch;
    }
  }
  return { h: hE / n, v: vE / n };
}

const dir = process.argv[2] || "devtools/shots";
const files = process.argv.slice(3);
if (!files.length) {
  console.log("usage: node blur_check.js <dir> [files...]");
  process.exit(1);
}
for (const f of files) {
  const img = decodePng(fs.readFileSync(`${dir}/${f}`));
  const e = energy(img);
  console.log(`${f}\t${img.w}x${img.h}\tH=${e.h.toFixed(3)}\tV=${e.v.toFixed(3)}\tHV=${(e.h / e.v).toFixed(4)}`);
}
