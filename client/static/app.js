import * as THREE from "./three.module.js";
import { wallStone, floorStone, ceilStone } from "./texgen.js";
import { wallPanels, cropWallPanel } from "./wall-panels.mjs";
import { createTorchViewModel } from "./torch-viewmodel.mjs";

const TICK_MS = 50;
const TILE_M = 1.0;
const WALL_H = 3.0;
const EYE_H = 1.6;
const RES_W = 320;
const RES_H = 256;
const DITHER = true;
const TORCH_INTENSITY = 22;
const PLAYER_TORCH_INTENSITY = 12;
const TORCH_DECAY = 1;  // gentler falloff spreads light without harsh nearby hotspots
const TORCH_SHADOW_SIZE = 1024;  // per cube face; crisp silhouettes at the 320x256 game resolution
const SHADOW_AMBIENT = 0.6;
const SHADOW_BOUNCE = 0.65;
const TONE_EXPOSURE = 1.0;
const TOON_STEPS = 3;   // cel-shading light bands
const FISHEYE_K = 0.05;
const BLUR_COVER = 0.7;  // fraction of the per-frame camera delta the taps span
const BLUR_REF_D = 3.0;  // reference view distance (m) for the strafe screen shift
const ROT_WIN = 1 / 60;  // rotation smear window (s)
const STRAFE_WIN = 2.5 / 60;  // strafe smear window (s)
const TAN_FOV = Math.tan((75 * Math.PI) / 360);
const STEP_MS = 260;  // step period; steps tween for the whole period so held movement chains without stops
const ARCH_R = 1.5;       // half the 3-tile doorway span
const ARCH_SPRING = 2.0;  // springline, ~2/3 of WALL_H
const ARCH_RISE = 0.8;    // elliptical crown rise (crown at 2.8)
const ARCH_EPS = 0.01;    // band inset, keeps faces off Z-coplanar wall/floor/ceiling
const TILE_DOOR = 21;
const TILE_ARCH = 22;
const ENEMY_SCALE = 2.25;  // asset base fits 0.8 m; 2.25x => ~1.8 m hulks
const SWORD2_SCALE = 0.85;  // asset box is 0.8 m; 0.85x => ~0.68 m sword2
const SWORD2_ARM = [0.34, -0.42, -0.55];  // right hand, near the lens
const SWORD2_GRIP = 0.16;  // grip pivot height above the pommel (m)
const SWORD2_IDLE = { x: -0.30, y: 0, z: -0.32 };  // raised guard, leaning out right, edge out
const SWORD2_SLOT_YAW = Math.PI / 2;  // slot rotated 90 deg about the weapon's length axis
const SWORD2_RECOVER_MS = 200;
const SWORD2_WAVE = { ax: 0.045, az: 0.055, fx: 0.9, fz: 0.63, py: 0.014 };  // idle sway
const TORCH_REST = [-0.31, -0.56, -0.60];  // floating viewmodel at the bottom left
const TORCH_SWAY = { x: 0.07, y: 0.035, z: 0.025 };  // metres, gentle hand movement
const SWORD2_STRIDE_DIP = 0.06;  // U-dip depth of the hilt per walking step
// diagonal overhead chops: hand path (pivot, camera space) + sword2 pose per phase.
// The raise stands the sword2 almost vertical in frame, tip near the top (frame is
// +/-37.5 deg from eye): a tall wind-up whose tip drops the longest arc, so the
// blade tip leads the chop.
const SWING_SEQS = [
  {  // upper right -> lower left
    keys: [
      { d: 250, e: "out",   p: [ 0.02, -0.06, -0.66], r: [ 0.06,  0,  0.08] },  // stand up, tip to the frame top
      { d: 160, e: "inout", p: [ 0.16, -0.13, -0.55], r: [ 0.15,  0, -0.50] },  // lean to the right shoulder, tip still high
      { d: 170, e: "in",    p: [-0.42, -0.50, -0.55], r: [-0.98,  0,  0.62] }   // chop across to lower left, tip leading
    ]
  },
  {  // upper left -> lower right
    keys: [
      { d: 250, e: "out",   p: [ 0.02, -0.06, -0.66], r: [ 0.06,  0, -0.08] },  // stand up, tip to the frame top
      { d: 160, e: "inout", p: [-0.16, -0.13, -0.55], r: [ 0.15,  0,  0.50] },  // lean to the left shoulder, tip still high
      { d: 170, e: "in",    p: [ 0.42, -0.50, -0.55], r: [-0.98,  0, -0.62] }   // chop across to lower right, tip leading
    ]
  }
];
const SWING_EASE = {
  out: t => 1 - Math.pow(1 - t, 3),
  inout: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  in: t => t * t * t
};
const WALK_BOB_AMP = 0.09;  // head-bob height per step, Doom-style
const WALK_NOD = 0.035;  // downward pitch at step apex (rad)
const LEAN_MAX = 0.08;  // strafe camera roll toward the lean side (rad)
const ROT_TWEEN_MS = 150;
const TAU = Math.PI * 2;
const FACE_DIRS = [[0, -1], [-1, 0], [0, 1], [1, 0]];
const INTERP_DELAY_MS = 250;
const GAP_SNAP_TICKS = 10;
const UNACK_LIMIT = 5;
const SNAP_TILES = 2;
const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const CORE_FILES = ["__init__.py", "constants.py", "world.py", "moves.py", "visibility.py", "protocol.py"];
const name = (localStorage.getItem("mudName") || "wanderer").slice(0, 24);
localStorage.setItem("mudName", name);

let pyodide, core, world, b64d;
let selfId = -1, seq = 0, localTick = 0, lastStateAt = 0, lastStateTick = 0, stateCount = 0;
let predPos = [0, 0], dispPos = [0, 0];
let yaw = 0, facing = 0, connected = 0;
const mv = { fw: 0, st: 0 };  // movement axes: forward/back, strafe left(-)/right(+)
let strafeOnset = false;  // next pure-strafe step plays the bob+tilt, then held strafe glides
let lastStepAt = -1e9;
let stepPending = null;
const moveTw = { on: false, t0: 0, fx: 0, fy: 0, tx: 0, ty: 0 };
const rotTw = { on: false, t0: 0, from: 0, to: 0 };
let prevYaw = 0, prevRoll = 0;
const pending = [];        // { seq, dx, dy }
const known = new Map();   // eid -> { x, y, room, yaw, color, name, ops: [{t,x,y,yaw}] }

let scene, camera, renderer, torch;
let torchViewModel;
let postRT, postCam, postScene, postMat;
let hullMat, rimMat;
let postOutlineOn = false;
const tex = {};
const enemyAssets = {};
const dungeonAssets = {};
const DUNGEON_ASSETS = {
  wall: "/assets/wall.json",
  floor: "/assets/floor.json",
  arch: "/assets/arch.json",
  cobweb: "/assets/cobweb.json",
  crate: "/assets/crate.json",
  barrel: "/assets/barrel.json"
};
let sword2Asset = null;
let sword2 = null;  // { swing: THREE.Group, pivot: THREE.Group, tw: { on, t0, seg, keys } }
let sword2DipPhase = 0, sword2DipDepth = 0, sword2DipClock = 0;  // continuous U, one per 2 steps
const groups = new Map();     // eid -> THREE.Group
let hudName, hudCount, loaderEl, dieEl;
let ws;

