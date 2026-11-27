// plan2walk viewer: baked-lighting house, first-person walk, guided tour, dollhouse, minimap, tape measure.
// Plan coords (inches, x right, y toward the rear, z up) map to three.js as X = x, Y = z, Z = -y (meters).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const IN = 0.0254;
const P = (x, y, z) => new THREE.Vector3(x * IN, z * IN, -y * IN);
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia("(pointer: coarse)").matches;

// ---------------------------------------------------------------- if anything fails, say so on the loading card
function fail(why) {
  const t = $("load-title"), s = $("load-sub"), b = document.querySelector("#loading .bar");
  if (!t) return;
  t.textContent = "The 3D tour couldn't open on this device";
  s.innerHTML = why + "<br><br>Try Chrome or Safari with graphics acceleration on (Chrome: Settings → System → " +
    "\"Use graphics acceleration when available\"), or open the link on your phone.";
  if (b) b.style.display = "none";
}
addEventListener("error", (e) => fail("Something went wrong while loading (" + (e.message || "error") + ")."));
addEventListener("unhandledrejection", (e) => fail("A file didn't load (" + ((e.reason && e.reason.message) || e.reason || "network") + ")."));

// ---------------------------------------------------------------- renderer / scene
const canvas = $("c");
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch, powerPreference: "high-performance" });
} catch (e) {
  fail("This browser has 3D graphics (WebGL) turned off or unavailable.");
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 600);
camera.rotation.order = "YXZ";

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.fov = w < h ? 80 : 70; camera.updateProjectionMatrix();
}
addEventListener("resize", resize); resize();

// ---------------------------------------------------------------- loading
const manager = new THREE.LoadingManager();
manager.onProgress = (url, done, total) => {
  const bar = $("load-bar"), sub = $("load-sub");
  if (bar) bar.style.width = `${(100 * done) / total}%`;
  if (sub) sub.textContent = `Loading ${done} of ${total} files`;
};
const gltfLoader = new GLTFLoader(manager);
const draco = new DRACOLoader(manager); draco.setDecoderPath("./vendor/jsm/libs/draco/");
gltfLoader.setDRACOLoader(draco);
const texLoader = new THREE.TextureLoader(manager);

const data = await (await fetch("./data/scene.json")).json();
const client = await fetch("./data/client.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
$("house-name").textContent = data.name;
document.title = `${data.name} — 3D Walkthrough`;

const groups = {};            // LM_walls, LM_roof, ... -> Object3D
let houseRoot;
const [gltf, envTex, bgTex, lmMeta] = await Promise.all([
  gltfLoader.loadAsync("./assets/house.glb"),
  new RGBELoader(manager).loadAsync("./assets/sky_1k.hdr"),
  texLoader.loadAsync("./assets/sky_bg.jpg"),
  fetch("./assets/lightmaps.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
]);

const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromEquirectangular(envTex).texture; envTex.dispose();
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // neutral studio reflections for indoor metal/glass
bgTex.mapping = THREE.EquirectangularReflectionMapping; bgTex.colorSpace = THREE.SRGBColorSpace;
scene.background = bgTex;

let horizonLawn = null;
houseRoot = gltf.scene; scene.add(houseRoot);
// horizon-wide lawn beyond the baked 64 m ground; color matched to the lit lawn, fades into the sky haze
{
  const g = new THREE.Mesh(new THREE.CircleGeometry(2000, 64), new THREE.MeshBasicMaterial({ color: 0x8faa62, toneMapped: false }));
  g.rotation.x = -Math.PI / 2; g.position.y = (data.grade_z - 0.6) * IN; scene.add(g);
  horizonLawn = g;
  scene.fog = new THREE.Fog(0xc9d6de, 120, 900);
}
const lmCache = {}, matCache = {};
const GRASS_TINT = [0.36, 0.86, 0.30];     // pulls the (straw-coloured) grass photo to the lawn green of the stills
const meshes = [];
houseRoot.traverse((o) => {
  const top = topGroup(o);
  if (top) groups[top.name] = top;
  if (!o.isMesh) return;
  meshes.push(o);
  const g = top ? top.name : "";
  const meta = lmMeta[g];
  // materials are shared across groups in the GLB, but each group has its own light-map atlas: one copy per group
  const own = (m) => { const k = m.uuid + "|" + g; return matCache[k] || (matCache[k] = m.clone()); };
  if (Array.isArray(o.material)) o.material = o.material.map(own); else o.material = own(o.material);
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  mats.forEach((m) => {
    m.vertexColors = false;
    if (meta) {
      if (!lmCache[g]) {
        const t = texLoader.load(`./assets/${meta.file}`);
        t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.channel = 1; t.anisotropy = 4;
        lmCache[g] = t;
      }
      m.lightMap = lmCache[g];
      m.lightMapIntensity = meta.max * Math.PI;       // file stores (E / max)^(1/2.2); three divides by PI in the Lambert term
      m.envMap = null;
      // extra BRDF lobes (clearcoat / sheen) need real-time lights or an env map; with baked light they only add artifacts
      if ("clearcoat" in m) { m.clearcoat = 0; m.sheen = 0; m.iridescence = 0; }
    }
    const glossy = m.metalness > 0.3 || m.roughness < 0.25;
    const outdoor = g === "LM_roof" || g === "LM_site";
    if (glossy) { m.envMap = outdoor ? envMap : roomEnv; m.envMapIntensity = m.metalness > 0.3 ? 0.55 : 0.18; }
    if (m.transmission > 0) {   // cheap window glass for phones: no transmission pass
      m.transmission = 0; m.transparent = true; m.opacity = 0.12; m.roughness = 0.02; m.metalness = 0;
      m.envMap = envMap; m.envMapIntensity = 1.0; m.depthWrite = false;
    }
    if (m.emissiveIntensity > 0 && m.emissive && m.emissive.getHex() > 0) m.toneMapped = true;
  });
});
// textured lawn: the bake carries the light, a grass photo carries the albedo (3 scales mixed to hide tiling)
const groundGrp = groups["LM_ground"];
if (groundGrp) {
  const gt = texLoader.load("./assets/grass.jpg");
  gt.colorSpace = THREE.SRGBColorSpace; gt.wrapS = gt.wrapT = THREE.RepeatWrapping; gt.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const v = new THREE.Vector3();
  groundGrp.traverse((o) => {
    if (!o.isMesh) return;
    o.updateWorldMatrix(true, false);
    const pos = o.geometry.attributes.position, uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); uv[2 * i] = v.x / 1.4; uv[2 * i + 1] = v.z / 1.4; }
    o.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      m.map = gt; m.color.setRGB(GRASS_TINT[0], GRASS_TINT[1], GRASS_TINT[2]);
      m.onBeforeCompile = lawnShader;
      m.needsUpdate = true;
    });
  });
  // the far lawn ring: same grass, lit by the bake's typical open-lawn irradiance so the 64 m edge disappears
  if (horizonLawn) {
    const E = lmMeta.LM_ground ? lmMeta.LM_ground.median : 2.2;
    const ht = texLoader.load("./assets/grass.jpg"); ht.colorSpace = THREE.SRGBColorSpace; ht.wrapS = ht.wrapT = THREE.RepeatWrapping; ht.repeat.set(4000 / 1.4, 4000 / 1.4);
    const hm = horizonLawn.material;
    hm.map = ht; hm.toneMapped = true; hm.color.setRGB(GRASS_TINT[0] * E, GRASS_TINT[1] * E, GRASS_TINT[2] * E);
    hm.onBeforeCompile = lawnShader; hm.needsUpdate = true;
  }
}
// web boxwoods are low-poly balls: the leafy-grass photo, tinted deep green, reads as clipped leaves
{
  const bt = texLoader.load("./assets/grass.jpg");
  bt.colorSpace = THREE.SRGBColorSpace; bt.wrapS = bt.wrapT = THREE.RepeatWrapping; bt.repeat.set(5, 2.5); bt.anisotropy = 4;
  houseRoot.traverse((o) => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (!/^Boxwood/.test(m.name) || m.map) return;
      const dark = m.name === "Boxwood2" ? 0.95 : 0.82;
      m.map = bt; m.color.setRGB(0.16 * dark, 0.42 * dark, 0.13 * dark); m.needsUpdate = true;
    });
  });
}
function lawnShader(sh) {
  sh.fragmentShader = sh.fragmentShader.replace("#include <map_fragment>", `
    vec3 g1 = texture2D(map, vMapUv).rgb;
    vec3 g2 = texture2D(map, vMapUv * 0.137 + vec2(0.31, 0.57)).rgb;
    vec3 g3 = texture2D(map, vMapUv * 0.019 + vec2(0.71, 0.23)).rgb;
    float lawnVar = clamp(dot(g3, vec3(0.333)) / 0.21 - 0.5, 0.0, 1.0);
    diffuseColor.rgb *= mix(g1, g2, 0.45) * mix(0.82, 1.14, lawnVar);`);
}
// unlit group (bulbs, lamp shades, glass): shades glow softly
const unlit = groups["UNLIT_glass_glow"];
if (unlit) unlit.traverse((o) => { if (o.isMesh && o.material && /Shade/i.test(o.material.name)) o.material = new THREE.MeshBasicMaterial({ color: 0xfff1dc }); });

