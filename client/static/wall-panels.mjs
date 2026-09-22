import { ShapeUtils, Vector2 } from './three.module.js';

// Join solid cells into straight runs so large wall panels never cross a door.
export function wallRuns(codes, width, height) {
  const used = new Uint8Array(width * height);
  const solid = (x, z) => x >= 0 && z >= 0 && x < width && z < height
    && codes[z * width + x] === 0 && !used[z * width + x];
  const runs = [];
  const take = (x, z, dx, dz) => {
    let length = 0;
    while (solid(x + dx * length, z + dz * length)) {
      used[(z + dz * length) * width + x + dx * length] = 1;
      length++;
    }
    runs.push({ x, z, dx, dz, length });
  };
  // Horizontal junctions own their corner cell; vertical runs meet their sides.
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++)
      if (solid(x, z) && solid(x + 1, z)) take(x, z, 1, 0);
  for (let z = 0; z < height; z++)
    for (let x = 0; x < width; x++)
      if (solid(x, z)) take(x, z, 0, 1);
  return runs;
}

// Thin walls meet at cell centres. Extend run ends into perpendicular walls
// instead of leaving a gap between the cell edge and the recessed wall face.
export function wallPanels(codes, width, height, panelTiles = 3) {
  const solid = (x, z) => x >= 0 && z >= 0 && x < width && z < height
    && codes[z * width + x] === 0;
  const panels = [];
  for (const run of wallRuns(codes, width, height)) {
    const start = solid(run.x - run.dx, run.z - run.dz) ? 0.5 : 0;
    const end = solid(run.x + run.dx * run.length, run.z + run.dz * run.length) ? 0.5 : 0;
    const length = run.length + start + end;
    for (let offset = 0; offset < length; offset += panelTiles) {
      const span = Math.min(panelTiles, length - offset);
      const center = offset - start + (span - 1) / 2;
      panels.push({
        x: run.x + run.dx * center + 0.5,
        z: run.z + run.dz * center + 0.5,
        width: span, vertical: run.dz === 1,
      });
    }
  }
  return panels;
}

// Close each stone exposed by a cut. Weld across material seams before tracing
// contours: a stone's face and bevel can belong to different material parts.
function capWallCut(parts, cut) {
  const key = v => v.map(value => Math.round(value * 1e6)).join(',');
  const edges = new Map();
  parts.forEach((part, material) => {
    for (let i = 0; i < part.idx.length; i += 3) {
      const triangle = part.idx.slice(i, i + 3).map(j => part.pos.slice(j * 3, j * 3 + 3));
      for (let j = 0; j < 3; j++) {
        const a = triangle[j], b = triangle[(j + 1) % 3];
        if (Math.abs(a[0] - cut) > 1e-8 || Math.abs(b[0] - cut) > 1e-8) continue;
        const ka = key(a), kb = key(b);
        if (ka === kb) continue;
        const edgeKey = [ka, kb].sort().join('/');
        const existing = edges.get(edgeKey);
        if (existing) existing.count++;
        else edges.set(edgeKey, { a, b, ka, kb, material, count: 1 });
      }
    }
  });
  const adjacency = new Map();
  for (const edge of edges.values()) {
    if (edge.count !== 1) continue;
    for (const k of [edge.ka, edge.kb]) {
      if (!adjacency.has(k)) adjacency.set(k, []);
      adjacency.get(k).push(edge);
    }
  }
  const used = new Set();
  for (const first of edges.values()) {
    if (first.count !== 1 || used.has(first)) continue;
    const contour = [];
    let edge = first, k = first.ka, material = first.material, longest = 0;
    do {
      // Open source surfaces do not define a solid cross-section to cap.
      if (adjacency.get(k)?.length !== 2 || used.has(edge)) break;
      used.add(edge);
      contour.push(edge.ka === k ? edge.a : edge.b);
      const length = Math.hypot(edge.a[1] - edge.b[1], edge.a[2] - edge.b[2]);
      if (length > longest) { longest = length; material = edge.material; }
      k = edge.ka === k ? edge.kb : edge.ka;
      edge = adjacency.get(k)?.find(candidate => !used.has(candidate));
    } while (k !== first.ka && edge);
    if (k !== first.ka || contour.length < 3) continue;
    const points = contour.map(v => new Vector2(v[1], v[2]));
    const part = parts[material];
    for (const face of ShapeUtils.triangulateShape(points, [])) {
      const vertices = face.map(i => contour[i]);
      const [a, b, c] = vertices;
      // The retained half-space is x <= cut, so the cap faces toward +X.
      const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      if (Math.abs(nx) < 1e-12) continue;
      if (nx < 0) vertices.reverse();
      for (const v of vertices) {
        part.idx.push(part.pos.length / 3);
        part.pos.push(cut, v[1], v[2]);
        part.nrm.push(1, 0, 0);
      }
    }
  }
}

// Clip the right-hand edge, preserving stone size and the original normals.
// Seal the cut because bevelled jambs and adjoining panels do not fully cover it.
export function cropWallPanel(asset, width, fullWidth) {
  if (width === fullWidth) return asset;
  const cut = -fullWidth / 2 + width;
  const shift = (fullWidth - width) / 2;
  const parts = asset.parts.map(part => {
    const pos = [], nrm = [], idx = [];
    const vertex = i => [...part.pos.slice(i * 3, i * 3 + 3), ...part.nrm.slice(i * 3, i * 3 + 3)];
    const indices = part.idx?.length ? part.idx : Array.from({ length: part.pos.length / 3 }, (_, i) => i);
    for (let i = 0; i < indices.length; i += 3) {
      const input = indices.slice(i, i + 3).map(vertex);
      const polygon = [];
      for (let j = 0; j < input.length; j++) {
        const a = input[j], b = input[(j + 1) % input.length];
        const insideA = a[0] <= cut, insideB = b[0] <= cut;
        if (insideA) polygon.push(a);
        if (insideA !== insideB) {
          const t = (cut - a[0]) / (b[0] - a[0]);
          polygon.push(a.map((v, k) => v + (b[k] - v) * t));
        }
      }
      for (let j = 1; j + 1 < polygon.length; j++) {
        for (const v of [polygon[0], polygon[j], polygon[j + 1]]) {
          idx.push(pos.length / 3);
          pos.push(v[0] + shift, v[1], v[2]);
          const length = Math.hypot(v[3], v[4], v[5]) || 1;
          nrm.push(v[3] / length, v[4] / length, v[5] / length);
        }
      }
    }
    return { ...part, pos, nrm, idx };
  });
  capWallCut(parts, width / 2);
  return { parts };
}