// ---------- boot ----------
async function bootCore(log, setProgress) {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX });
  log("Pyodide ready");
  setProgress(0.35);
  const srcs = {};
  let total = 0;
  for (const f of CORE_FILES) {
    const r = await fetch("/game_core/" + f);
    if (!r.ok) throw new Error("missing /game_core/" + f);
    srcs[f] = await r.text();
    total += srcs[f].length;
  }
  pyodide.FS.mkdirTree("/game_core");
  let done = 0;
  for (const f of CORE_FILES) {
    pyodide.FS.writeFile("/game_core/" + f, srcs[f]);
    done += srcs[f].length;
    setProgress(0.35 + 0.55 * (done / total));
  }
  log("game_core loaded into WASM FS");
  pyodide.runPython("import sys; sys.path.insert(0, '/'); import game_core.protocol, game_core.moves, game_core.world, game_core.visibility; import game_core; import base64; b64d = base64.b64decode");
  core = pyodide.globals.get("game_core");
  b64d = pyodide.globals.get("b64d");
  setProgress(0.9);
}

// ---------- scene ----------
function toonGradientMap(steps) {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) data[i] = Math.round((i / (steps - 1)) * 255);
  const t = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

const toonMap = toonGradientMap(TOON_STEPS);

const OUTLINE_STEPS = [0.01, 0.03, 0.06, 0.12, 0.24, 0.5];  // expansion depth (m, asset space); V cycles
let outlineStep = 2;
const OUTLINE_W = OUTLINE_STEPS[outlineStep];
// Dedicated shader (not a patched built-in): MeshBasicMaterial only declares
// normals behind USE_DISPLACEMENTMAP, so a begin_vertex patch can't reference
// objectNormal there. Write the hull transform out explicitly. Fills one
// post-process rim material; the outline band is drawn in the stencil pass.
function outlineMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      outlineWidth: { value: OUTLINE_W },
      distNearMul: { value: 3.0 },
      distFarMul: { value: 1.0 },
      distNear: { value: 2.0 },
      distFar: { value: 9.0 }
    },
    vertexShader: [
      "uniform float outlineWidth;",
      "uniform float distNearMul;",
      "uniform float distFarMul;",
      "uniform float distNear;",
      "uniform float distFar;",
      // Expand the back faces outward along the object normal: only the rim
      // outside the silhouette survives the depth test, so the body stays lit.
      // Width scales with view distance (thicker near the player): the base
      // modelview position gives the distance, then the normal offset is
      // re-expanded with the scaled width. Works for plain meshes and
      // InstancedMesh (instanceMatrix is declared in three's vertex prefix
      // when USE_INSTANCING is set).
      "void main() {",
      "  #ifdef USE_INSTANCING",
      "    vec4 mvBase = modelViewMatrix * instanceMatrix * vec4(position, 1.0);",
      "  #else",
      "    vec4 mvBase = modelViewMatrix * vec4(position, 1.0);",
      "  #endif",
      "  float w = outlineWidth * mix(distNearMul, distFarMul, smoothstep(distNear, distFar, length(mvBase.xyz)));",
      "  vec3 transformed = position + normalize(normal) * w;",
      "  #ifdef USE_INSTANCING",
      "    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(transformed, 1.0);",
      "  #else",
      "    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);",
      "  #endif",
      "}"
    ].join("\n"),
    fragmentShader: "void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }"
  });
}
function cycleOutlineDepth() {
  outlineStep = (outlineStep + 1) % OUTLINE_STEPS.length;
  if (rimMat) rimMat.uniforms.outlineWidth.value = OUTLINE_STEPS[outlineStep];
}

// Use the rendered triangles, including instanced stonework, as occluders.
function shadowMesh(mesh, cast = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  if (cast) mesh.material.shadowSide = THREE.DoubleSide;
  return mesh;
}

const shadowTorchPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
const nextShadowTorchPosition = new THREE.Vector3();
function updateTorchSway(now) {
  const t = now * 0.001;
  // Share the weapon's slow, off-phase rhythms. Moving the actual light keeps
  // illumination and geometry shadows together, including while standing still.
  torchViewModel.root.position.set(
    TORCH_REST[0] + TORCH_SWAY.x * Math.sin(SWORD2_WAVE.fz * t + 1.3),
    TORCH_REST[1] + TORCH_SWAY.y * Math.sin(1.7 * t),
    TORCH_REST[2] + TORCH_SWAY.z * Math.sin(SWORD2_WAVE.fx * t)
  );
}

function updateTorchShadow() {
  torch.getWorldPosition(nextShadowTorchPosition);
  if (!shadowTorchPosition.equals(nextShadowTorchPosition)) {
    shadowTorchPosition.copy(nextShadowTorchPosition);
    renderer.shadowMap.needsUpdate = true;
  }
}

function wrapTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

async function loadEnemyAssets() {
  try {
    enemyAssets.rat = await (await fetch("/assets/rat.json")).json();
    enemyAssets.spider = await (await fetch("/assets/spider.json")).json();
  } catch (e) {
    console.warn("enemy assets unavailable, using boxes", e);
  }
  try {
    sword2Asset = await (await fetch("/assets/sword_2.json")).json();
  } catch (e) {
    console.warn("sword2 asset unavailable, no viewmodel", e);
  }
}

async function loadDungeonAssets() {
  for (const [k, url] of Object.entries(DUNGEON_ASSETS)) {
    try {
      dungeonAssets[k] = await (await fetch(url)).json();
    } catch (e) {
      console.warn("dungeon asset unavailable, using primitive fallback", k, e);
    }
  }
}

function buildEnemyGroup(asset, shadows = true) {
  const g = new THREE.Group();
  for (const p of asset.parts) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(p.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(p.nrm, 3));
    if (p.idx && p.idx.length) geo.setIndex(p.idx);
    const mat = new THREE.MeshToonMaterial({ color: new THREE.Color(p.color), gradientMap: toonMap });
    const mesh = new THREE.Mesh(geo, mat);
    g.add(shadows ? shadowMesh(mesh) : mesh);
  }
  return g;
}

function buildSword2ViewModel() {
  if (!sword2Asset) return;
  // The camera-space weapon must not shadow the nearby torch, so it casts nothing.
  const mesh = buildEnemyGroup(sword2Asset, false);
  mesh.scale.setScalar(SWORD2_SCALE);
  mesh.position.y = -SWORD2_GRIP;  // grip pivot at the group origin
  const slot = new THREE.Group();
  slot.rotation.y = SWORD2_SLOT_YAW;  // constant rotation about the weapon's length axis
  slot.add(mesh);
  const swing = new THREE.Group();
  swing.add(slot);
  swing.rotation.set(SWORD2_IDLE.x, SWORD2_IDLE.y, SWORD2_IDLE.z);
  const pivot = new THREE.Group();
  pivot.position.set(SWORD2_ARM[0], SWORD2_ARM[1], SWORD2_ARM[2]);
  pivot.add(swing);
  camera.add(pivot);
  sword2 = { swing, pivot, tw: { on: false, t0: 0, seg: 0, keys: null } };
}