// ---------------------------------------------------------------- billboard trees (Cycles-rendered cut-outs)
const billboards = [];
try {
  const [placed, imps] = await Promise.all([
    fetch("./assets/trees/trees.json").then((r) => r.json()),
    fetch("./assets/trees/impostors.json").then((r) => r.json()),
  ]);
  const mats = {};
  // soft contact shadow under each tree (trees are not in the light bake)
  const cv = document.createElement("canvas"); cv.width = cv.height = 128;
  const cx = cv.getContext("2d"), gr = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(0,0,0,0.55)"); gr.addColorStop(0.45, "rgba(0,0,0,0.38)"); gr.addColorStop(1, "rgba(0,0,0,0)");
  cx.fillStyle = gr; cx.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(cv);
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, color: 0x0d1a08, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const [id, m] of Object.entries(imps)) {
    const t = texLoader.load(`./assets/trees/${m.file}`); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    mats[id] = new THREE.MeshBasicMaterial({ map: t, alphaTest: 0.45, side: THREE.DoubleSide, toneMapped: false });
  }
  for (const tr of placed) {
    const m = imps[tr.model]; if (!m) continue;
    const h = tr.height * 1.02 * IN, w = h * m.aspect;
    const g = new THREE.PlaneGeometry(w, h); g.translate(0, h / 2, 0);
    const mesh = new THREE.Mesh(g, mats[tr.model]);
    mesh.position.copy(P(tr.x, tr.y, data.grade_z - 1));
    scene.add(mesh); billboards.push(mesh);
    const sh = new THREE.Mesh(shadowGeo, shadowMat);
    sh.rotation.x = -Math.PI / 2; sh.scale.setScalar(h * 0.62);
    sh.position.copy(P(tr.x, tr.y, data.grade_z + 0.4)); sh.renderOrder = 1; scene.add(sh);
  }
} catch (e) { console.warn("no billboard trees", e); }

function topGroup(o) { while (o.parent && o.parent !== houseRoot) o = o.parent; return o.parent === houseRoot ? o : null; }

