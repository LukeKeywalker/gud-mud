// Offline WebGL integration check using the real client, assets, and starter map.
// Run: node devtools/shadows_check.cjs (requires Puppeteer).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
let puppeteer;
try { puppeteer = require('puppeteer'); }
catch { puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer'); }
const root = path.resolve(__dirname, '..');
const staticRoot = path.join(root, 'client/static');
const output = path.join(root, '.tmp/shadows');
const rows = fs.readFileSync(path.join(root, 'maps/starter.txt'), 'utf8').trim().split('\n');
const spec = {
  width: rows[0].length, height: rows.length,
  codes: [...rows.join('')].map(c => c === '#' ? 0 : c === 'd' ? 21 : c === 'a' ? 22 : c.charCodeAt(0) - 64),
  props: [{kind: 1, x: 5, y: 4}, {kind: 2, x: 3, y: 3}],
};
const harness = `
export async function setup(spec, fallback = false) {
  await loadEnemyAssets();
  if (!fallback) await loadDungeonAssets();
  world = {spec: {...spec, codes: {toJs: () => spec.codes}, props: {toJs: () => spec.props}}};
  selfId = 1;
  initScene();
  return {scene, camera, renderer, torch, postMat, groups,
    applyOp, updateTorchShadow,
    frame(x = 4, z = 7, angle = 0, now = 1000) {
      predPos = dispPos = [x, z]; yaw = angle;
      render(now);
    }
  };
}
`;
(async () => {
  fs.mkdirSync(output, {recursive: true});
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader']});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewport({width: 800, height: 640});
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = new URL(req.url());
      if (url.pathname === '/favicon.ico') return req.respond({status: 204});
      if (url.pathname === '/') return req.respond({status: 200, contentType: 'text/html', body: '<style>body{margin:0;background:#050505}canvas{image-rendering:pixelated}</style><canvas id="c"></canvas>'});
      const file = path.resolve(staticRoot, '.' + url.pathname);
      if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return req.respond({status: 404, body: ''});
      let body = fs.readFileSync(file);
      if (url.pathname === '/app.js') {
        const source = body.toString();
        const marker = 'addEventListener("load", () => {';
        assert.ok(source.includes(marker));
        body = source.slice(0, source.lastIndexOf(marker)) + harness;
      }
      req.respond({status: 200, contentType: /\.(js|mjs)$/.test(file) ? 'text/javascript' : 'application/json', body});
    });
    const results = [];
    for (const fallback of [false, true]) {
      await page.goto('http://mud-shadow.test/', {waitUntil: 'load'});
      const result = await page.evaluate(async ({spec, fallback}) => {
        // Exercise production frame rendering without booting WASM/networking.
        window.requestAnimationFrame = () => 0;
        const {setup} = await import('/app.js');
        const game = await setup(spec, fallback);
        window.game = game;
        const {scene, camera, renderer, torch, groups} = game;
        const gl = renderer.getContext();
        let shadowDraws = 0, casters = 0, receivers = 0;
        scene.traverse(o => {
          if (o.castShadow && o.isMesh) { casters++; o.onBeforeShadow = () => shadowDraws++; }
          if (o.receiveShadow) receivers++;
        });
        const pixels = () => {
          const p = new Uint8Array(320 * 256 * 4);
          gl.readPixels(0, 0, 320, 256, gl.RGBA, gl.UNSIGNED_BYTE, p);
          return p;
        };
        Math.random = () => 0.5;
        game.frame();
        const initialDraws = shadowDraws;
        const shadowed = pixels();
        game.frame();
        const sameTimeDraws = shadowDraws - initialDraws;
        const idleStart = torch.getWorldPosition(camera.position.clone());
        const cameraStart = camera.position.clone();
        game.frame(4, 7, 0, 1500);
        const idleSwayDraws = shadowDraws - initialDraws;
        const idleSwayDistance = torch.getWorldPosition(camera.position.clone()).distanceTo(idleStart);
        const idleCameraDistance = camera.position.distanceTo(cameraStart);
        game.frame();
        const beforeMovement = shadowDraws;
        game.frame(4.3, 7, 0.2);
        const movingDraws = shadowDraws - beforeMovement;
        game.frame();
        const receiversToRestore = [];
        scene.traverse(o => {
          if (o.receiveShadow) { receiversToRestore.push(o); o.receiveShadow = false; }
        });
        game.frame();
        const unshadowed = pixels();
        let darkened = 0, totalDifference = 0;
        for (let i = 0; i < shadowed.length; i += 4) {
          const d = unshadowed[i] + unshadowed[i+1] + unshadowed[i+2] - shadowed[i] - shadowed[i+1] - shadowed[i+2];
          if (d > 30) darkened++;
          totalDifference += d;
        }
        receiversToRestore.forEach(o => { o.receiveShadow = true; });
        renderer.shadowMap.needsUpdate = true;
        // Invalidate for actor creation, yaw, interpolation, and removal.
        game.applyOp([1, 2, 5, 5, 1, 0, 0x55aa88, 'shadow test'], 1);
        game.frame();
        const actor = groups.get(2);
        let actorCasters = 0;
        actor.traverse(o => { if(o.isMesh && o.castShadow) actorCasters++; });
        let before = shadowDraws;
        game.applyOp([0, 2, 6, 5, 1], 2);
        game.frame();
        const actorMoveDraws = shadowDraws - before;
        game.applyOp([3, 2, 512], 2);
        const rotationDirty = renderer.shadowMap.needsUpdate;
        game.frame();
        game.applyOp([2, 2], 3);
        const removalDirty = renderer.shadowMap.needsUpdate;
        game.frame();
        let weaponCasters = 0;
        camera.traverse(o => { if (o.isMesh && (o.castShadow || o.receiveShadow)) weaponCasters++; });
        const heldTorch = camera.getObjectByName('held-torch');
        const flameSocket = camera.getObjectByName('torch-flame-socket');
        const lightInCamera = camera.worldToLocal(torch.getWorldPosition(camera.position.clone()));
        const torchAttachedToFlame = !!heldTorch && torch.parent === flameSocket;
        // The arch shadow must darken the room without turning its receiving
        // surfaces into a uniform patch of the lowest palette value (23/255).
        // The primitive arch has a much wider opening; view from beside its
        // jamb so the higher, forward-held flame actually falls behind stone.
        const doorwayZ = fallback ? 4 : 5;
        game.frame(7, doorwayZ, -Math.PI / 2);
        const doorway = pixels();
        receiversToRestore.forEach(o => { o.receiveShadow = false; });
        game.frame(7, doorwayZ, -Math.PI / 2);
        const doorwayLit = pixels();
        let doorwayShadowPixels = 0, crushedShadowPixels = 0;
        for (let i = 0; i < doorway.length; i += 4) {
          const loss = doorwayLit[i] + doorwayLit[i+1] + doorwayLit[i+2]
            - doorway[i] - doorway[i+1] - doorway[i+2];
          if (loss <= 30) continue;
          doorwayShadowPixels++;
          if (Math.max(doorway[i], doorway[i+1], doorway[i+2]) <= 24) crushedShadowPixels++;
        }
        receiversToRestore.forEach(o => { o.receiveShadow = true; });
        game.frame();
        return {fallback, casters, receivers, initialDraws, sameTimeDraws, movingDraws,
          idleSwayDraws, idleSwayDistance, idleCameraDistance,
          torchAttachedToFlame, lightInCamera: lightInCamera.toArray(),
          darkened, totalDifference, actorCasters, actorMoveDraws, rotationDirty, removalDirty,
          doorwayShadowPixels, crushedShadowFraction: crushedShadowPixels / doorwayShadowPixels,
          weaponCasters, shadowSize: [torch.shadow.map.width, torch.shadow.map.height],
          glError: gl.getError()};
      }, {spec, fallback});
      await page.screenshot({path: path.join(output, fallback ? 'fallback.png' : 'dungeon.png')});
      await page.evaluate(fallback => window.game.frame(7, fallback ? 4 : 5, -Math.PI / 2), fallback);
      await page.screenshot({path: path.join(output, fallback ? 'fallback-doorway.png' : 'doorway.png')});
      assert.ok(result.initialDraws > 0);
      assert.equal(result.sameTimeDraws, 0, 'an unchanged light transform must reuse its shadow atlas');
      assert.equal(result.idleCameraDistance, 0, 'idle shadow sway must not move the camera');
      assert.ok(result.idleSwayDistance > 0.005 && result.idleSwayDistance < 0.1, 'idle torch motion must be subtle but nonzero');
      assert.ok(result.idleSwayDraws > 0, 'idle hand movement must update geometry shadows');
      assert.ok(result.movingDraws > 0, 'moving torch must update shadows');
      assert.ok(result.darkened > 500, 'geometry must visibly block torch light');
      assert.ok(result.totalDifference > 0);
      assert.ok(result.doorwayShadowPixels > 200, 'the arch must still cast a visible shadow from the held flame');
      assert.ok(result.crushedShadowFraction < 0.5, 'most shadowed surfaces must retain color/detail');
      assert.equal(result.actorCasters, 6);
      assert.ok(result.actorMoveDraws > 0, 'moving actor must invalidate shadows');
      assert.equal(result.rotationDirty, true);
      assert.equal(result.removalDirty, true);
      assert.equal(result.weaponCasters, 0);
      assert.equal(result.torchAttachedToFlame, true, 'the light must be attached to the held flame');
      assert.ok(result.lightInCamera[0] < 0 && result.lightInCamera[2] < 0, 'torch must be held on the left, in front of the player');
      assert.equal(result.glError, 0);
      results.push(result);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(results, null, 2));
    console.log('PASS: geometry occlusion, moving lights/actors, shadow cache, fallback assets, WebGL shaders.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