function startSword2Attack() {
  if (!sword2 || sword2.tw.on) return;
  const tw = sword2.tw;
  const j = (a) => (Math.random() - 0.5) * a;  // per-attack jitter
  const seq = SWING_SEQS[(Math.random() * SWING_SEQS.length) | 0];
  tw.keys = [
    { p: SWORD2_ARM.slice(), r: [SWORD2_IDLE.x, 0, SWORD2_IDLE.z] },
    ...seq.keys.map(k => ({
      d: k.d, e: k.e,
      p: [k.p[0] + j(0.06), k.p[1] + j(0.06), k.p[2] + j(0.05)],
      r: [k.r[0] + j(0.28), k.r[1] + j(0.30), k.r[2] + j(0.28)]
    })),
    { d: SWORD2_RECOVER_MS, e: "out", p: SWORD2_ARM.slice(), r: [SWORD2_IDLE.x, 0, SWORD2_IDLE.z] }
  ];
  tw.on = true; tw.t0 = performance.now(); tw.seg = 0;
}

function updateSword2(now) {
  const tw = sword2.tw;
  if (!tw.on) {
    const t = now * 0.001;
    let dip = 0;
    const sdt = Math.min(0.05, Math.max(0, (now - sword2DipClock) / 1000));
    sword2DipClock = now;
    if (moveTw.on) {  // continuous U, one full dip per two steps
      sword2DipPhase = (sword2DipPhase + sdt * 1000 / (2 * STEP_MS)) % 1;
      sword2DipDepth = (SWORD2_STRIDE_DIP * (1 - Math.cos(sword2DipPhase * TAU))) / 2;
    } else if (sword2DipDepth > 1e-4) {
      sword2DipDepth *= Math.exp(-14 * sdt);  // settle when walking stops
    }
    dip = sword2DipDepth;
    sword2.pivot.position.set(
      SWORD2_ARM[0],
      SWORD2_ARM[1] + SWORD2_WAVE.py * Math.sin(1.7 * t) - dip,
      SWORD2_ARM[2]
    );
    sword2.swing.rotation.set(  // two off-phase sines, never loops visibly
      SWORD2_IDLE.x + SWORD2_WAVE.ax * Math.sin(SWORD2_WAVE.fx * t),
      SWORD2_IDLE.y,
      SWORD2_IDLE.z + SWORD2_WAVE.az * Math.sin(SWORD2_WAVE.fz * t + 1.3)
    );
    return;
  }
  const a = tw.keys[tw.seg], b = tw.keys[tw.seg + 1];
  const t = Math.min(1, (now - tw.t0) / b.d);
  const f = SWING_EASE[b.e](t);
  sword2.pivot.position.set(
    a.p[0] + (b.p[0] - a.p[0]) * f,
    a.p[1] + (b.p[1] - a.p[1]) * f,
    a.p[2] + (b.p[2] - a.p[2]) * f
  );
  sword2.swing.rotation.set(
    a.r[0] + (b.r[0] - a.r[0]) * f,
    a.r[1] + (b.r[1] - a.r[1]) * f,
    a.r[2] + (b.r[2] - a.r[2]) * f
  );
  if (t >= 1) {
    if (tw.seg >= tw.keys.length - 2) tw.on = false;
    else { tw.seg += 1; tw.t0 = now; }
  }
}

function buildTextures() {
  tex.wall = wrapTexture(wallStone(7));
  tex.floor = wrapTexture(floorStone(21));
  tex.ceil = wrapTexture(ceilStone(5));
}

let bufW = 0, bufH = 0;
let cvEl, boxW = 0, boxH = 0;
function fitBuffer() {
  const vw = innerWidth, vh = innerHeight;
  if (vw > 0 && vh > 0) {
    const sc = Math.min(vw / RES_W, vh / RES_H);  // letterbox the fixed 5:4 frame
    const cw = (RES_W * sc) | 0, ch = (RES_H * sc) | 0;
    if (cw !== boxW || ch !== boxH) {
      cvEl.style.width = cw + "px";
      cvEl.style.height = ch + "px";
      boxW = cw; boxH = ch;
    }
  }
  if (postRT && (postRT.width !== RES_W || postRT.height !== RES_H)) postRT.setSize(RES_W, RES_H);

  if (postMat) postMat.uniforms.aspect.value = RES_W / RES_H;
  if (RES_W === bufW && RES_H === bufH) return;
  bufW = RES_W; bufH = RES_H;
  renderer.setSize(RES_W, RES_H, false);
  camera.aspect = RES_W / RES_H;
  camera.updateProjectionMatrix();
}