// ---------------------------------------------------------------- collision + floors (plan inches)
const segs = [];
for (const ring of data.collision) for (let i = 0; i < ring.length - 1; i++) segs.push([ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]]);
const CELL = 48, grid = new Map();
segs.forEach((s, i) => {
  const x0 = Math.floor(Math.min(s[0], s[2]) / CELL) - 1, x1 = Math.floor(Math.max(s[0], s[2]) / CELL) + 1;
  const y0 = Math.floor(Math.min(s[1], s[3]) / CELL) - 1, y1 = Math.floor(Math.max(s[1], s[3]) / CELL) + 1;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + "," + y; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
});
const RADIUS = 9;   // inches
function collide(px, py) {
  for (let it = 0; it < 3; it++) {
    const k = Math.floor(px / CELL) + "," + Math.floor(py / CELL);
    for (const i of grid.get(k) || []) {
      const [ax, ay, bx, by] = segs[i];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
      let t = ((px - ax) * dx + (py - ay) * dy) / L; t = Math.max(0, Math.min(1, t));
      const cx = ax + dx * t, cy = ay + dy * t, ex = px - cx, ey = py - cy, d = Math.hypot(ex, ey);
      if (d < RADIUS && d > 1e-6) { px = cx + (ex / d) * RADIUS; py = cy + (ey / d) * RADIUS; }
    }
  }
  return [px, py];
}
function floorAt(x, y) {
  for (const [x0, y0, x1, y1, z] of data.zones) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return z;
  return data.grade_z;
}
function roomAt(x, y) {
  for (const r of data.rooms) if (inPoly(x, y, r.polygon)) return r;
  return null;
}
function inPoly(x, y, P) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++)
    if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
  return c;
}

// ---------------------------------------------------------------- player state
const me = { x: data.spawn.pos[0], y: data.spawn.pos[1], z: data.spawn.pos[2] - data.eye, yaw: data.spawn.yaw, pitch: 0 };
let eyeZ = floorAt(me.x, me.y) + data.eye;
function applyCamera() {
  camera.position.copy(P(me.x, me.y, eyeZ));
  camera.rotation.set(me.pitch, me.yaw - Math.PI / 2, 0);
}

// ---------------------------------------------------------------- modes
function dollPose() {
  const [fx0, fy0, fx1, fy1] = data.footprint, k = Math.max(1, (fx1 - fx0) / 578.5);
  const mx = (fx0 + fx1) / 2, my = (fy0 + fy1) / 2;
  return { target: P(mx, my, 40), pos: P(mx - 250 * k, my - 620 * k, 760 * k) };
}
let mode = "walk";            // walk | tour | doll
const orbit = new OrbitControls(camera, canvas);
orbit.enabled = false; orbit.enableDamping = true; orbit.maxPolarAngle = Math.PI * 0.48;
orbit.minDistance = 4; orbit.maxDistance = 45 * Math.max(1, (data.footprint[2] - data.footprint[0]) / 578.5);
const toggles = { roof: true, ceil: true, furn: true };
function setVis() {
  const doll = mode === "doll";
  if (groups.LM_roof) groups.LM_roof.visible = toggles.roof && !doll;
  if (groups.LM_ceilings) groups.LM_ceilings.visible = toggles.ceil && !doll;
  if (groups.LM_furniture) groups.LM_furniture.visible = toggles.furn;
  $("tg-roof").classList.toggle("on", toggles.roof && !doll);
  $("tg-ceil").classList.toggle("on", toggles.ceil && !doll);
  $("tg-furn").classList.toggle("on", toggles.furn);
}
function setMode(m) {
  if (mode === "walk" && document.pointerLockElement) document.exitPointerLock();
  mode = m;
  ["btn-tour", "btn-walk", "btn-doll"].forEach((id) => $(id).classList.remove("on"));
  $({ tour: "btn-tour", walk: "btn-walk", doll: "btn-doll" }[m]).classList.add("on");
  orbit.enabled = m === "doll";
  $("tour-bar").classList.toggle("hidden", m !== "tour");
  $("joystick").classList.toggle("hidden", !(isTouch && m === "walk"));
  if (m === "doll") {
    const d = dollPose();
    orbit.target.copy(d.target); camera.position.copy(d.pos);
    camera.up.set(0, 1, 0);
    orbit.update();
  }
  if (m === "tour") { tourT = 0; fly = null; music.start(); }
  if (m !== "tour") showStop(null);
  setVis();
}
$("btn-walk").onclick = () => { setMode("walk"); hint(isTouch ? "Drag the circle to walk, drag the view to look" : "Click the view, then W A S D + mouse"); };
$("btn-doll").onclick = () => setMode("doll");
$("btn-tour").onclick = () => setMode(mode === "tour" ? "walk" : "tour");
$("tg-roof").onclick = () => { toggles.roof = !toggles.roof; setVis(); };
$("tg-ceil").onclick = () => { toggles.ceil = !toggles.ceil; setVis(); };
$("tg-furn").onclick = () => { toggles.furn = !toggles.furn; setVis(); };
$("btn-help").onclick = () => $("help").classList.remove("hidden");
$("btn-layers").onclick = (e) => { e.stopPropagation(); $("layers").classList.toggle("hidden"); $("btn-layers").classList.toggle("on", !$("layers").classList.contains("hidden")); };
addEventListener("pointerdown", (e) => { if (!$("layers").contains(e.target) && e.target.closest("#btn-layers") === null) { $("layers").classList.add("hidden"); $("btn-layers").classList.remove("on"); } });
$("help-close").onclick = () => $("help").classList.add("hidden");

let hintTimer;
function hint(msg, ms = 2600) { const h = $("hint"); h.textContent = msg; h.classList.remove("hidden"); clearTimeout(hintTimer); hintTimer = setTimeout(() => h.classList.add("hidden"), ms); }

// ---------------------------------------------------------------- input: keyboard + mouse
const keys = new Set();
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  keys.add(e.code);
  const k = e.key.toLowerCase();
  if (k === "t") $("btn-tour").click();
  if (k === "o") $("btn-doll").click();
  if (k === "m") $("btn-measure").click();
  if (k === "r") $("tg-roof").click();
  if (k === "c") $("tg-ceil").click();
  if (k === "f") $("tg-furn").click();
  if (k === "?") $("btn-help").click();
  if (mode === "tour" && ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) setMode("walk");
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());

