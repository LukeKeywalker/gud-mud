import * as THREE from "./three.module.js";

const TICK_MS = 50;
const TILE_M = 0.25;
const EYE_H = 1.6;
const INTERP_DELAY_MS = 120;
const UNACK_LIMIT = 5;
const SNAP_TILES = 2;
const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const CORE_FILES = ["__init__.py", "constants.py", "world.py", "moves.py", "visibility.py", "protocol.py"];
const name = (localStorage.getItem("mudName") || "wanderer").slice(0, 24);
localStorage.setItem("mudName", name);

let pyodide, core, world, b64d;
let selfId = -1, seq = 0, localTick = 0, lastStateAt = 0, stateCount = 0;
let predPos = [0, 0], dispPos = [0, 0];
let yaw = 0, pitch = 0.15, connected = 0;
const keys = {};
const pending = [];        // { seq, dx, dy }
const known = new Map();   // eid -> { x, y, room, yaw, color, name, ops: [{t,x,y,yaw}] }

let scene, camera, renderer, torch;
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
function brickTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#3b342c";
  g.fillRect(0, 0, 128, 128);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let row = 0; row < 8; row++) {
    const off = (row % 2) * 16;
    for (let col = -1; col < 5; col++) {
      const v = 30 + Math.floor(rnd() * 30);
      g.fillStyle = "rgb(" + (v + 22) + "," + v + "," + (v - 8) + ")";
      g.fillRect(col * 32 + off + 1, row * 16 + 1, 30, 14);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);
  scene.fog = new THREE.FogExp2(0x050505, 0.11);
  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 60);
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  torch = new THREE.PointLight(0xffa64d, 22, 16, 1.6);
  torch.position.set(0.35, -0.35, 0.25);
  camera.add(torch);
  scene.add(camera);
  scene.add(new THREE.AmbientLight(0x39301f, 0.55));
  buildGeometry();
}

function buildGeometry() {
  const w = world.spec.width, h = world.spec.height;
  const codes = world.spec.codes.toJs();
  const walls = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (codes[y * w + x] === 0) walls.push([x, y]);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(TILE_M, 1.0, TILE_M),
    new THREE.MeshStandardMaterial({ map: brickTexture(), roughness: 0.95 }),
    walls.length
  );
  const m = new THREE.Matrix4();
  walls.forEach(([x, y], i) => {
    m.makeTranslation((x + 0.5) * TILE_M, 0.5, (y + 0.5) * TILE_M);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w * TILE_M, h * TILE_M),
    new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((w * TILE_M) / 2, 0, (h * TILE_M) / 2);
  scene.add(floor);
  const props = world.spec.props.toJs();
  for (const pr of props) {
    const kind = pr.kind, x = pr.x, y = pr.y;
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.30, 0.18),
      new THREE.MeshStandardMaterial({ color: kind === 1 ? 0x5a4632 : 0x606a70, roughness: 0.9 })
    );
    p.position.set((x + 0.5) * TILE_M, 0.15, (y + 0.5) * TILE_M);
    scene.add(p);
  }
}

function namePlate(text, color) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = "28px monospace";
  g.textAlign = "center";
  g.fillStyle = "#" + color.toString(16).padStart(6, "0");
  g.fillText(text, 128, 42);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(0.55, 0.14, 1);
  s.position.y = 1.05;
  return s;
}