function initScene() {
  buildTextures();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);
  scene.fog = new THREE.FogExp2(0x050505, 0.06);
  camera = new THREE.PerspectiveCamera(75, 1, 0.05, 80);
  cvEl = document.getElementById("c");
  renderer = new THREE.WebGLRenderer({ canvas: cvEl, antialias: false });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;
  // Flicker changes light intensity, not occlusion. Reuse the six shadow faces
  // until the torch, a world caster, or the arena geometry changes.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  // Also tone-map the direct-render path when dithering is disabled.
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = TONE_EXPOSURE;
  renderer.setPixelRatio(1);
  fitBuffer();
  addEventListener("resize", fitBuffer);
  torch = new THREE.PointLight(0xffdfad, TORCH_INTENSITY, 45, TORCH_DECAY);
  torch.castShadow = true;
  torch.shadow.mapSize.set(TORCH_SHADOW_SIZE, TORCH_SHADOW_SIZE);
  torch.shadow.camera.near = 0.05;
  torch.shadow.camera.far = torch.distance;
  torch.shadow.bias = -0.0001;
  torch.shadow.normalBias = 0.02;
  torchViewModel = createTorchViewModel();
  torchViewModel.root.scale.setScalar(0.85);
  torchViewModel.root.position.set(...TORCH_REST);
  torchViewModel.root.rotation.set(0.18, 0, 0.12);
  torch.position.set(0, 0.06, 0);
  torchViewModel.flameSocket.add(torch);
  camera.add(torchViewModel.root);
  scene.add(camera);
  buildSword2ViewModel();
  // A dim grey light color was converted from sRGB to near-zero irradiance,
  // flattening occluded surfaces into the darkest dither band. Keep a modest
  // neutral base plus directional room fill so shadowed bevels remain visible.
  scene.add(new THREE.AmbientLight(0xffffff, SHADOW_AMBIENT));
  scene.add(new THREE.HemisphereLight(0xadb9cb, 0x79624e, SHADOW_BOUNCE));
  window.__scene = scene;
  if (DITHER) {
    // Preserve values above 1 until the final pass compresses the highlights.
    postRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, stencilBuffer: true });
    postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    postScene = new THREE.Scene();
    postMat = new THREE.ShaderMaterial({
      toneMapped: false,
      uniforms: {
        tex: { value: postRT.texture },
        exposure: { value: TONE_EXPOSURE },
        aspect: { value: bufW / Math.max(1, bufH) },
        fisheye: { value: FISHEYE_K },
        blur: { value: new THREE.Vector3(0, 0, 0) },
        cover: { value: BLUR_COVER },
      },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: [
        "precision mediump float;",
        "uniform sampler2D tex;",
        "uniform float exposure;",
        "uniform float aspect;",
        "uniform float fisheye;",
        "uniform vec3 blur;",
        "uniform float cover;",
        "varying vec2 vUv;",
        "const mat4 BAYER = mat4(",
        " 0.0, 8.0, 2.0, 10.0,",
        " 12.0, 4.0, 14.0, 6.0,",
        " 3.0, 11.0, 1.0, 9.0,",
        " 15.0, 7.0, 13.0, 5.0);",
        "void main() {",
        "  vec2 p = vUv - 0.5;",
        "  p.x *= aspect;",
        "  vec3 col = vec3(0.0);",
        "  for (int i = 0; i < 5; i++) {",
        "    float k = 0.5 + 0.5 * cover * (float(i) - 2.0) * 0.5;",
        "    vec2 pp = p - vec2(blur.y, blur.z) * k;",
        "    float a = blur.x * k;",
        "    float s = sin(a);",
        "    float c = cos(a);",
        "    pp = vec2(c * pp.x - s * pp.y, s * pp.x + c * pp.y);",
        "    float r = length(pp);",
        "    float R = 0.5 * min(1.0, aspect);",
        "    float q = r / max(R, 1e-5);",
        "    vec2 pw = pp / (1.0 + fisheye * q * q);",
        "    pw.x /= aspect;",
        "    col += texture2D(tex, pw + 0.5).rgb;",
        "  }",
        // Average the HDR blur samples, then apply Reinhard before sRGB/dither.
        "  vec3 hdr = max(col * 0.2 * exposure, vec3(0.0));",
        "  vec3 comp = hdr / (vec3(1.0) + hdr);",
        "  float b = BAYER[int(mod(gl_FragCoord.x, 4.0))][int(mod(gl_FragCoord.y, 4.0))];",
        "  float t = (b - 7.5) / 16.0;",
        "  vec3 srg = mix(comp * 12.92, 1.055 * pow(comp, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), comp));",
        // Center the quantizer: flooring without the half-step crushes dark
        // texture variations and biases every palette band downward.
        "  vec3 v = max(floor(srg * 11.0 + t + 0.5), 1.0) / 11.0;",
        "  gl_FragColor = vec4(v, 1.0);",
        "}"
      ].join("\n")
    });
    postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));
    // Post-process silhouette outline (N key). The stencil lives in postRT
    // itself: pass 1 re-renders the scene with a colorless override that
    // only writes stencil 1 across every body silhouette; pass 2 draws the
    // shared backside hull with stencil-func NotEqual, so the expanded rim
    // survives only OUTSIDE the silhouettes, and the depth test keeps the
    // rim behind nearer bodies.
    hullMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    hullMat.colorWrite = false;
    hullMat.depthWrite = false;
    hullMat.polygonOffset = true;
    hullMat.polygonOffsetFactor = -1;
    hullMat.polygonOffsetUnits = -1;
    hullMat.stencil = true;
    hullMat.stencilWrite = true;
    hullMat.stencilRef = 1;
    hullMat.stencilFunc = THREE.AlwaysStencilFunc;
    hullMat.stencilFuncMask = 0xff;
    hullMat.stencilZPass = THREE.ReplaceStencilOp;
    rimMat = outlineMaterial();
    rimMat.polygonOffset = true;
    rimMat.polygonOffsetFactor = -1;
    rimMat.polygonOffsetUnits = -1;
    rimMat.stencil = true;
    rimMat.stencilRef = 1;
    rimMat.stencilFunc = THREE.NotEqualStencilFunc;
    rimMat.stencilFuncMask = 0xff;
    window.__mud = {
      blur: postMat.uniforms.blur.value, mat: postMat, tw: moveTw,
      postOutlines: (on) => { postOutlineOn = !!on; },
      outlineDepth: () => OUTLINE_STEPS[outlineStep],
      rimDepth: (v) => { if (rimMat) rimMat.uniforms.outlineWidth.value = v; },
      outlineWidthSet: (v) => { if (rimMat) rimMat.uniforms.outlineWidth.value = v; },
      outlineDistance: (nearMul, farMul, nearD, farD) => {
        if (!rimMat) return null;
        const u = rimMat.uniforms;
        u.distNearMul.value = nearMul;
        u.distFarMul.value = farMul;
        u.distNear.value = nearD;
        u.distFar.value = farD;
        return { rimMat: Object.fromEntries(Object.entries(u).map(([k, v]) => [k, v.value])) };
      }
    };
  }
  buildArenaGeometry();
}

// Stone round arch over a 3-tile doorway: a floating band between the
// elliptical curve (springline 2.0 m, crown 2.8 m) and the wall top. The
// lower 2 m of the span is a plain opening, so no floor geometry is
// duplicated in doorway cells; the ARCH_EPS inset keeps the band off the
// Z-coplanar planes of neighboring walls and the ceiling. Only the middle
// tile is passable (arch flanks are walls in the core).
function buildDoorArchGeos() {
  const shape = new THREE.Shape();
  shape.moveTo(-ARCH_R, WALL_H);
  shape.lineTo(ARCH_R, WALL_H);
  shape.lineTo(ARCH_R, ARCH_SPRING);
  shape.absellipse(0, ARCH_SPRING, ARCH_R, ARCH_RISE, 0, Math.PI, false);
  shape.closePath();
  const opt = { depth: TILE_M, bevelEnabled: false };
  const s = (ARCH_R - ARCH_EPS) / ARCH_R;
  // Match the wall boxes' UV scheme (each 1x3 face maps u=world_x mod 1,
  // v=y/WALL_H) so the stone pattern is continuous across door arches.
  // Every door center sits on a half-integer tile, so the 0.5 phase is
  // constant for all doors and can be baked into the shared geometry.
  const bake = (g, ufn) => {
    const p = g.attributes.position;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      uv[i * 2] = ufn(p.getX(i));
      uv[i * 2 + 1] = (p.getY(i) - ARCH_EPS) / WALL_H;
    }
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  };
  const spanX = new THREE.ExtrudeGeometry(shape, opt);           // span along three x, 1-tile thick along z
  bake(spanX, (x) => 0.5 + s * x);
  spanX.scale(s, 1, 1 - 2 * ARCH_EPS);
  spanX.translate(0, -ARCH_EPS, 0);
  const spanZ = new THREE.ExtrudeGeometry(shape, opt);
  bake(spanZ, (x) => 0.5 - s * x);                               // span maps to -z after rotateY
  spanZ.rotateY(Math.PI / 2);                                    // span along three z, 1-tile thick along x
  spanZ.scale(1 - 2 * ARCH_EPS, 1, s);
  spanZ.translate(0, -ARCH_EPS, 0);
  return { spanX, spanZ };
}