canvas.addEventListener("click", () => {
  if (measuring) return;
  if (mode === "tour") { setMode("walk"); return; }
  if (mode === "walk" && !isTouch && !document.pointerLockElement) canvas.requestPointerLock();
});
document.addEventListener("pointerlockchange", () => document.body.classList.toggle("locked", !!document.pointerLockElement));
addEventListener("mousemove", (e) => {
  if (mode !== "walk" || document.pointerLockElement !== canvas) return;
  me.yaw -= e.movementX * 0.0022; me.pitch = clampPitch(me.pitch - e.movementY * 0.0022);
});
const clampPitch = (p) => Math.max(-1.2, Math.min(1.2, p));

// ---------------------------------------------------------------- input: touch (joystick + drag-to-look)
const joy = { id: null, x: 0, y: 0 }, look = { id: null, x: 0, y: 0 };
const stick = $("stick"), jbox = $("joystick");
jbox.addEventListener("pointerdown", (e) => { joy.id = e.pointerId; jbox.setPointerCapture(e.pointerId); moveJoy(e); });
jbox.addEventListener("pointermove", (e) => { if (e.pointerId === joy.id) moveJoy(e); });
const endJoy = (e) => { if (e.pointerId === joy.id) { joy.id = null; joy.x = joy.y = 0; stick.style.transform = ""; } };
jbox.addEventListener("pointerup", endJoy); jbox.addEventListener("pointercancel", endJoy);
function moveJoy(e) {
  const r = jbox.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = (e.clientX - cx) / (r.width / 2), dy = (e.clientY - cy) / (r.height / 2); const L = Math.hypot(dx, dy);
  if (L > 1) { dx /= L; dy /= L; }
  joy.x = dx; joy.y = dy; stick.style.transform = `translate(${dx * 35}px, ${dy * 35}px)`;
  if (mode === "tour") setMode("walk");
}
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" || mode !== "walk" && mode !== "tour") return;
  look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY; look.moved = 0;
});
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerId !== look.id) return;
  const dx = e.clientX - look.x, dy = e.clientY - look.y; look.x = e.clientX; look.y = e.clientY; look.moved += Math.abs(dx) + Math.abs(dy);
  if (look.moved > 6 && mode === "tour") setMode("walk");
  if (mode === "walk") { me.yaw += dx * 0.005; me.pitch = clampPitch(me.pitch + dy * 0.005); }
});
const endLook = (e) => { if (e.pointerId === look.id) look.id = null; };
canvas.addEventListener("pointerup", endLook); canvas.addEventListener("pointercancel", endLook);

