"use strict";
// Deterministic motion-blur verification: injects a fog-exempt, unlit stripe
// wall 8 m in front of the camera (far enough that a yaw is a true in-view
// rotation, so the rotation pass shows up in both channels), samples the
// blur uniform every frame (window.__mud), and snapshots the raw 320x256
// render idle, mid-turn (A) and mid-strafe (E). Metrics (devtools/blur_check.js):
// L_h/L_v laplacian must drop during motion — for strafe only L_h (shift is
// horizontal), for the turn both (radial rotation smear).
const puppeteer = require('/Users/user/.nvm/versions/node/v22.13.0/lib/node_modules/puppeteer');
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const URL = process.argv[2] || "http://localhost:18000";
const NAME = process.argv[3] || "blurbot2";
const DIR = path.join(__dirname, "shots");

(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.evaluateOnNewDocument((name) => localStorage.setItem('mudName', name), NAME);
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(
    () => { const l = document.getElementById('loader'); return l && l.style.display === 'none'; },
    { timeout: 90000 }
  );
  await new Promise((r) => setTimeout(r, 2500));
  await page.evaluate(async () => {
    const T = await import("/three.module.js");
    const c = document.createElement("canvas"); c.width = 256; c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 256, 64);
    g.fillStyle = "#000";
    for (let i = 0; i < 8; i++) g.fillRect(i * 32, 0, 16, 64);
    const t = new T.CanvasTexture(c);
    t.magFilter = T.NearestFilter; t.minFilter = T.NearestFilter;
    t.generateMipmaps = false;
    t.wrapS = T.RepeatWrapping;
    const m = new T.MeshBasicMaterial({ map: t, fog: false, side: T.DoubleSide });
    const plane = new T.Mesh(new T.PlaneGeometry(40, 20), m);
    const sc = window.__scene;
    const cam = sc.children.find((o) => o.type === "PerspectiveCamera");
    plane.position.set(0, 0, -8);
    cam.add(plane);
  });
  const ts = await page.evaluate(() => {
    const start = performance.now();
    window.__seq = [];
    window.__marks = [];
    const f = () => {
      const v = window.__mud && window.__mud.blur;
      window.__seq.push([performance.now(), v ? v.x : 0, v ? v.y : 0, v ? v.z : 0]);
      if (performance.now() - start < 12000) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
    return start;
  });
  const mark = (name) => page.evaluate(([n, t0]) => window.__marks.push([performance.now(), n, t0]), [name, ts]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const grab = async (name) => {
    const b64 = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => {
      res(document.getElementById("c").toDataURL("image/png").split(",")[1]);
    })));
    fs.writeFileSync(`${DIR}/${name}.png`, Buffer.from(b64, "base64"));
    console.log("wrote", name);
  };
  await sleep(400);
  await mark("idle");
  await grab("bv_sharp0");
  await page.keyboard.press("a");
  await mark("turn");
  await sleep(25);
  await grab("bv_turn_mid");
  await sleep(700);
  await mark("settled");
  await grab("bv_sharp1");
  await page.keyboard.down("e");
  await mark("strafe");
  await sleep(110);
  await grab("bv_strafe_mid");
  await sleep(70);
  await grab("bv_strafe_mid2");
  await page.keyboard.up("e");
  await sleep(900);
  await grab("bv_sharp2");
  await sleep(500);
  const [seq, marks] = await page.evaluate(() => [window.__seq, window.__marks]);
  const marksAt = (seq, name) => {
    const m = marks.filter((x) => x[1] === name)[0];
    return seq.reduce((a, s) => (Math.abs(s[0] - m[0]) < Math.abs(a[0] - m[0]) ? s : a), seq[0]);
  };
  const ph = (label, a, b) => {
    const win = seq.filter((s) => s[0] >= a[0] - 20 && s[0] <= b[0] + 100);
    if (!win.length) { console.log(label, "NO_SAMPLES"); return; }
    const mx = (i) => win.reduce((p, s) => Math.max(p, Math.abs(s[i])), 0);
    console.log(label + "\t uniform max|x|=" + mx(1).toFixed(3) + " max|y|=" + mx(2).toFixed(3) + " max|z|=" + mx(3).toFixed(3));
  };
  const mIdle = marksAt(seq, "idle"), mTurn = marksAt(seq, "turn"), mSettled = marksAt(seq, "settled"), mStrafe = marksAt(seq, "strafe");
  ph("idle     ", mIdle, mTurn);
  ph("turn     ", mTurn, mSettled);
  ph("strafe   ", mStrafe, seq[seq.length - 1]);
  const files = ["bv_sharp0.png", "bv_turn_mid.png", "bv_sharp1.png", "bv_strafe_mid.png", "bv_strafe_mid2.png", "bv_sharp2.png"];
  console.log(execFileSync(process.execPath, [path.join(__dirname, "blur_check.js"), DIR, ...files], { encoding: "utf8" }));
  console.log(errors.length ? errors.join("\n") : "NO_PAGE_ERRORS");
  await browser.close();
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