function buildDoorArchMeshes(codes, w, h) {
  const { spanX, spanZ } = buildDoorArchGeos();
  const mat = new THREE.MeshLambertMaterial({ map: tex.wall });
  const add = (geo, px, pz) => {
    const mesh = shadowMesh(new THREE.Mesh(geo, mat));
    mesh.position.set(px, 0, pz);
    scene.add(mesh);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (codes[y * w + x] !== TILE_DOOR) continue;
      if (codes[y * w + x - 1] === TILE_ARCH && codes[y * w + x + 1] === TILE_ARCH) {
        add(spanX, (x + 0.5) * TILE_M, (y + ARCH_EPS) * TILE_M);
      } else if (codes[(y - 1) * w + x] === TILE_ARCH && codes[(y + 1) * w + x] === TILE_ARCH) {
        add(spanZ, (x + ARCH_EPS) * TILE_M, (y + 0.5) * TILE_M);
      }
    }
}

function h01(x, y, salt) {
  let n = (Math.imul(x, 374761393) + Math.imul(y + 1013 * salt, 668265263)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const _gcache = new Map();
const _mcache = new Map();
function assetGeos(asset) {
  let geos = _gcache.get(asset);
  if (!geos) {
    geos = asset.parts.map((p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(p.pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(p.nrm, 3));
      if (p.idx && p.idx.length) g.setIndex(p.idx);
      return g;
    });
    _gcache.set(asset, geos);
  }
  return geos;
}

function partMats(asset, toon) {
  let slot = _mcache.get(asset);
  if (!slot) _mcache.set(asset, (slot = {}));
  const key = toon ? "t" : "l";
  if (!slot[key])
    slot[key] = asset.parts.map((p) =>
      toon
        ? new THREE.MeshToonMaterial({ color: new THREE.Color(p.color), gradientMap: toonMap })
        : new THREE.MeshLambertMaterial({ color: new THREE.Color(p.color) })
    );
  return slot[key];
}

const _scratchQ = new THREE.Quaternion();
const _scratchA = new THREE.Vector3(1, 1, 1);
const _UP = new THREE.Vector3(0, 1, 0);
function placeMat(list, x, y, z, yaw) {
  _scratchQ.setFromAxisAngle(_UP, yaw);
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), _scratchQ, _scratchA);
  list.push(m);
}

function addInstanced(asset, toon, matrices, castShadow = true) {
  const geos = assetGeos(asset), mats = partMats(asset, toon);
  geos.forEach((geo, i) => {
    const im = shadowMesh(new THREE.InstancedMesh(geo, mats[i], matrices.length), castShadow);
    matrices.forEach((mm, j) => im.setMatrixAt(j, mm));
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
  });
}

function tileAt(codes, w, h, x, y) {
  return x >= 0 && y >= 0 && x < w && y < h ? codes[y * w + x] : 101;
}

function buildPackWalls(codes, w, h) {
  const panelTiles = 3;
  const batches = new Map();
  for (const panel of wallPanels(codes, w, h, panelTiles)) {
    if (!batches.has(panel.width)) batches.set(panel.width, []);
    placeMat(batches.get(panel.width), panel.x * TILE_M, 0, panel.z * TILE_M,
      panel.vertical ? -Math.PI / 2 : 0);
  }
  for (const [length, matrices] of batches)
    addInstanced(cropWallPanel(dungeonAssets.wall, length * TILE_M, panelTiles * TILE_M), false, matrices, true);
}

function buildPackFloor(codes, w, h) {
  const mats = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Thin visual walls expose floor inside their blocked grid cells.
      placeMat(mats, (x + 0.5) * TILE_M, 0, (y + 0.5) * TILE_M, Math.floor(h01(x, y, 5) * 4) * (Math.PI / 2));
    }
  // Floors need not be drawn into all six shadow faces.
  addInstanced(dungeonAssets.floor, false, mats, false);
}

function buildPackArches(codes, w, h) {
  const mats = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (codes[y * w + x] !== TILE_DOOR) continue;
      const hE = tileAt(codes, w, h, x - 1, y) === TILE_ARCH || tileAt(codes, w, h, x + 1, y) === TILE_ARCH;
      placeMat(mats, (x + 0.5) * TILE_M, 0, (y + 0.5) * TILE_M, hE ? 0 : Math.PI / 2);
    }
    addInstanced(dungeonAssets.arch, false, mats, true);
}

function roomRects(codes, w, h) {
  const rects = new Map();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = codes[y * w + x];
      if (c < 1 || c > 20) continue;
      const r = rects.get(c);
      if (!r) rects.set(c, [x, y, x, y]);
      else { r[0] = Math.min(r[0], x); r[1] = Math.min(r[1], y); r[2] = Math.max(r[2], x); r[3] = Math.max(r[3], y); }
    }
  return [...rects.values()];
}

function gridTemplate(asset, toon) {
  const geos = assetGeos(asset), mats = partMats(asset, toon);
  const g = new THREE.Group();
  asset.parts.forEach((p, i) => {
    g.add(shadowMesh(new THREE.Mesh(geos[i], mats[i])));
  });
  return g;
}

function buildCobwebs(codes, w, h) {
  if (!dungeonAssets.cobweb) return;
  const corners = [[0, 0, 0], [1, 0, -Math.PI / 2], [0, 1, Math.PI / 2], [1, 1, Math.PI]];
  const tmpl = gridTemplate(dungeonAssets.cobweb, true);
  for (const [x0, y0, x1, y1] of roomRects(codes, w, h)) {
    const picks = [0, 1, 2, 3].map((k) => [h01(x0 + k * 31, y0 * 7 + k * 11, 17), k]);
    picks.sort((a, b) => b[0] - a[0]);
    for (let i = 0; i < 2; i++) {
      const [ec, ns, yaw] = corners[picks[i][1]];
      const g = tmpl.clone();
      g.position.set((x0 + ec * (x1 - x0 + 1)) * TILE_M, WALL_H - 0.4, (y0 + ns * (y1 - y0 + 1)) * TILE_M);
      g.rotation.y = yaw;
      scene.add(g);
    }
  }
}

function buildFloorProps(codes, w, h) {
  if (!dungeonAssets.crate && !dungeonAssets.barrel) return;
  const placed = new Uint8Array(w * h);
  const taken = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? placed[y * w + x] : 0);
  const tmpls = new Map();
  const tmplOf = (a) => {
    let t = tmpls.get(a);
    if (!t) tmpls.set(a, (t = gridTemplate(a, true)));
    return t;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = codes[y * w + x];
      if (c < 1 || c > 20) continue;
      const n = [tileAt(codes, w, h, x - 1, y), tileAt(codes, w, h, x + 1, y), tileAt(codes, w, h, x, y - 1), tileAt(codes, w, h, x, y + 1)];
      if (!n.includes(0) || n.includes(TILE_DOOR) || n.includes(TILE_ARCH)) continue;
      if (taken(x + 1, y) || taken(x - 1, y) || taken(x, y + 1) || taken(x, y - 1)) continue;
      if (h01(x, y, 13) >= 0.07) continue;
      const a =
        h01(x, y, 23) < 0.5
          ? dungeonAssets.crate || dungeonAssets.barrel
          : dungeonAssets.barrel || dungeonAssets.crate;
      const g = tmplOf(a).clone();
      g.position.set((x + 0.5) * TILE_M, 0, (y + 0.5) * TILE_M);
      g.rotation.y = Math.floor(h01(x, y, 31) * 4) * (Math.PI / 2);
      scene.add(g);
      placed[y * w + x] = 1;
    }
}

