const TEX_PX = 128;

function seededRnd(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) + 1e-9;
}

function hashStone(n, seed) {
  let x = (Math.imul(n, 374761393) + Math.imul(seed, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
}

function makePerlin(rand) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const mix = (a, b, t) => a + t * (b - a);
  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  };
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const X = xi & 255, Y = yi & 255;
    x -= xi; y -= yi;
    const u = fade(x), v = fade(y);
    const aa = perm[perm[X + Y]], ab = perm[perm[X + Y + 1]];
    const ba = perm[perm[X + 1 + Y]], bb = perm[perm[X + 1 + Y + 1]];
    return mix(mix(grad(aa, x, y), grad(ba, x - 1, y), u),
               mix(grad(ab, x, y - 1), grad(bb, x - 1, y - 1), u), v) * 1.4;
  };
}

function makeFbm(perlin) {
  return (x, y, oct) => {
    let a = 0, amp = 1, f = 1, n = 0;
    for (let i = 0; i < oct; i++) {
      a += amp * perlin(x * f, y * f);
      n += amp; amp *= 0.5; f *= 2;
    }
    return a / n;
  };
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function toCanvas(fn) {
  const c = document.createElement("canvas");
  c.width = c.height = TEX_PX;
  const g = c.getContext("2d");
  const img = g.createImageData(TEX_PX, TEX_PX);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < TEX_PX; y++)
    for (let x = 0; x < TEX_PX; x++, i += 4) {
      const px = fn(x, y);
      d[i] = px[0]; d[i + 1] = px[1]; d[i + 2] = px[2]; d[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

export function wallStone(seed) {
  const perlin = makePerlin(seededRnd(seed));
  const fbm = makeFbm(perlin);
  return toCanvas((x, y) => {
    const row = (y >> 4) & 7;
    const ph = (row & 1) ? 32 : 0;
    const iy = y & 15;
    const ix = (x + ph) & 127;
    if (iy < 2 || (ix & 63) < 2) {
      const n = fbm(x * 0.3 + 31, y * 0.3 + 7, 2) * 5;
      const v = 21 + n;
      return [clamp8(v + 4), clamp8(v + 1), clamp8(v + 5)];
    }
    const blk = (ix >> 6) + row * 2;
    const base = 46 + hashStone(blk, seed) * 34;
    const hue = (hashStone(blk * 7 + 3, seed) - 0.5) * 16;
    const jx = ix & 63;
    const w = fbm(iy * 0.05 + 12.7, jx * 0.05 + blk * 0.31, 2);
    const gy = fbm((jx + w * 9) * 0.13, (iy + w * 9) * 0.13 + blk * 31.7, 4);
    const mottle = fbm(jx * 0.047 + 3.1, iy * 0.047 + 8.8 + blk * 7.9, 3);
    let v = base + gy * 17 + mottle * 10 + fbm(jx * 0.6 + blk * 11.3, iy * 0.6 - 5.1, 2) * 6;
    const pit = fbm(jx * 0.9 + 55.5, iy * 0.9 - 22.2 + blk * 4.4, 2);
    if (pit < -0.42) v += (pit + 0.42) * 95;
    const dx = Math.min(jx - 1, 64 - jx);
    const dy = Math.min(iy - 1, 16 - iy);
    const edge = Math.min(1, dx / 10, dy / 4);
    const k = 0.52 + 0.48 * edge * edge;
    return [clamp8((v + 5 + hue) * k), clamp8((v + 2 + hue * 0.45) * k), clamp8((v + 6 - hue * 0.25) * k)];
  });
}

export function floorStone(seed) {
  const perlin = makePerlin(seededRnd(seed));
  const fbm = makeFbm(perlin);
  return toCanvas((x, y) => {
    const row = (y >> 6) & 1;
    const ph = (row ? 32 : 0);
    const iy = y & 63;
    const ix = (x + ph) & 127;
    const mort = iy < 2 || (ix & 63) < 2;
    let v, r, g, b;
    if (mort) {
      const n = fbm(x * 0.3 + 41, y * 0.3 + 3, 2) * 5;
      v = 19 + n;
      r = 4; g = 1; b = 4;
    } else {
      const blk = (ix >> 6) + row * 2;
      const base = 34 + hashStone(blk + 131, seed) * 28;
      const hue = (hashStone(blk * 5 + 47, seed) - 0.5) * 12;
      const jx = ix & 63;
      const w = fbm(jx * 0.06 + 19.4, iy * 0.06 + blk * 0.29, 2);
      const gy = fbm((jx + w * 10) * 0.11, (iy + w * 10) * 0.11 + blk * 27.3, 4);
      const mottle = fbm(jx * 0.041 + 6.2, iy * 0.041 + 1.7 + blk * 5.4, 3);
      v = base + gy * 15 + mottle * 9 + fbm(jx * 0.51 + blk * 8.2, iy * 0.51 + 3.9, 2) * 6;
      const pit = fbm(jx * 0.85 + 13.3, iy * 0.85 - 41.1 + blk * 6.6, 2);
      if (pit < -0.45) v += (pit + 0.45) * 90;
      const de = Math.min(jx - 1, 64 - jx, iy - 1, 64 - iy);
      const edge = Math.min(1, de / 14);
      v *= 0.58 + 0.42 * edge * edge;
      r = 4 + hue; g = 1 + hue * 0.45; b = 4 - hue * 0.25;
    }
    const rk = Math.abs(fbm(x * (6 / 128) + seed * 0.61, y * (6 / 128) - seed * 0.37, 3));
    const crackT = 0.033;
    if (rk < crackT) v -= (crackT - rk) * 700;
    if (!mort && hashStone(x * 977 + y * 131, seed) < 0.012) v -= 16;
    return [clamp8(v + r), clamp8(v + g), clamp8(v + b)];
  });
}

export function ceilStone(seed) {
  const perlin = makePerlin(seededRnd(seed));
  const fbm = makeFbm(perlin);
  return toCanvas((x, y) => {
    const patch = (x >> 6) * 2 + (y >> 6);
    const tone = (hashStone(patch * 13 + 29, seed) - 0.5) * 16;
    const big = fbm(x * (3 / 128) + 9.7, y * (3 / 128) + 31.1, 3) * 9;
    const w = fbm(x * (5 / 128) + 3.3, y * (5 / 128) + 7.7, 2);
    const grain = fbm((x + w * 11) * (11 / 128), (y + w * 11) * (11 / 128), 4) * 12;
    const fine = fbm(x * (115 / 128) + 31.3, y * (115 / 128) - 17.9, 2) * 5;
    const v = 29 + tone + big + grain + fine;
    const rim = Math.abs(fbm(x * (4 / 128) - 5.2, y * (4 / 128) + 12.6, 3));
    const r2 = rim < 0.05 ? (0.05 - rim) * 300 : 0;
    return [clamp8(v + 5 - r2), clamp8(v + 2 - r2), clamp8(v + 6 - r2)];
  });
}