// ---------------------------------------------------------------- guided tour (same path as the video)
let tourT = 0;
const tour = data.tour.frames, tourLen = (tour.length - 1) / data.tour.fps;
// Guided tour = the video path, plus a pause in each main room (card: name, size, one selling point),
// then the camera rises out through the roof to the dollhouse.
const STOP = 3.4, FLY = 4.5;
let stops = null, tourTotal = tourLen + FLY, fly = null, shownStop;
function buildStops() {
  stops = []; const seen = new Set(), fps = data.tour.fps; let run = null;
  // pause where the view is most open: the frame in the room run farthest from any wall (not mid-doorway)
  const segs = [];
  for (const ring of data.walls) for (let i = 0; i + 1 < ring.length; i++) segs.push([ring[i], ring[i + 1]]);
  const clearance = (x, y) => {
    let d = 1e9;
    for (const [[ax, ay], [bx, by]] of segs) {
      const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2));
      d = Math.min(d, Math.hypot(x - ax - t * vx, y - ay - t * vy));
    }
    return d;
  };
  const flush = () => {
    if (!run || run.n < fps * 0.4) return;
    const r = run.r, key = r.name.toLowerCase();
    if (seen.has(key) || (!r.highlight && /closet|hall|pantry|mech|stair|foyer|entry/i.test(r.name))) return;
    let best = run.i0 + Math.floor(run.n * 0.55), bc = -1;
    for (let i = run.i0 + Math.floor(run.n * 0.15); i < run.i0 + run.n * 0.9; i++) {
      const c = clearance(tour[i][0], tour[i][1]); if (c > bc) { bc = c; best = i; }
    }
    seen.add(key); stops.push({ raw: best / fps, room: r });
  };
  for (let i = 0; i < tour.length; i++) {
    const r = roomAt(tour[i][0], tour[i][1]);
    if (r && run && run.r === r) run.n++;
    else { flush(); run = r ? { r, i0: i, n: 1 } : null; }
  }
  flush();
  tourTotal = tourLen + stops.length * STOP + FLY;
}
function tourClock(T) {            // tour time (with pauses) -> path time
  let shift = 0;
  for (const s of stops) {
    const a = s.raw + shift;
    if (T < a) break;
    if (T < a + STOP) return { raw: s.raw, stop: s, u: (T - a) / STOP };
    shift += STOP;
  }
  return { raw: Math.min(tourLen, T - shift), stop: null, u: 0 };
}
const ease = (u) => u * u * (3 - 2 * u);
function flyToDoll(u) {
  if (!fly) {
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    fly = { pos: camera.position.clone(), look: camera.position.clone().addScaledVector(dir, 3) };
    if (groups.LM_roof) groups.LM_roof.visible = false;
    if (groups.LM_ceilings) groups.LM_ceilings.visible = false;
  }
  const d = dollPose(), e = ease(Math.min(1, u));
  camera.position.lerpVectors(fly.pos, d.pos, e);
  camera.lookAt(new THREE.Vector3().lerpVectors(fly.look, d.target, e));
}
function sqft(n) { return `${Math.round(n).toLocaleString()} sq ft`; }
function showStop(st) {
  if (st === shownStop) return; shownStop = st;
  const c = $("stop-card");
  if (!st) { c.classList.remove("on"); return; }
  const r = st.room;
  $("stop-name").textContent = r.name.replace("Living / Dining / Kitchen", "Living, Dining & Kitchen");
  $("stop-size").textContent = [r.size.replace(/\.0'/g, "'"), r.sqft ? sqft(r.sqft) : ""].filter(Boolean).join("  ·  ");
  $("stop-hl").textContent = (client && client.highlights && client.highlights[r.name]) || r.highlight || "";
  c.classList.add("on");
}
function stopCard(st) {        // what the video recorder draws over a frame
  if (!st) return null;
  const r = st.room;
  return { name: r.name.replace("Living / Dining / Kitchen", "Living, Dining & Kitchen"), size: [r.size.replace(/\.0'/g, "'"), r.sqft ? sqft(r.sqft) : ""].filter(Boolean).join("  ·  "),
           hl: (client && client.highlights && client.highlights[r.name]) || r.highlight || "" };
}
function tourPose(t) {
  const f = Math.min(tour.length - 1.001, t * data.tour.fps), i = Math.floor(f), a = f - i;
  const A = tour[i], B = tour[i + 1];
  const L = (k) => A[k] + (B[k] - A[k]) * a;
  return { x: L(0), y: L(1), z: L(2), yaw: L(3), pitch: L(4) };
}

// ---------------------------------------------------------------- tape measure
let measuring = false, mPts = [], mLine, mDots = [];
const ray = new THREE.Raycaster();
$("btn-measure").onclick = () => {
  measuring = !measuring; $("btn-measure").classList.toggle("on", measuring);
  document.body.classList.toggle("measuring", measuring);
  clearMeasure();
  if (measuring) hint(isTouch ? "Tap two points to measure" : document.pointerLockElement ? "Aim the cross and click two points" : "Click two points to measure", 3200);
};
function clearMeasure() {
  mPts = []; mDots.forEach((d) => scene.remove(d)); mDots = []; if (mLine) scene.remove(mLine); mLine = null; $("measure-label").classList.add("hidden");
}
const dotGeo = new THREE.SphereGeometry(0.025, 16, 12), dotMat = new THREE.MeshBasicMaterial({ color: 0xff3b30, depthTest: false });
canvas.addEventListener("pointerup", (e) => {
  if (!measuring) return;
  if (look.moved > 8) return;
  const ndc = document.pointerLockElement ? new THREE.Vector2(0, 0)
    : new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(meshes.filter((m) => m.visible && isShown(m)), false).find((h) => !(h.object.material.transparent));
  if (!hit) return;
  if (mPts.length === 2) clearMeasure();
  mPts.push(hit.point.clone());
  const d = new THREE.Mesh(dotGeo, dotMat); d.position.copy(hit.point); d.renderOrder = 10; scene.add(d); mDots.push(d);
  if (mPts.length === 2) {
    const g = new THREE.BufferGeometry().setFromPoints(mPts);
    mLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff3b30, depthTest: false })); mLine.renderOrder = 10; scene.add(mLine);
    $("measure-label").textContent = ftIn(mPts[0].distanceTo(mPts[1]) / IN);
    $("measure-label").classList.remove("hidden");
  }
});
function isShown(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }
function ftIn(inches) {
  const s = Math.round(inches * 4) / 4; let ft = Math.floor(s / 12), i = s - ft * 12;
  const whole = Math.floor(i), frac = i - whole, fr = { 0: "", 0.25: " 1/4", 0.5: " 1/2", 0.75: " 3/4" }[frac] ?? "";
  return `${ft}' - ${whole}${fr}"`;
}
function placeMeasureLabel() {
  if (mPts.length !== 2) return;
  const m = mPts[0].clone().add(mPts[1]).multiplyScalar(0.5).project(camera);
  const el = $("measure-label");
  if (m.z > 1) { el.style.display = "none"; return; }
  el.style.display = ""; el.style.left = `${(m.x * 0.5 + 0.5) * innerWidth}px`; el.style.top = `${(-m.y * 0.5 + 0.5) * innerHeight}px`;
}

// ---------------------------------------------------------------- minimap
const mm = $("minimap"), mctx = mm.getContext("2d");
let mmT = null;
function mmLayout() {
  const dpr = Math.min(devicePixelRatio, 2), w = mm.clientWidth, h = mm.clientHeight;
  mm.width = w * dpr; mm.height = h * dpr;
  const [x0, y0, x1, y1] = [data.footprint[0] - 20, Math.min(data.porch[1], data.footprint[1]) - 16, data.footprint[2] + 20, data.footprint[3] + 20];
  const s = Math.min((w - 16) / (x1 - x0), (h - 16) / (y1 - y0));
  const ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
  mmT = { s, dpr, toPx: (x, y) => [ox + (x - x0) * s, h - (oy + (y - y0) * s)], toPlan: (px, py) => [x0 + (px - ox) / s, y0 + (h - py - oy) / s] };
}
function drawMinimap() {
  if (!mmT) mmLayout();
  const { dpr, toPx, s } = mmT; const c = mctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, mm.width, mm.height);
  const here = roomAt(me.x, me.y);
  // porch
  const pr = data.porch; let [a, b] = toPx(pr[0], pr[1]), [cx, cy] = toPx(pr[2], pr[3]);
  c.fillStyle = "#dcdcd6"; c.fillRect(a, cy, cx - a, b - cy);
  for (const r of data.rooms) {
    c.beginPath(); r.polygon.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? c.lineTo(px, py) : c.moveTo(px, py); });
    c.closePath(); c.fillStyle = r === here ? "#c9d6cc" : "#f3f1ec"; c.fill();
  }
  c.fillStyle = "#2a302d";
  for (const ring of data.walls) { c.beginPath(); ring.forEach(([x, y], i) => { const [px, py] = toPx(x, y); i ? c.lineTo(px, py) : c.moveTo(px, py); }); c.closePath(); c.fill("evenodd"); }
  if (s > 0.3) {
    c.font = `600 ${Math.max(8, Math.min(11, s * 22))}px -apple-system, sans-serif`; c.textAlign = "center"; c.fillStyle = "#3e4a44";
    for (const r of data.rooms) {
      if (/Closet|Pantry/.test(r.name) && s < 0.45) continue;
      const [px, py] = toPx(r.label[0], r.label[1]);
      c.fillText(r.name.replace("Living / Dining / Kitchen", "Living / Kitchen").replace("Master ", "Primary "), px, py);
    }
  }
  // you are here
  const [px, py] = toPx(me.x, me.y), dir = mode === "doll" ? null : me.yaw;
  if (dir !== null) {
    c.fillStyle = "rgba(220,60,40,.22)"; c.beginPath(); c.moveTo(px, py);
    c.arc(px, py, 26, -dir - 0.6, -dir + 0.6); c.closePath(); c.fill();
  }
  c.fillStyle = "#dc3c28"; c.strokeStyle = "#fff"; c.lineWidth = 2; c.beginPath(); c.arc(px, py, 5, 0, Math.PI * 2); c.fill(); c.stroke();
}
addEventListener("resize", () => { mmT = null; });
// jump to a room: stand in a corner, face the room center (minimap click, Go-to menu, #room= links)
function jumpToRoom(room) {
  const xs = room.polygon.map((p) => p[0]), ys = room.polygon.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  let [tx, ty] = collide(room.label[0], room.label[1]);
  const corner = [Math.min(...xs) + 18, Math.min(...ys) + 18];
  if (inPoly(corner[0], corner[1], room.polygon)) [tx, ty] = collide(...corner);
  jumpTo(tx, ty, Math.atan2(cy - ty, cx - tx), room.name);
}
function jumpTo(x, y, yaw, label) {
  me.x = x; me.y = y; me.yaw = yaw; me.pitch = -0.05;
  eyeZ = floorAt(me.x, me.y) + data.eye;
  setMode("walk"); applyCamera(); if (label) hint(label);
}
const fp = data.footprint, frontX = doorMetaX();
function doorMetaX() { const d = (typeof lmMeta !== "undefined" && lmMeta.__door__) || null; return d ? d.hinge[0] : (data.footprint[0] + data.footprint[2]) / 2; }
const PLACES = [
  { name: "Front yard", go: () => jumpTo(frontX + 40, Math.min(data.porch[1], fp[1]) - 640, Math.PI / 2, "Front yard") },
  { name: "Front porch", go: () => jumpTo(frontX, (data.porch[1] + fp[1]) / 2, Math.PI / 2, "Front porch") },
  ...data.rooms.filter((r) => !/closet|pantry|mech|w\.?i\.?c|linen|vest|master hall|primary hall/i.test(r.name))
    .filter((r, i, a) => a.findIndex((q) => q.name === r.name) === i)
    .map((r) => ({ name: r.name.replace("Living / Dining / Kitchen", "Living / Kitchen").replace("Master ", "Primary "), go: () => jumpToRoom(r) })),
  { name: "Whole house (dollhouse)", go: () => setMode("doll") },
];
$("goto").innerHTML = PLACES.map((p, i) => `<button data-i="${i}">${p.name.replace(/[<>&]/g, "")}</button>`).join("");
$("goto").querySelectorAll("button").forEach((b) => b.onclick = (e) => { e.stopPropagation(); PLACES[+b.dataset.i].go(); $("goto").classList.add("hidden"); $("btn-goto").classList.remove("on"); });
$("btn-goto").onclick = (e) => { e.stopPropagation(); $("goto").classList.toggle("hidden"); $("btn-goto").classList.toggle("on", !$("goto").classList.contains("hidden")); };
addEventListener("pointerdown", (e) => { if (!$("goto").contains(e.target) && e.target.closest("#btn-goto") === null) { $("goto").classList.add("hidden"); $("btn-goto").classList.remove("on"); } });
{ const m = /[#&]room=([^&]+)/.exec(location.hash); if (m) { const want = decodeURIComponent(m[1]).toLowerCase(); const p = PLACES.find((q) => q.name.toLowerCase().startsWith(want)); if (p) setTimeout(p.go, 0); } }
mm.addEventListener("click", (e) => {
  const r = mm.getBoundingClientRect(); const [x, y] = mmT.toPlan(e.clientX - r.left, e.clientY - r.top);
  const room = roomAt(x, y);
  if (room) jumpToRoom(room);
});

// ---------------------------------------------------------------- front door: swings open on the tour, and when you walk up
const doorMeta = lmMeta.__door__, doorNode = doorMeta ? groups[doorMeta.node] : null;
const doorQ0 = doorNode ? doorNode.quaternion.clone() : null, doorAxis = new THREE.Vector3(0, 1, 0), doorQ = new THREE.Quaternion();
let doorDeg = 0;
function setDoor(deg) {
  if (!doorNode) return;
  doorDeg = deg;
  doorQ.setFromAxisAngle(doorAxis, THREE.MathUtils.degToRad(deg) * doorMeta.sgn);
  doorNode.quaternion.copy(doorQ0).premultiply(doorQ);
}
function doorForTour(t) {   // same timing as the rendered video: closed, ease open, stay open
  if (!doorMeta || !doorMeta.open) return 0;
  const [t0, t1] = doorMeta.open, u = Math.min(1, Math.max(0, (t - t0) / Math.max(0.1, t1 - t0)));
  return doorMeta.deg * u * u * (3 - 2 * u);
}
function doorForWalk(dt) {  // open when you come within ~7 ft of the hinge, close again when you leave
  if (!doorMeta) return;
  const near = Math.hypot(me.x - doorMeta.hinge[0], me.y - doorMeta.hinge[1]) < 84;
  const target = near ? doorMeta.deg : 0;
  setDoor(doorDeg + (target - doorDeg) * Math.min(1, dt * 3.0));
}

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
let lastRoom = null;
function tick() {
  if (mode === "capture") return;                 // video capture drives rendering itself (window.__p2w.capture)
  const dt = Math.min(0.05, clock.getDelta());
  if (mode === "walk") {
    const f = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - joy.y;
    const s = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0) + joy.x;
    if (keys.has("ArrowLeft")) me.yaw += 1.6 * dt;
    if (keys.has("ArrowRight")) me.yaw -= 1.6 * dt;
    const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 110 : 52) * dt;   // inches/s
    const fx = Math.cos(me.yaw), fy = Math.sin(me.yaw), rx = Math.sin(me.yaw), ry = -Math.cos(me.yaw);
    const L = Math.hypot(f, s) > 1 ? Math.hypot(f, s) : 1;
    [me.x, me.y] = collide(me.x + ((fx * f + rx * s) / L) * speed, me.y + ((fy * f + ry * s) / L) * speed);
    const target = floorAt(me.x, me.y) + data.eye;
    eyeZ += (target - eyeZ) * Math.min(1, dt * 6);
    applyCamera();
    doorForWalk(dt);
  } else if (mode === "tour") {
    if (!stops) buildStops();
    tourT += dt;
    if (tourT < tourTotal - FLY) {
      const c = tourClock(tourT);
      setDoor(doorForTour(c.raw));
      const p = tourPose(c.raw);
      me.x = p.x; me.y = p.y; me.yaw = p.yaw + (c.stop ? 0.12 * Math.sin(Math.PI * c.u) : 0); me.pitch = p.pitch; eyeZ = p.z;
      applyCamera();
      showStop(c.stop);
    } else {
      showStop(null);
      flyToDoll((tourT - (tourTotal - FLY)) / FLY);
    }
    $("tour-progress").style.width = `${(100 * tourT) / tourTotal}%`;
    if (tourT >= tourTotal) { setMode("doll"); hint(isTouch ? "That's the whole house. Drag to spin it, or tap Walk." : "That's the whole house. Drag to spin it, or press Walk to explore.", 4200); }
  } else {
    orbit.update();
  }
  const r = mode === "doll" ? null : roomAt(me.x, me.y);
  const label = mode === "doll" ? "Dollhouse" : r ? `${r.name.replace("Living / Dining / Kitchen", "Living · Kitchen")}  ·  ${r.size}` : me.y < 0 && me.y > data.porch[1] ? "Front Porch" : "Outside";
  if (label !== lastRoom) { $("room-name").textContent = label; lastRoom = label; }
  for (const b of billboards) {
    const dx = camera.position.x - b.position.x, dz = camera.position.z - b.position.z;
    // from the dollhouse camera, lean the cut-outs back toward the view so they don't read as thin cards
    const tilt = mode === "doll" ? Math.min(0.75, 0.85 * Math.atan2(camera.position.y - b.position.y, Math.hypot(dx, dz))) : 0;
    b.rotation.set(-tilt, Math.atan2(dx, dz), 0, "YXZ");
  }
  placeMeasureLabel();
  drawMinimap();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

setVis(); applyCamera();
function faceBillboards() {
  for (const b of billboards) {
    const dx = camera.position.x - b.position.x, dz = camera.position.z - b.position.z;
    b.rotation.set(0, Math.atan2(dx, dz), 0, "YXZ");
  }
}
// Offline video capture: hide the UI, then render tour poses at exact times (no frame drops, any speed).
const capture = {
  get length() { return tourLen; },
  begin(w, h) {
    mode = "capture";
    for (const el of document.body.children) if (el !== renderer.domElement) el.style.display = "none";
    renderer.setPixelRatio(1); renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  },
  guided(w, h) { this.begin(w, h); if (!stops) buildStops(); fly = null; return tourTotal; },
  frameGuided(T, quality = 0.9) {      // returns [jpeg dataURL, card or null, room name or "Whole house"]
    let card = null, where = "Whole house";
    if (T < tourTotal - FLY) {
      const c = tourClock(T);
      setDoor(doorForTour(c.raw));
      const p = tourPose(c.raw);
      me.x = p.x; me.y = p.y; me.yaw = p.yaw + (c.stop ? 0.12 * Math.sin(Math.PI * c.u) : 0); me.pitch = p.pitch; eyeZ = p.z;
      applyCamera(); faceBillboards();
      if (c.stop) card = { ...stopCard(c.stop), u: c.u };
      where = roomAt(me.x, me.y)?.name || "Outside";
    } else flyToDoll((T - (tourTotal - FLY)) / FLY);
    renderer.render(scene, camera);
    return [renderer.domElement.toDataURL("image/jpeg", quality), card, where];
  },
  frame(t, quality = 0.93) {
    setDoor(doorForTour(t));
    const p = tourPose(t);
    me.x = p.x; me.y = p.y; me.yaw = p.yaw; me.pitch = p.pitch; eyeZ = p.z;
    applyCamera(); faceBillboards();
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/jpeg", quality);   // read back in the same task as the draw
  },
};
// ---------------------------------------------------------------- soft background music, made in code (no audio files)
const music = (() => {
  let ctx, master, bus, timer, next = 0, k = 0, started = false;
  let on = localStorageGet("p2w-music") !== "off";
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const CHORDS = [[53, 57, 60, 64], [57, 60, 64, 67], [50, 57, 60, 65], [55, 59, 62, 69]];   // Fmaj7  Am7  Dm(add9)  G6
  function reverb() {
    const n = ctx.sampleRate * 3.2, b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6); }
    const v = ctx.createConvolver(); v.buffer = b; return v;
  }
  function voice(type, f, t, a, peak, hold, rel, det = 0) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f; o.detune.value = det;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a);
    if (hold) g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
    o.connect(g).connect(bus); o.start(t); o.stop(t + a + hold + rel + 0.1);
  }
  function schedule() {
    while (next < ctx.currentTime + 6) {
      const ch = CHORDS[k++ % CHORDS.length];
      for (const n of ch) for (const det of [-7, 7]) voice("triangle", hz(n - 12), next, 2.5, 0.028, 4.5, 3, det);
      voice("sine", hz(ch[0] - 24), next, 1.5, 0.05, 5, 2.5);
      for (let b = 0; b < 8; b++) if (Math.random() < 0.5) voice("sine", hz(ch[(Math.random() * 4) | 0] + 12), next + b + (Math.random() < 0.3 ? 0.5 : 0), 0.01, 0.035, 0, 2.4);
      next += 8;
    }
  }
  function apply() {
    $("btn-music").classList.toggle("on", on);
    if (!ctx) return;
    if (on && ctx.state === "suspended") ctx.resume();
    master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setTargetAtTime(on ? 0.55 : 0, ctx.currentTime, 0.5);
  }
  function start() {
    if (started || !on) return; started = true;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = 0; bus = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400;
    const wet = ctx.createGain(); wet.gain.value = 0.55;
    bus.connect(lp); lp.connect(master); lp.connect(reverb()).connect(wet).connect(master); master.connect(ctx.destination);
    next = ctx.currentTime + 0.15; schedule(); timer = setInterval(schedule, 1000); apply();
  }
  return { start, toggle() { on = !on; localStorageSet("p2w-music", on ? "on" : "off"); if (on && !started) start(); apply(); }, get on() { return on; }, init: apply };
})();
$("btn-music").onclick = () => { music.toggle(); hint(music.on ? "Music on" : "Music off", 1200); };
music.init();