function buildArenaGeometry() {
  if (selfId < 0 || !world) return;
  renderer.shadowMap.needsUpdate = true;
  const w = world.spec.width, h = world.spec.height;
  const codes = world.spec.codes.toJs();
  if (dungeonAssets.wall) {
    buildPackWalls(codes, w, h);
  } else {
    const walls = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (codes[y * w + x] === 0) walls.push([x, y]);
    const m = new THREE.Matrix4();
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(TILE_M, WALL_H, TILE_M),
      new THREE.MeshLambertMaterial({ map: tex.wall }),
      walls.length
    );
    walls.forEach(([x, y], i) => {
      m.makeTranslation((x + 0.5) * TILE_M, WALL_H / 2, (y + 0.5) * TILE_M);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    shadowMesh(mesh);
    scene.add(mesh);
  }
  if (dungeonAssets.arch) buildPackArches(codes, w, h);
  else buildDoorArchMeshes(codes, w, h);
  if (dungeonAssets.floor) {
    buildPackFloor(codes, w, h);
  } else {
    const floorTex = tex.floor.clone();
    floorTex.repeat.set(w, h);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w * TILE_M, h * TILE_M),
      new THREE.MeshLambertMaterial({ map: floorTex })
    );
    floor.rotation.x = -Math.PI / 2;
    shadowMesh(floor, false);
    floor.position.set((w * TILE_M) / 2, 0, (h * TILE_M) / 2);
    scene.add(floor);
  }
  buildCobwebs(codes, w, h);
  buildFloorProps(codes, w, h);
  const ceilTex = tex.ceil.clone();
  ceilTex.repeat.set(w, h);
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(w * TILE_M, h * TILE_M),
    new THREE.MeshLambertMaterial({ map: ceilTex })
  );
  ceil.rotation.x = Math.PI / 2;
  shadowMesh(ceil, false);
  ceil.position.set((w * TILE_M) / 2, WALL_H, (h * TILE_M) / 2);
  scene.add(ceil);
  const wallMat = new THREE.MeshBasicMaterial({ color: 0x2a241c, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  const addWall = (gw, gz, px, pz) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(gw, WALL_H, gz), wallMat);
    b.position.set(px, WALL_H / 2, pz);
    scene.add(b);
  };
  addWall(w * TILE_M, 0.1, (w * TILE_M) / 2, 0);
  addWall(w * TILE_M, 0.1, (w * TILE_M) / 2, h * TILE_M);
  addWall(0.1, h * TILE_M, 0, (h * TILE_M) / 2);
  addWall(0.1, h * TILE_M, w * TILE_M, (h * TILE_M) / 2);
  const props = world.spec.props.toJs();
  props.forEach((pr, i) => {
    const asset = enemyAssets[(i % 2 === 0) ? "rat" : "spider"];
    const x = (pr.x + 0.5) * TILE_M, z = (pr.y + 0.5) * TILE_M;
    if (asset) {
      const g = buildEnemyGroup(asset);
      g.position.set(x, 0, z);
      g.scale.setScalar(ENEMY_SCALE);
      scene.add(g);
    } else {
      const p = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 1.0, 0.55),
        new THREE.MeshToonMaterial({ color: pr.kind === 1 ? 0x5a4632 : 0x606a70, gradientMap: toonMap })
      );
      p.position.set(x, 0.5, z);
      shadowMesh(p);
      scene.add(p);
    }
  });
}

function namePlate(text, color) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 32;
  const g = c.getContext("2d");
  g.font = "20px monospace";
  g.textAlign = "center";
  g.fillStyle = "#" + color.toString(16).padStart(6, "0");
  g.fillText(text, 64, 22);
  const cTex = new THREE.CanvasTexture(c);
  cTex.magFilter = THREE.NearestFilter;
  cTex.minFilter = THREE.NearestFilter;
  cTex.generateMipmaps = false;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: cTex, transparent: true, depthTest: false }));
  s.scale.set(1.1, 0.275, 1);
  s.position.y = 2.25;
  return s;
}

function syncMesh(eid, e) {
  let g = groups.get(eid);
  if (!g) {
    g = new THREE.Group();
    const mat = new THREE.MeshToonMaterial({ color: e.color, gradientMap: toonMap });
    const addBox = (bw, bh, bd, x, y, z) => {
      const b = shadowMesh(new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat));
      b.position.set(x, y, z);
      g.add(b);
    };
    addBox(0.24, 0.6, 0.24, -0.14, 0.3, 0);
    addBox(0.24, 0.6, 0.24, 0.14, 0.3, 0);
    addBox(0.56, 0.68, 0.3, 0, 0.94, 0);
    addBox(0.2, 0.6, 0.2, -0.38, 0.96, 0);
    addBox(0.2, 0.6, 0.2, 0.38, 0.96, 0);
    addBox(0.46, 0.46, 0.46, 0, 1.5, 0);
    g.add(namePlate(e.name, e.color));
    const torchLight = new THREE.PointLight(0xffdfad, PLAYER_TORCH_INTENSITY, 18, TORCH_DECAY);
    // Other players provide fill light; keep the six-face shadow budget on
    // the local torch rather than multiplying it by the online player count.
    torchLight.position.set(0, 1.45, 0);
    g.add(torchLight);
    groups.set(eid, g);
    scene.add(g);
  }
  g.rotation.y = -((e.yaw / 2048) * Math.PI * 2);
  renderer.shadowMap.needsUpdate = true;
}

const toU8 = (x) => {
  const j = (typeof x === "object" && typeof x.toJs === "function") ? x.toJs() : x;
  if (j instanceof Uint8Array) return j;
  const u = new Uint8Array(j.length);
  for (let i = 0; i < j.length; i++) u[i] = j[i];
  return u;
};
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const toPyBytes = (u8) => b64d(b64(u8));

// ---------- socket ----------
function wireSocket() {
  ws.onopen = () => ws.send(toU8(core.protocol.pack_join(0, name)));

  ws.onmessage = (e) => {
    const u8 = new Uint8Array(e.data);
    let k;
    try { k = u8[0]; } catch { return; }
    if (k === 2) {
      const r = core.protocol.unpack_welcome(toPyBytes(u8)).toJs();
      selfId = r[0]; localTick = r[1];
      predPos = [r[4], r[5]]; dispPos = [r[4], r[5]];
      facing = normYaw(Math.round((r[7] / 2048) * TAU / (Math.PI / 2)) * (Math.PI / 2));
      yaw = facing;
      const blob = toU8(r[2]);
      pyodide.globals.set("mud_blob", b64(blob));
      pyodide.runPython("import base64; mud_blob = base64.b64decode(mud_blob)");
      world = pyodide.runPython("game_core.world.build_world(game_core.protocol.unpack_world_blob(mud_blob))");
      buildArenaGeometry();
    } else if (k === 16 || k === 17) {
      const r = core.protocol.unpack_state(toPyBytes(u8)).toJs();
      applyState(r[0], r[1], r[2], r[3], r[4]);
    } else if (k === 32) {
      const r = core.protocol.unpack_kick(toPyBytes(u8)).toJs();
      die("server: " + r[1] + " (" + r[0] + ")", false);
    } else if (k === 33) {
      const r = core.protocol.unpack_error(toPyBytes(u8)).toJs();
      die("server: " + r[1] + " (" + r[0] + ")", true);
    }
  };
}

