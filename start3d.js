/*
  start3d.js: the small 3D bar field on the start screen, drawn with three.js (MIT).
  Loaded lazily by app.js after the page is idle, only when WebGL works, reduced
  motion is off and the page is served over http(s). Otherwise the CSS drawing in
  .dropzone-preview stays, at the same size, so nothing shifts.

  - A 7 by 4 grid of bars breathes slowly; dragging a file over the page lifts them.
  - Pixel ratio is capped, rendering stops when the start screen is off screen,
    hidden behind the dashboard, or in a background tab.
  - Colours come from the CSS tokens and follow the theme.
  Original code for Leo's starter, MIT licence (see LICENSE).
*/
import {
  WebGLRenderer, Scene, PerspectiveCamera, BoxGeometry, MeshStandardMaterial, Mesh,
  AmbientLight, DirectionalLight, Group, Color, PlaneGeometry
} from "./vendor/three/three.module.js";

const COLS = 7;
const ROWS = 4;

// three.js cannot read oklch(), so convert CSS colours through a 1px canvas.
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
function cssColor(value) {
  probe.fillStyle = "#000";
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return new Color(d[0] / 255, d[1] / 255, d[2] / 255);
}

export function startField(stage, dropzone) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.domElement.setAttribute("aria-hidden", "true");
  stage.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(3.9, 3.5, 5.1);
  camera.lookAt(0, 0.55, 0);

  scene.add(new AmbientLight(0xffffff, 1.1));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 8, 5);
  scene.add(sun);

  const field = new Group();
  scene.add(field);
  const barMat = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const hotMat = new MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 });
  const baseMat = new MeshStandardMaterial({ roughness: 0.9 });
  const base = new Mesh(new PlaneGeometry(COLS * 0.7 + 0.6, ROWS * 0.7 + 0.6), baseMat);
  base.rotation.x = -Math.PI / 2;
  field.add(base);

  const box = new BoxGeometry(0.46, 1, 0.46);
  box.translate(0, 0.5, 0); // grow from the floor
  const bars = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const hot = (c + r) % 5 === 2;
      const m = new Mesh(box, hot ? hotMat : barMat);
      m.position.set((c - (COLS - 1) / 2) * 0.7, 0.001, (r - (ROWS - 1) / 2) * 0.7);
      m.userData.seed = c * 0.9 + r * 1.7;
      field.add(m);
      bars.push(m);
    }
  }

  function applyTheme() {
    const s = getComputedStyle(document.documentElement);
    const accent = cssColor(s.getPropertyValue("--accent").trim());
    barMat.color.copy(accent).lerp(cssColor(s.getPropertyValue("--line-strong").trim()), 0.45);
    hotMat.color.copy(accent);
    baseMat.color.copy(cssColor(s.getPropertyValue("--sunken").trim()));
  }
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(stage);

  let lift = 0;       // eased towards 1 while a file is dragged over the page
  let last = performance.now();
  let t = 0;
  let raf = 0;
  let visible = true;

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    const target = dropzone.classList.contains("is-over") ? 1 : 0;
    lift += (target - lift) * Math.min(1, dt * 6);
    for (const m of bars) {
      const wave = 0.5 + 0.5 * Math.sin(t * 0.9 + m.userData.seed);
      m.scale.y = 0.3 + wave * 0.75 + lift * (0.35 + wave * 0.35);
    }
    field.rotation.y = Math.sin(t * 0.15) * 0.12;
    renderer.render(scene, camera);
    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function setRunning(on) {
    visible = on;
    if (on && !raf && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  new IntersectionObserver((entries) => {
    for (const e of entries) setRunning(e.isIntersecting);
  }).observe(stage);
  document.addEventListener("visibilitychange", () => setRunning(visible));

  stage.classList.add("has-3d");
  setRunning(true);
}