function syncMesh(eid, e) {
  let g = groups.get(eid);
  if (!g) {
    g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.13, 0.5, 4, 10),
      new THREE.MeshStandardMaterial({ color: e.color, roughness: 0.7 })
    );
    body.position.y = 0.62;
    g.add(body);
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
      yaw = (r[7] / 2048) * Math.PI * 2;
      const blob = toU8(r[2]);
      pyodide.globals.set("mud_blob", b64(blob));
      pyodide.runPython("import base64; mud_blob = base64.b64decode(mud_blob)");
      world = pyodide.runPython("game_core.world.build_world(game_core.protocol.unpack_world_blob(mud_blob))");
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
  stateCount += 1;
  const isResync = kind === 17;
  if (isResync) {
    resyncRequested = false;
    pending.length = 0;
  }
  while (pending.length && pending[0].seq <= ack) pending.shift();
  for (const op of ops) applyOp(op, tick);
  if (selfId >= 0) {
    const me = known.get(selfId);
    if (me) {
      const ddx = predPos[0] - me.x, ddy = predPos[1] - me.y;
      if (ddx !== 0 || ddy !== 0) {
        if (isResync || Math.abs(ddx) <= SNAP_TILES && Math.abs(ddy) <= SNAP_TILES) {
          predPos = [me.x, me.y];
          dispPos = [me.x, me.y];
          pending.length = 0;
        } else if (!resyncRequested) {
          resyncRequested = true;
          ws.send(toU8(core.protocol.pack_resync_req()));
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
function yaw16() {
  let r = (yaw / (Math.PI * 2)) % 1;
  if (r < 0) r += 1;
  return Math.floor(r * 2048) % 2048;
}

function inputDir() {
  let f = 0, r = 0;
  if (keys.KeyW) f += 1;
  if (keys.KeyS) f -= 1;
  if (keys.KeyD) r += 1;
  if (keys.KeyA) r -= 1;
  const fx = Math.sin(yaw), fy = Math.cos(yaw);
  const rx = Math.cos(yaw), ry = -Math.sin(yaw);
  let dx = Math.round(f * fx + r * rx), dy = Math.round(f * fy + r * ry);
  return [Math.max(-1, Math.min(1, dx)), Math.max(-1, Math.min(1, dy))];
}

function simTick() {
  if (selfId < 0 || stateCount === 0) return;
  localTick += 1;
  const [dx, dy] = inputDir();
  const [nx, ny] = core.moves.try_move_at(world, predPos[0], predPos[1], dx, dy, localTick).toJs();
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
  torch.intensity = 21 + Math.sin(now * 0.021) * 2 + (Math.random() - 0.5) * 5;
  if (selfId >= 0) {
    dispPos[0] += (predPos[0] - dispPos[0]) * Math.min(1, dt * 14);
    dispPos[1] += (predPos[1] - dispPos[1]) * Math.min(1, dt * 14);
    camera.position.set((dispPos[0] + 0.5) * TILE_M, EYE_H, (dispPos[1] + 0.5) * TILE_M);
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  }
  const nowTick = localTick + (now - lastStateAt) / TICK_MS;
  for (const [eid, e] of known) {
    if (eid === selfId) continue;
    const g = groups.get(eid);
    if (!g) continue;
    if (e.ops.length >= 2) {
      const a = e.ops[0], b = e.ops[1];
      const t = Math.max(0, Math.min(1, (nowTick - INTERP_DELAY_MS / 20 - a.t) / Math.max(1e-6, b.t - a.t)));
      g.position.set((a.x + (b.x - a.x) * t + 0.5) * TILE_M, 0, (a.y + (b.y - a.y) * t + 0.5) * TILE_M);
    } else if (e.ops.length === 1) {
      g.position.set((e.ops[0].x + 0.5) * TILE_M, 0, (e.ops[0].y + 0.5) * TILE_M);
    }
  }
  if (hudCount) hudCount.textContent = connected + " online";
  renderer.render(scene, camera);
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
  const cvs = renderer.domElement;
  cvs.addEventListener("click", () => cvs.requestPointerLock());
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== cvs) return;
    yaw -= e.movementX * 0.0022;
    pitch -= e.movementY * 0.0022;
    pitch = Math.max(-1.35, Math.min(1.35, pitch));
  });
  addEventListener("keydown", (e) => { keys[e.code] = true; });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  requestAnimationFrame(render);
  setInterval(simTick, TICK_MS);
  loaderEl.style.opacity = "0";
  setTimeout(() => (loaderEl.style.display = "none"), 450);
}

addEventListener("load", () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
  boot();
});