// ---------- state apply + reconcile + resync ----------
function applyOp(op, tick) {
  const k = op[0];
  if (k === 0) {
    const pid = op[1];
    let e = known.get(pid);
    if (!e) {
      if (pid !== selfId) return;
      e = { x: 0, y: 0, room: 0, yaw: 0, color: 0, name: "", ops: [] };
      known.set(pid, e);
    }
    e.x = op[2]; e.y = op[3]; e.room = op[4];
    e.ops.push({ t: tick, x: e.x, y: e.y });
    if (e.ops.length > 2) e.ops.shift();
  } else if (k === 1) {
    const pid = op[1];
    const e = {
      x: op[2], y: op[3], room: op[4], yaw: op[5], color: op[6], name: op[7],
      ops: [{ t: tick, x: op[2], y: op[3] }],
    };
    known.set(pid, e);
    if (pid === selfId) return;
    syncMesh(pid, e);
  } else if (k === 2) {
    const pid = op[1];
    known.delete(pid);
    const g = groups.get(pid);
    if (g) { scene.remove(g); groups.delete(pid); renderer.shadowMap.needsUpdate = true; }
  } else if (k === 3) {
    const pid = op[1];
    const e = known.get(pid);
    if (!e || pid === selfId) return;
    e.yaw = op[2];
    syncMesh(pid, e);
  }
}

let resyncRequested = false;

function applyState(kind, tick, ack, connectedCt, ops) {
  connected = connectedCt;
  lastStateAt = performance.now();
  lastStateTick = tick;
  stateCount += 1;
  const isResync = kind === 17;
  if (isResync) {
    resyncRequested = false;
    pending.length = 0;
    stepPending = null;
    moveTw.on = false;
  }
  while (pending.length && pending[0].seq <= ack) pending.shift();
  for (const op of ops) applyOp(op, tick);
  if (selfId >= 0) {
    const me = known.get(selfId);
    if (me) {
      if (isResync) {
        predPos = [me.x, me.y];
        dispPos = [me.x, me.y];
      } else {
        const ddx = predPos[0] - me.x, ddy = predPos[1] - me.y;
        if (Math.abs(ddx) > SNAP_TILES || Math.abs(ddy) > SNAP_TILES) {
          if (!resyncRequested) {
            resyncRequested = true;
            ws.send(toU8(core.protocol.pack_resync_req()));
          }
        } else {
          let rx = me.x, ry = me.y, rt = localTick;
          for (const p of pending) {
            const r = core.moves.try_move_at(world, rx, ry, p.dx, p.dy, rt).toJs();
            rx = r[0]; ry = r[1];
            rt += 1;
          }
          predPos = [rx, ry];
        }
      }
    }
    if (pending.length > UNACK_LIMIT && !resyncRequested) {
      resyncRequested = true;
      ws.send(toU8(core.protocol.pack_resync_req()));
    }
  }
}

// ---------- input + prediction ----------
function normYaw(a) {
  a = ((a % TAU) + TAU) % TAU;
  if (a > Math.PI) a -= TAU;
  return a;
}

