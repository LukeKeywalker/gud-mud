import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../client/static/three.module.js';
import { wallRuns, wallPanels, cropWallPanel } from '../client/static/wall-panels.mjs';

test('straight runs cover every solid cell exactly once without crossing doors', () => {
  const maps = [
    ['###', '#.#', '###'],
    ['.#.', '###', '.#.'],
    ['#..', '.#.', '..#'],
    fs.readFileSync(new URL('../maps/starter.txt', import.meta.url), 'utf8').trim().split('\n'),
  ];
  for (const rows of maps) {
    const w = rows[0].length, h = rows.length;
    const codes = [...rows.join('')].map(c => c === '#' ? 0 : 1);
    const coverage = new Uint8Array(codes.length);
    for (const { x, z, dx, dz, length } of wallRuns(codes, w, h))
      for (let i = 0; i < length; i++) coverage[(z + dz * i) * w + x + dx * i]++;
    assert.deepEqual([...coverage], codes.map(c => c === 0 ? 1 : 0));
  }
});

test('cropping preserves triangle coverage, winding and stone scale', () => {
  const asset = { parts: [{ pos: [-1.5, 0, 0, 1.5, 0, 0, -1.5, 3, 0], nrm: [0, 0, 1, 0, 0, 1, 0, 0, 1], idx: [0, 1, 2] }] };
  const cropped = cropWallPanel(asset, 1, 3).parts[0];
  let area = 0;
  for (let i = 0; i < cropped.pos.length; i += 9) {
    const [ax, ay, , bx, by, , cx, cy] = cropped.pos.slice(i, i + 9);
    area += ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  assert.equal(area, 2.5);
  assert.equal(Math.min(...cropped.pos.filter((_, i) => i % 3 === 0)), -0.5);
  assert.equal(Math.max(...cropped.pos.filter((_, i) => i % 3 === 0)), 0.5);
  assert.equal(Math.max(...cropped.pos.filter((_, i) => i % 3 === 1)), 3);
  assert.equal(cropWallPanel(asset, 3, 3), asset);
});

test('thin wall ends meet perpendicular wall centres but stop at doors', () => {
  const panels = wallPanels([
    0, 0, 0,
    0, 1, 0,
    0, 0, 0,
  ], 3, 3);
  const vertical = panels.filter(p => p.vertical);
  assert.equal(vertical.length, 2);
  for (const p of vertical) {
    assert.equal(p.z - p.width / 2, 0.5);
    assert.equal(p.z + p.width / 2, 2.5);
  }
  const doorway = wallPanels([0, 0, 21, 0, 0], 1, 5);
  assert.equal(doorway[0].z + doorway[0].width / 2, 2);
  assert.equal(doorway[1].z - doorway[1].width / 2, 3);
});

test('real wall variants stay inside their reserved footprint with unit normals', () => {
  const asset = JSON.parse(fs.readFileSync(new URL('../client/static/assets/wall.json', import.meta.url)));
  for (const width of [0.5, 1, 1.5, 2, 2.5, 3]) {
    const cropped = cropWallPanel(asset, width, 3);
    assert.ok(cropped.parts.some(part => part.idx.length > 0));
    for (const part of cropped.parts) {
      for (let i = 0; i < part.pos.length; i += 3) {
        const [x, y, z] = part.pos.slice(i, i + 3);
        assert.ok(x >= -width / 2 && x <= width / 2);
        assert.ok(y >= 0 && y <= 3);
        assert.ok(z >= -0.33 && z <= 0.33);
        assert.ok(Math.abs(Math.hypot(...part.nrm.slice(i, i + 3)) - 1) < 0.00002);
      }
    }
  }
});

function panelMesh(asset) {
  const group = new THREE.Group();
  for (const part of asset.parts) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
    geometry.setIndex(part.idx);
    group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  }
  group.updateMatrixWorld(true);
  return group;
}

test('cropped solid remains opaque from the cut side and oblique angles across material seams', () => {
  const box = new THREE.BoxGeometry(3, 3, 0.66).toNonIndexed();
  box.translate(0, 1.5, 0);
  // Separate the six faces into material parts, as in the imported stones.
  const asset = { parts: box.groups.map(({ start, count }) => ({
    pos: [...box.attributes.position.array.slice(start * 3, (start + count) * 3)],
    nrm: [...box.attributes.normal.array.slice(start * 3, (start + count) * 3)],
    idx: Array.from({ length: count }, (_, i) => i),
  })) };
  const original = JSON.stringify(asset);
  const mesh = panelMesh(cropWallPanel(asset, 1, 3));
  for (const direction of [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(-1, 0.2, 0.15).normalize()]) {
    const target = new THREE.Vector3(0.5, 1.5, 0);
    const origin = target.clone().addScaledVector(direction, -2);
    const hits = new THREE.Raycaster(origin, direction).intersectObject(mesh);
    assert.ok(hits.length > 0, 'the exposed end must have a front-facing surface');
    assert.ok(hits[0].point.distanceTo(target) < 1e-6);
    assert.ok(hits[0].face.normal.x > 0.999);
  }
  assert.equal(JSON.stringify(asset), original, 'cropping must not mutate the cached source');
});

test('real cropped stones have caps covering every exposed boundary edge', () => {
  const asset = JSON.parse(fs.readFileSync(new URL('../client/static/assets/wall.json', import.meta.url)));
  let checked = 0;
  for (const width of [0.5, 1, 1.5, 2, 2.5]) {
    const cropped = cropWallPanel(asset, width, 3);
    const mesh = panelMesh(cropped);
    for (const part of cropped.parts) {
      for (let i = 0; i < part.idx.length; i += 3) {
        const ids = part.idx.slice(i, i + 3);
        const points = ids.map(j => new THREE.Vector3().fromArray(part.pos, j * 3));
        if (ids.every(j => part.nrm[j * 3] === 1)) continue; // newly added caps
        for (let j = 0; j < 3; j++) {
          const a = points[j], b = points[(j + 1) % 3];
          if (Math.abs(a.x - width / 2) > 1e-8 || Math.abs(b.x - width / 2) > 1e-8 || a.distanceTo(b) < 1e-6) continue;
          // Sample just inside the cut edge, toward the stone's interior.
          const target = a.clone().add(b).multiplyScalar(0.5);
          const normal = new THREE.Vector3().fromArray(part.nrm, ids[j] * 3);
          target.y -= normal.y * 1e-5;
          target.z -= normal.z * 1e-5;
          const origin = target.clone(); origin.x += 0.01;
          const hits = new THREE.Raycaster(origin, new THREE.Vector3(-1, 0, 0)).intersectObject(mesh);
          assert.ok(hits.some(hit => Math.abs(hit.point.x - width / 2) < 1e-6), `unsealed cut on width ${width} at ${target.toArray()}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 400);
});
