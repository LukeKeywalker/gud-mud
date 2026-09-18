import * as THREE from "./three.module.js";
import { wallStone, floorStone, ceilStone } from "./texgen.js";

const TICK_MS = 50;
const TILE_M = 1.0;
const WALL_H = 3.0;
const EYE_H = 1.6;
const RES_H = 216;
const DITHER = true;
const STEP_MS = 308;  // step period (walk slowed 1.5x); gap between steps = STEP_MS - STEP_TWEEN_MS
const ARCH_R = 1.5;       // half the 3-tile doorway span
const ARCH_SPRING = 2.0;  // springline, ~2/3 of WALL_H
const ARCH_RISE = 0.8;    // elliptical crown rise (crown at 2.8)
const ARCH_EPS = 0.01;    // band inset, keeps faces off Z-coplanar wall/floor/ceiling
const TILE_DOOR = 21;
const TILE_ARCH = 22;
const STEP_TWEEN_MS = 290;
const WALK_BOB_AMP = 0.05;  // head-bob height per step, Doom-style
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
let lastStepAt = -1e9;
let stepPending = null;
const moveTw = { on: false, t0: 0, fx: 0, fy: 0, tx: 0, ty: 0 };
const rotTw = { on: false, t0: 0, from: 0, to: 0 };
const pending = [];        // { seq, dx, dy }
const known = new Map();   // eid -> { x, y, room, yaw, color, name, ops: [{t,x,y,yaw}] }

let scene, camera, renderer, torch;
let postRT, postCam, postScene;
const tex = {};
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
function wrapTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildTextures() {
  tex.wall = wrapTexture(wallStone(7));
  tex.floor = wrapTexture(floorStone(21));
  tex.ceil = wrapTexture(ceilStone(5));
}

