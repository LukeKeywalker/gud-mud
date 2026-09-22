import * as THREE from './three.module.js';

// Small, self-contained low-poly asset. Origin is the handle grip;
// dimensions are metres. The flame socket also carries the real point light.
export function createTorchViewModel() {
  const root = new THREE.Group();
  root.name = 'held-torch';
  const wood = new THREE.MeshLambertMaterial({ color: 0x58341d });
  const grain = new THREE.MeshLambertMaterial({ color: 0x2c1a12 });
  const iron = new THREE.MeshLambertMaterial({ color: 0x373039 });
  const cloth = new THREE.MeshLambertMaterial({ color: 0x88734c });
  const add = (geometry, material, x, y, z, parent = root) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    // Like the sword, the near-camera torch cannot shadow its own light.
    mesh.castShadow = mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  };
  add(new THREE.CylinderGeometry(0.027, 0.021, 0.53, 7), wood, 0, 0.075, 0);
  // Raised grain strips and a charred crown keep the handle legible at 320px.
  for (const x of [-0.012, 0.009])
    add(new THREE.BoxGeometry(0.004, 0.28, 0.003), grain, x, 0.12, 0.024);
  add(new THREE.CylinderGeometry(0.055, 0.039, 0.13, 7), cloth, 0, 0.34, 0);
  for (const y of [0.29, 0.325, 0.36, 0.395]) {
    const wrap = add(new THREE.CylinderGeometry(0.055, 0.053, 0.019, 7), y === 0.395 ? grain : cloth, 0, y, 0);
    wrap.rotation.z = y === 0.395 ? 0 : 0.1;
  }
  for (const y of [0.265, 0.375])
    add(new THREE.CylinderGeometry(0.058, 0.058, 0.024, 7), iron, 0, y, 0);

  const flameSocket = new THREE.Group();
  flameSocket.name = 'torch-flame-socket';
  flameSocket.position.y = 0.41;
  root.add(flameSocket);
  const flame = new THREE.Group();
  flame.name = 'torch-flame';
  flameSocket.add(flame);
  const flameGeometry = () => {
    const pos = [], idx = [];
    const rings = [[0, 0.024, 0], [0.065, 0.05, -0.008], [0.14, 0.028, 0.012], [0.245, 0.001, -0.018]];
    rings.forEach(([y, r, dx]) => {
      for (let j = 0; j < 7; j++) {
        const a = j / 7 * Math.PI * 2;
        pos.push(dx + Math.cos(a) * r, y, Math.sin(a) * r);
      }
    });
    for (let ring = 0; ring < rings.length - 1; ring++)
      for (let j = 0; j < 7; j++) {
        const a = ring * 7 + j, b = ring * 7 + (j + 1) % 7;
        idx.push(a, b, a + 7, b, b + 7, a + 7);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  };
  const geo = flameGeometry();
  const fire = color => new THREE.MeshBasicMaterial({ color: color.multiplyScalar(0.7), side: THREE.DoubleSide });
  add(geo, fire(new THREE.Color(3.5, 0.45, 0.015)), 0, 0, 0, flame);
  const inner = add(geo, fire(new THREE.Color(4, 1.9, 0.12)), 0.005, 0.005, 0.032, flame);
  inner.scale.set(0.6, 0.74, 0.6);
  const core = add(geo, fire(new THREE.Color(5, 3.8, 1.3)), 0.003, 0.008, 0.053, flame);
  core.scale.set(0.32, 0.43, 0.32);

  return {
    root, flameSocket,
    updateFlame(now, flicker) {
      const t = now * 0.001;
      flame.scale.set(1 + 0.07 * Math.sin(t * 8.3), 1 + flicker * 0.24, 1);
      flame.rotation.z = 0.055 * Math.sin(t * 6.1) + 0.025 * Math.sin(t * 11.3);
    }
  };
}