// ---------------------------------------------------------------- client: welcome screen, contact button, style switch
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (v) => (typeof v === "number" ? "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v);
function poseHash() { return `#p=${[me.x, me.y, me.yaw, me.pitch].map((v) => v.toFixed(2)).join(",")},${mode === "capture" ? "walk" : mode},${tourT.toFixed(1)}`; }
let resumed = false;
{
  const m = /#p=([^&]+)/.exec(location.hash);
  if (m) {
    const v = m[1].split(","); const [x, y, yaw, pitch] = v.slice(0, 4).map(Number);
    if ([x, y, yaw, pitch].every(Number.isFinite)) { me.x = x; me.y = y; me.yaw = yaw; me.pitch = pitch; eyeZ = floorAt(x, y) + data.eye; applyCamera(); resumed = true; }
    if (v[4] === "doll") setMode("doll");
    if (v[4] === "tour") { setMode("tour"); tourT = Number(v[5]) || 0; }
    history.replaceState(null, "", location.pathname + location.search);
  }
}
if (client) {
  document.body.classList.add("has-client");
  const c = client.contact || {};
  if (c.phone || c.email) {
    const tel = String(c.phone || "").replace(/[^0-9+]/g, "");
    $("contact").classList.remove("hidden");
    $("contact-btn").textContent = c.label || (c.name ? `Talk to ${c.name.split(" ")[0]}` : "Contact us");
    $("contact-sheet").innerHTML = `<div class="who">${esc(c.name || client.company || "")}${c.role ? `<small>${esc(c.role)}</small>` : ""}</div>`
      + (tel ? `<a href="tel:${tel}">Call ${esc(c.phone)}</a><a href="sms:${tel}">Text</a>` : "")
      + (c.email ? `<a href="mailto:${esc(c.email)}?subject=${encodeURIComponent(client.title || data.name)}">Email</a>` : "");
    $("contact-btn").onclick = (e) => { e.stopPropagation(); $("contact-sheet").classList.toggle("hidden"); };
    addEventListener("pointerdown", (e) => { if (!$("contact").contains(e.target)) $("contact-sheet").classList.add("hidden"); });
  }
  const styles = client.styles || [];
  if (styles.length > 1) {
    const html = styles.map((st) => `<button class="${st.current ? "on" : ""}" data-href="${esc(st.href)}">${esc(st.label)}</button>`).join("");
    $("styles").innerHTML = html; $("styles").classList.remove("hidden");
    $("w-styles").innerHTML = html;
    document.querySelectorAll("#styles button, #w-styles button").forEach((b) => b.onclick = () => {
      if (b.classList.contains("on")) return;
      location.href = b.dataset.href + (document.getElementById("welcome").classList.contains("hidden") ? poseHash() : "");
    });
  }
  if (!resumed) {
    $("w-kicker").textContent = client.greeting || "Welcome home";
    $("w-title").textContent = client.title || data.name;
    $("w-addr").textContent = client.address || "";
    $("w-price").textContent = client.welcome || "";
    $("w-facts").textContent = (client.facts || []).join("  ·  ");
    $("w-start").onclick = () => { $("welcome").classList.add("hidden"); setMode("tour"); };
    $("w-explore").onclick = () => { $("welcome").classList.add("hidden"); hint(isTouch ? "Drag the circle to walk, drag the view to look" : "Click the view, then W A S D + mouse", 3600); };
    $("welcome").classList.remove("hidden");
  }
}

window.__p2w = { me, setMode, roomAt, capture, get stops() { if (!stops) buildStops(); return stops; }, get tourT() { return tourT; }, set tourT(v) { tourT = v; },
  mat(name) { let r = null; houseRoot.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.name === name) r = m; }); }); return r; },
  pick(x, y, z) {   // plan inches; cast straight down, report what's drawn there
    ray.set(P(x, y, z), new THREE.Vector3(0, -1, 0));
    const h = ray.intersectObjects(meshes, false)[0]; if (!h) return null;
    const m = Array.isArray(h.object.material) ? h.object.material[h.face.materialIndex] : h.object.material;
    const ga = Object.keys(h.object.geometry.attributes);
    return { attrs: ga, lmChannel: m.lightMap && m.lightMap.channel, uv1: h.uv1 && [h.uv1.x, h.uv1.y], mesh: h.object.name, mat: m.name, map: m.map && m.map.name, mapRepeat: m.map && [m.map.repeat.x, m.map.offset.y], lm: !!m.lightMap, color: m.color.getHexString(), uv: h.uv && [h.uv.x, h.uv.y] };
  }, get door() { return doorDeg; }, get mode() { return mode; }, get measure() { return $("measure-label").textContent; } };   // test hook
$("loading").classList.add("done");
setTimeout(() => $("loading").remove(), 600);
if (!client && !resumed && !localStorageGet("p2w-help-seen")) { $("help").classList.remove("hidden"); localStorageSet("p2w-help-seen", "1"); }
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
tick();