function shortestAngle(a) {
  return ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

function facingQuadrant() {
  return (((Math.round(facing / (Math.PI / 2)) % 4) + 4) % 4);
}

function yaw16() {
  return facingQuadrant() * 512;
}

function stepVec() {
  const f = FACE_DIRS[facingQuadrant()];
  const fx = f[0], fy = f[1];
  const dx = fx * mv.fw - fy * mv.st;
  const dy = fy * mv.fw + fx * mv.st;
  if (dx === 0 && dy === 0) return null;
  return [dx, dy];
}

function doStep() {
  if (selfId < 0 || stateCount === 0 || moveTw.on || stepPending) return;
  const d = stepVec();
  if (!d) return;
  stepPending = d;
}

function turn(dir) {
  const f = normYaw(Math.round(facing / (Math.PI / 2) + dir) * (Math.PI / 2));
  const to = yaw - shortestAngle(yaw - f);
  rotTw.on = true; rotTw.t0 = performance.now(); rotTw.from = yaw; rotTw.to = to;
  facing = f;
}

function simTick() {
  if (selfId < 0 || stateCount === 0) return;
  localTick += 1;
  const [dx, dy] = stepPending || [0, 0];
  stepPending = null;
  const [nx, ny] = core.moves.try_move_at(world, predPos[0], predPos[1], dx, dy, localTick).toJs();
  if ((dx !== 0 || dy !== 0) && (nx !== predPos[0] || ny !== predPos[1])) {
    const f = FACE_DIRS[facingQuadrant()];
    const fwd = dx * f[0] + dy * f[1];
    const pure = mv.fw === 0 && mv.st !== 0;
    if (pure && strafeOnset) { strafeOnset = false; moveTw.kind = 0; }  // first strafe step of a press
    else moveTw.kind = (Math.abs(fwd) === 1 || pure) ? 1 : 0;
    moveTw.on = true; moveTw.t0 = performance.now();
    moveTw.fx = dispPos[0]; moveTw.fy = dispPos[1];
    moveTw.tx = nx; moveTw.ty = ny;
    lastStepAt = performance.now();
  }
  predPos = [nx, ny];
  seq += 1;
  pending.push({ seq, dx, dy });
  if (pending.length > 64) pending.shift();
  ws.send(toU8(core.protocol.pack_input(seq, dx, dy, yaw16())));
}

// ---------- render ----------
let lastFrame = performance.now();
function render(now) {
  requestAnimationFrame(render);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  fitBuffer();
  const flick = 0.14 * Math.sin(now * 0.0042) + 0.07 * Math.sin(now * 0.0112) + (Math.random() - 0.5) * 0.12;
  torch.intensity = TORCH_INTENSITY * (1 + flick);
  updateTorchSway(now);
  torchViewModel.updateFlame(now, flick);
  if (selfId < 0) return;
  if ((mv.fw || mv.st) && !moveTw.on && now - lastStepAt >= STEP_MS) doStep();
  if (rotTw.on) {
    const t = Math.min(1, (now - rotTw.t0) / ROT_TWEEN_MS);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    yaw = rotTw.from + (rotTw.to - rotTw.from) * e;
    if (t >= 1) { yaw = rotTw.to; rotTw.on = false; }
  }
  if (sword2) updateSword2(now);
  let bobY = 0, pitch = 0, roll = 0;
  if (moveTw.on) {
    const t = Math.min(1, (now - moveTw.t0) / STEP_MS);
    dispPos[0] = moveTw.fx + (moveTw.tx - moveTw.fx) * t;
    dispPos[1] = moveTw.fy + (moveTw.ty - moveTw.fy) * t;
    const pump = moveTw.kind ? 0 : (1 - Math.cos(t * TAU)) / 2;
    bobY = WALK_BOB_AMP * pump;
    pitch = -WALK_NOD * pump;
    roll = (mv.fw === 0 && mv.st !== 0) ? mv.st * LEAN_MAX * pump : 0;
    if (t >= 1) { dispPos[0] = moveTw.tx; dispPos[1] = moveTw.ty; moveTw.on = false; }
  } else {
    dispPos[0] += (predPos[0] - dispPos[0]) * Math.min(1, dt * 14);
    dispPos[1] += (predPos[1] - dispPos[1]) * Math.min(1, dt * 14);
  }
  camera.position.set((dispPos[0] + 0.5) * TILE_M, EYE_H + bobY, (dispPos[1] + 0.5) * TILE_M);
  camera.rotation.set(pitch, yaw, roll, "YXZ");
  let blurRot = 0;
  if (dt > 1e-4) {
    const dRot = (rotTw.on ? yaw - prevYaw : 0) + (roll - prevRoll);
    blurRot = Math.max(-0.35, Math.min(0.35, (dRot / dt) * ROT_WIN));
  }
  prevYaw = yaw;
  prevRoll = roll;
  let blurU = 0;
  if (moveTw.on && mv.st !== 0) {
    const spd = STEP_MS / 1000;
    const rvx = (moveTw.tx - moveTw.fx) / spd;
    const rvz = (moveTw.ty - moveTw.fy) / spd;
    const dvR = rvx * Math.cos(yaw) - rvz * Math.sin(yaw);
    blurU = -(dvR * STRAFE_WIN) / (2 * TAN_FOV * BLUR_REF_D);
  }
  const nowTick = lastStateTick + (now - lastStateAt) / TICK_MS - INTERP_DELAY_MS / TICK_MS;
  for (const [eid, e] of known) {
    if (eid === selfId) continue;
    const g = groups.get(eid);
    if (!g) continue;
    const oldX = g.position.x, oldZ = g.position.z;
    if (e.ops.length >= 2) {
      const a = e.ops[0], b = e.ops[1];
      let px, pz;
      if (b.t - a.t <= GAP_SNAP_TICKS) {
        const t = Math.max(0, Math.min(1, (nowTick - a.t) / Math.max(1e-6, b.t - a.t)));
        px = a.x + (b.x - a.x) * t;
        pz = a.y + (b.y - a.y) * t;
      } else { px = b.x; pz = b.y; }
      g.position.set((px + 0.5) * TILE_M, 0, (pz + 0.5) * TILE_M);
    } else if (e.ops.length === 1) {
      g.position.set((e.ops[0].x + 0.5) * TILE_M, 0, (e.ops[0].y + 0.5) * TILE_M);
    }
    if (g.position.x !== oldX || g.position.z !== oldZ) renderer.shadowMap.needsUpdate = true;
  }
  updateTorchShadow();
  if (hudCount) hudCount.textContent = connected + " online";
  if (postRT) {
    postMat.uniforms.blur.value.set(blurRot, blurU, 0);
    renderer.setRenderTarget(postRT);
    renderer.render(scene, camera);
    if (postOutlineOn) {
      renderer.autoClear = false;
      const bg = scene.background;
      scene.background = null;
      // Pass 1: stencil of every body silhouette (no color output).
      scene.overrideMaterial = hullMat;
      renderer.render(scene, camera);
      // Pass 2: rim — stencil-func NotEqual keeps it outside the
      // silhouettes; the depth test keeps it behind nearer bodies.
      scene.overrideMaterial = rimMat;
      renderer.render(scene, camera);
      scene.overrideMaterial = null;
      scene.background = bg;
      renderer.autoClear = true;
    }
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  } else {
    renderer.render(scene, camera);
  }
}

function die(msg, allowRename) {
  if (!dieEl) {
    dieEl = document.createElement("div");
    dieEl.id = "die";
    dieEl.innerHTML = "<div id='diefmt'></div>";
    document.body.appendChild(dieEl);
  }
  dieEl.style.display = "flex";
  dieEl.children[0].textContent = msg;
  if (allowRename) {
    const b = document.createElement("button");
    b.textContent = "retry (rename)";
    b.onclick = () => {
      const old = localStorage.getItem("mudName") || "wanderer";
      const nn = prompt("Name in use — pick a new name:", old + "_");
      if (nn && nn.trim()) { localStorage.setItem("mudName", nn.trim().slice(0, 24)); location.reload(); }
    };
    dieEl.appendChild(b);
  } else {
    const b = document.createElement("button");
    b.textContent = "close";
    b.onclick = () => window.close();
    dieEl.appendChild(b);
  }
}

// ---------- main ----------
async function boot() {
  loaderEl = document.getElementById("loader");
  const logEl = document.getElementById("log");
  const bar = document.getElementById("bar");
  const log = (s) => { logEl.textContent = s; };
  const setProgress = (p) => { bar.style.width = Math.round(p * 100) + "%"; };
  try {
    log("booting Pyodide");
    await bootCore(log, setProgress);
    log("loading assets");
    setProgress(0.95);
    await loadEnemyAssets();
    await loadDungeonAssets();
    log("building scene");
  } catch (err) {
    log("FAILED: " + err);
    return;
  }
  initScene();
  hudName = document.getElementById("name");
  hudCount = document.getElementById("count");
  hudName.textContent = name;
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.binaryType = "arraybuffer";
  wireSocket();
  ws.onclose = () => { logEl && (loaderEl && loaderEl.style.display !== "none") && (loaderEl.style.display = "flex"); };
  addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "KeyW") mv.fw = 1;
    else if (e.code === "KeyS") mv.fw = -1;
    else if (e.code === "KeyQ") { mv.st = -1; strafeOnset = true; }
    else if (e.code === "KeyE") { mv.st = 1; strafeOnset = true; }
    else if (e.code === "KeyA") { turn(1); return; }
    else if (e.code === "KeyD") { turn(-1); return; }
    else if (e.code === "KeyL") { startSword2Attack(); return; }
    else if (e.code === "KeyN") { postOutlineOn = !postOutlineOn; return; }
    else if (e.code === "KeyV") { cycleOutlineDepth(); return; }
    doStep();
  });
  addEventListener("keyup", (e) => {
    if (e.code === "KeyW" && mv.fw === 1) mv.fw = 0;
    else if (e.code === "KeyS" && mv.fw === -1) mv.fw = 0;
    else     if (e.code === "KeyQ" && mv.st === -1) { mv.st = 0; if (mv.fw === 0) strafeOnset = false; }
    else if (e.code === "KeyE" && mv.st === 1) { mv.st = 0; if (mv.fw === 0) strafeOnset = false; }
  });
  requestAnimationFrame(render);
  setInterval(simTick, TICK_MS);
  loaderEl.style.opacity = "0";
  setTimeout(() => (loaderEl.style.display = "none"), 450);
}

addEventListener("load", () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
  boot();
});