let bufW = 0, bufH = 0;
function fitBuffer() {
  const asp = (innerWidth > 0 && innerHeight > 0) ? innerWidth / innerHeight : 16 / 9;
  const h = RES_H;
  const w = Math.max(2, Math.round(h * asp));
  if (postRT && (postRT.width !== w || postRT.height !== h)) postRT.setSize(w, h);
  if (w === bufW && h === bufH) return;
  bufW = w; bufH = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function initScene() {
  buildTextures();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);
  scene.fog = new THREE.FogExp2(0x050505, 0.10);
  camera = new THREE.PerspectiveCamera(75, 1, 0.05, 80);
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: false });
  renderer.setPixelRatio(1);
  fitBuffer();
  addEventListener("resize", fitBuffer);
  torch = new THREE.PointLight(0xffa64d, 70, 26, 1.45);
  torch.position.set(0.35, -0.35, 0.25);
  camera.add(torch);
  scene.add(camera);
  scene.add(new THREE.AmbientLight(0x39301f, 2.0));
  if (DITHER) {
    postRT = new THREE.WebGLRenderTarget(2, 2);
    postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    postScene = new THREE.Scene();
    const postMat = new THREE.ShaderMaterial({
      uniforms: { tex: { value: postRT.texture } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: [
        "precision mediump float;",
        "uniform sampler2D tex;",
        "varying vec2 vUv;",
        "const mat4 BAYER = mat4(",
        " 0.0, 8.0, 2.0, 10.0,",
        " 12.0, 4.0, 14.0, 6.0,",
        " 3.0, 11.0, 1.0, 9.0,",
        " 15.0, 7.0, 13.0, 5.0);",
        "void main() {",
        "  vec4 c = texture2D(tex, vUv);",
        "  float b = BAYER[int(mod(gl_FragCoord.x, 4.0))][int(mod(gl_FragCoord.y, 4.0))];",
        "  float t = (b - 7.5) / 16.0;",
        "  vec3 lin = clamp(c.rgb, 0.0, 1.0);",
        "  vec3 srg = mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), lin));",
        "  vec3 v = max(floor(srg * 11.0 + t + 0.001), 1.0) / 11.0;",
        "  gl_FragColor = vec4(v, c.a);",
        "}"
      ].join("\n")
    });
    postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));
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
  const mat = new THREE.MeshStandardMaterial({ map: tex.wall, roughness: 0.95 });
  const add = (geo, px, pz) => {
    const mesh = new THREE.Mesh(geo, mat);
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

function buildArenaGeometry() {
  if (selfId < 0 || !world) return;
  const w = world.spec.width, h = world.spec.height;
  const codes = world.spec.codes.toJs();
  const walls = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (codes[y * w + x] === 0) walls.push([x, y]);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(TILE_M, WALL_H, TILE_M),
    new THREE.MeshStandardMaterial({ map: tex.wall, roughness: 0.95 }),
    walls.length
  );
  const m = new THREE.Matrix4();
  walls.forEach(([x, y], i) => {
    m.makeTranslation((x + 0.5) * TILE_M, WALL_H / 2, (y + 0.5) * TILE_M);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  buildDoorArchMeshes(codes, w, h);
  const floorTex = tex.floor.clone();
  floorTex.repeat.set(w, h);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w * TILE_M, h * TILE_M),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((w * TILE_M) / 2, 0, (h * TILE_M) / 2);
  scene.add(floor);
  const ceilTex = tex.ceil.clone();
  ceilTex.repeat.set(w, h);
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(w * TILE_M, h * TILE_M),
    new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 1 })
  );
  ceil.rotation.x = Math.PI / 2;
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
  for (const pr of props) {
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 1.0, 0.55),
      new THREE.MeshStandardMaterial({ color: pr.kind === 1 ? 0x5a4632 : 0x606a70, roughness: 0.9 })
    );
    p.position.set((pr.x + 0.5) * TILE_M, 0.5, (pr.y + 0.5) * TILE_M);
    scene.add(p);
  }
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
    const mat = new THREE.MeshStandardMaterial({ color: e.color, roughness: 0.8 });
    const addBox = (bw, bh, bd, x, y, z) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
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
    groups.set(eid, g);
    scene.add(g);
  }
  g.rotation.y = -((e.yaw / 2048) * Math.PI * 2);
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
    if (g) { scene.remove(g); groups.delete(pid); }
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
  torch.intensity = 88 * (1 + flick);
  if (selfId < 0) return;
  if ((mv.fw || mv.st) && !moveTw.on && now - lastStepAt >= STEP_MS) doStep();
  if (rotTw.on) {
    const t = Math.min(1, (now - rotTw.t0) / ROT_TWEEN_MS);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    yaw = rotTw.from + (rotTw.to - rotTw.from) * e;
    if (t >= 1) { yaw = rotTw.to; rotTw.on = false; }
  }
  let bobY = 0;
  if (moveTw.on) {
    const t = Math.min(1, (now - moveTw.t0) / STEP_TWEEN_MS);
    dispPos[0] = moveTw.fx + (moveTw.tx - moveTw.fx) * t;
    dispPos[1] = moveTw.fy + (moveTw.ty - moveTw.fy) * t;
    bobY = WALK_BOB_AMP * (1 - Math.cos(t * TAU)) / 2;
    if (t >= 1) { dispPos[0] = moveTw.tx; dispPos[1] = moveTw.ty; moveTw.on = false; }
  } else {
    dispPos[0] += (predPos[0] - dispPos[0]) * Math.min(1, dt * 14);
    dispPos[1] += (predPos[1] - dispPos[1]) * Math.min(1, dt * 14);
  }
  camera.position.set((dispPos[0] + 0.5) * TILE_M, EYE_H + bobY, (dispPos[1] + 0.5) * TILE_M);
  camera.rotation.set(0, yaw, 0, "YXZ");
  const nowTick = lastStateTick + (now - lastStateAt) / TICK_MS - INTERP_DELAY_MS / TICK_MS;
  for (const [eid, e] of known) {
    if (eid === selfId) continue;
    const g = groups.get(eid);
    if (!g) continue;
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
  }
  if (hudCount) hudCount.textContent = connected + " online";
  if (postRT) {
    renderer.setRenderTarget(postRT);
    renderer.render(scene, camera);
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
    else if (e.code === "KeyQ") mv.st = -1;
    else if (e.code === "KeyE") mv.st = 1;
    else if (e.code === "KeyA") { turn(1); return; }
    else if (e.code === "KeyD") { turn(-1); return; }
    doStep();
  });
  addEventListener("keyup", (e) => {
    if (e.code === "KeyW" && mv.fw === 1) mv.fw = 0;
    else if (e.code === "KeyS" && mv.fw === -1) mv.fw = 0;
    else if (e.code === "KeyQ" && mv.st === -1) mv.st = 0;
    else if (e.code === "KeyE" && mv.st === 1) mv.st = 0;
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
