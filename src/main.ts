import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Projection } from './core/projection';
import type { Manifest } from './core/manifest';
import { TileManager, toGeometry, type BuildingInfo } from './data/TileManager';
import { WorkerPool } from './data/WorkerPool';
import { Sky } from './render/Sky';
import { Water } from './render/Water';
import { Environment } from './render/Environment';
import { createContextLandMaterial } from './render/materials';
import { createBeacons } from './render/Lights';
import { loadLandmarks, type LandmarkInfo } from './render/Landmarks';
import { shared } from './render/uniforms';
import { PRESETS } from './render/TimeOfDay';
import { CameraController } from './controls/CameraController';
import { UI } from './ui/UI';
import { loadPatch, type LoadedPatch } from './render/Patch';
import { DETAIL_LAYER, setTreeShadows } from './render/Trees';

// absolute URL: workers resolve relative URLs against their own script location
const DATA = new URL(`${import.meta.env.BASE_URL}data`, window.location.href).href.replace(/\/$/, '');

async function main() {
  const ui = new UI();
  ui.setLoading(0.02, 'Loading manifest…');
  const manifest: Manifest = await (await fetch(`${DATA}/manifest.json`)).json();
  const proj = new Projection(manifest.origin);

  // ------------------------------------------------------------ renderer
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  const dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.8, 90000);
  camera.layers.enable(DETAIL_LAYER);

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.5, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const sky = new Sky(renderer);
  scene.add(sky.mesh);
  const water = new Water();
  scene.add(water.mesh);
  const env = new Environment(scene, renderer, sky, bloom);

  // region mask for procedural context land
  shared.uRegionMask.value = regionMask(manifest, shared.uRegionMaskRect.value);

  // ------------------------------------------------------------ world
  const ctrl = new CameraController(camera, canvas);
  const region = manifest.regions[0];
  const cam0 = region?.camera ?? { lon: manifest.origin.lon, lat: manifest.origin.lat, distance: 3000, heading: 20, pitch: 35 };
  const [cx, cz] = proj.forward(cam0.lon, cam0.lat);
  ctrl.setView({ target: new THREE.Vector3(cx, 0, cz), distance: cam0.distance * 1.6, heading: cam0.heading - 25, pitch: cam0.pitch + 10 });

  ui.setLoading(0.08, 'Placing landmarks…');
  const landmarks = await loadLandmarks(manifest, DATA, proj);
  scene.add(landmarks.group);

  // high-fidelity terrain patches (Central Park) — loaded before tiles so park buildings sit on the terrain
  const patches: LoadedPatch[] = [];
  for (const pm of manifest.patches ?? []) {
    ui.setLoading(0.1, `Shaping ${pm.name}…`);
    try {
      const lp = await loadPatch(DATA, pm.url);
      lp.ground.geometry.computeBoundsTree();
      scene.add(lp.group);
      patches.push(lp);
    } catch (e) { console.warn('patch', pm.id, e); }
  }

  const tiles = new TileManager(manifest, DATA);
  tiles.exclude = landmarks.exclude;
  tiles.terrains = patches.map((p) => {
    const xs = p.meta.outline.map((q) => q[0]), zs = p.meta.outline.map((q) => q[1]);
    return { grid: p.terrain, bbox: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] as [number, number, number, number] };
  });
  // signature night lighting (codes interpreted in the facade shader)
  const special = (lon: number, lat: number, r: number, code: number) => { const [x, z] = proj.forward(lon, lat); return { x, z, r, code }; };
  tiles.specials = [
    special(-73.98566, 40.74844, 48, 5),  // Empire State Building: colour-cycling tiered crown
    special(-73.97545, 40.75162, 30, 6),  // Chrysler Building: bright terraced crown
    special(-73.98550, 40.75800, 140, 7), // Times Square: animated billboards
  ];
  scene.add(tiles.group);

  // aviation beacons on tall roofs
  const beaconPts: number[] = [...landmarks.beacons];
  let beacons: THREE.Points | null = null;
  const rebuildBeacons = () => {
    if (beacons) { scene.remove(beacons); beacons.geometry.dispose(); }
    beacons = createBeacons(beaconPts);
    scene.add(beacons);
  };
  tiles.onTileLoaded = ({ layer, features }) => {
    if (layer !== 'buildings' || !features) return;
    for (let i = 0; i < features.height.length; i++) {
      if (features.height[i] > 170) beaconPts.push(features.centroid[i * 2], features.height[i] + 2.5, features.centroid[i * 2 + 1]);
    }
    rebuildBeacons();
  };
  tiles.onProgress = (n, total) => ui.setLoading(tiles.nearProgress >= 0.98 ? 1 : 0.15 + 0.85 * tiles.nearProgress, `Building city… ${n}/${total} tiles`, n / total);

  // context land (other boroughs, New Jersey)
  const pool = new WorkerPool(1);
  for (const c of manifest.context) {
    pool.build({ url: `${DATA}/${c.url}`, kind: 'land' }).then((res) => {
      if (!res.geometry) return;
      const m = new THREE.Mesh(toGeometry(res.geometry), createContextLandMaterial());
      m.receiveShadow = true;
      m.userData.ground = true;
      scene.add(m);
      contextMeshes.push(m);
    });
  }
  const contextMeshes: THREE.Mesh[] = [];

  // ------------------------------------------------------------ time of day
  let hour: number = PRESETS.day;
  let hourAnim: { from: number; to: number; t: number } | null = null;
  let playing = false;
  env.setHour(hour, true);
  ui.onPreset = (name) => {
    const target = PRESETS[name];
    let d = ((target - hour) % 24 + 36) % 24 - 12; // shortest way around the clock
    hourAnim = { from: hour, to: hour + d, t: 0 };
    playing = false; ui.setPlaying(false);
  };
  ui.onHour = (h) => { hourAnim = null; hour = h; env.setHour(hour, true); };
  ui.onPlay = (p) => { playing = p; hourAnim = null; };
  ui.setHour(hour);

  // ------------------------------------------------------------ navigation & picking
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const down = new THREE.Vector3(0, -1, 0);
  ctrl.surfaceAt = (x, z, fromY) => {
    raycaster.set(new THREE.Vector3(x, fromY, z), down);
    raycaster.far = fromY + 10;
    const hits = raycaster.intersectObjects([...tiles.pickables(), landmarks.group, ...patches.map((p) => p.ground)], true);
    return hits.length ? hits[0].point.y : 1;
  };
  ctrl.onModeChange = (m) => ui.setMode(m);
  ctrl.onLockChange = (l) => ui.setLocked(l);
  ui.onMode = (m) => ctrl.setMode(m);
  ui.onNorth = () => ctrl.northUp();
  ui.onPlace = (p) => {
    const [x, z] = proj.forward(p.lon, p.lat);
    ctrl.flyTo({ target: new THREE.Vector3(x, p.y ?? 0, z), distance: p.distance, heading: p.heading, pitch: p.pitch });
  };

  const ndc = new THREE.Vector2();
  const pick = (ev: MouseEvent, objects: THREE.Object3D[]) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    raycaster.far = Infinity;
    return raycaster.intersectObjects(objects, true)[0] ?? null;
  };

  let highlight: THREE.Mesh | null = null;
  const highlightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.55, 1.0), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const clearSelection = () => { if (highlight) { scene.remove(highlight); highlight.geometry.dispose(); highlight = null; } ui.showInfo(null); };
  const select = (b: BuildingInfo | null, lm: LandmarkInfo | null, obj?: THREE.Object3D) => {
    clearSelection();
    if (lm && obj) {
      const root = landmarks.group.children.find((c) => c === obj || c.getObjectById(obj.id));
      const mesh = root?.children[0] as THREE.Mesh | undefined;
      if (mesh) { highlight = new THREE.Mesh(mesh.geometry.clone(), highlightMat); scene.add(highlight); }
      ui.showInfo({ title: lm.name, height: lm.height, year: lm.year, note: lm.description, lonlat: null });
      return;
    }
    if (!b) return;
    const hg = tiles.buildingGeometry(b);
    if (hg) { highlight = new THREE.Mesh(hg.geometry, highlightMat); highlight.position.copy(hg.position); scene.add(highlight); }
    const [lon, lat] = proj.inverse(b.centroid[0], b.centroid[1]);
    if (b.osm) {
      ui.showInfo({
        title: `Building · OSM ${b.osm.type} ${b.osm.id}`, height: b.height, year: b.year, lonlat: [lon, lat],
        note: 'Source: OpenStreetMap contributors (ODbL). Height from OSM tags or a Microsoft ML estimate.',
        link: { href: `https://www.openstreetmap.org/${b.osm.type}/${b.osm.id}`, label: 'View in OpenStreetMap ↗' },
      });
    } else {
      ui.showInfo({ title: b.bin ? `Building · BIN ${b.bin}` : 'Building', height: b.height, year: b.year, note: null, lonlat: [lon, lat] });
    }
  };

  let downAt: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || ctrl.mode !== 'map' || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 4) return;
    const hit = pick(e, [...tiles.pickables(), landmarks.group]);
    if (!hit) return clearSelection();
    if (hit.object.userData.landmark) return select(null, hit.object.userData.landmark, hit.object);
    select(tiles.buildingAt(hit), null);
  });
  canvas.addEventListener('dblclick', (e) => {
    if (ctrl.mode !== 'map') return;
    const hit = pick(e, [...tiles.solids(), landmarks.group, ...contextMeshes, ...patches.map((p) => p.ground)]);
    const p = hit?.point ?? raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!p) return;
    const v = ctrl.getView();
    ctrl.flyTo({ target: p, distance: Math.max(120, v.distance * 0.45) }, 1.1);
  });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.closest?.('input')) return;
    if (e.code === 'Digit1') ui.onPreset?.('day');
    if (e.code === 'Digit2') ui.onPreset?.('evening');
    if (e.code === 'Digit3') ui.onPreset?.('night');
    if (e.code === 'Tab' || (e.code === 'KeyG')) { e.preventDefault(); ctrl.setMode(ctrl.mode === 'map' ? 'fly' : 'map'); }
    if (e.code === 'KeyN') ctrl.northUp();
    if (e.code === 'KeyH' || e.code === 'Slash') ui.toggleHelp();
    if (e.code === 'Escape') clearSelection();
  });

  // ------------------------------------------------------------ resize & loop
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    water.setSize(w * dpr, h * dpr);
    bloom.setSize(w * dpr * 0.5, h * dpr * 0.5);
  };
  window.addEventListener('resize', resize);
  resize();

  const clock = new THREE.Clock();
  let frames = 0, fpsT = 0;
  const tick = () => {
    const dt = Math.min(clock.getDelta(), 0.1);
    shared.uTime.value += dt;

    if (hourAnim) {
      hourAnim.t = Math.min(1, hourAnim.t + dt / 2.6);
      const k = hourAnim.t < 0.5 ? 2 * hourAnim.t ** 2 : 1 - (-2 * hourAnim.t + 2) ** 2 / 2;
      hour = (((hourAnim.from + (hourAnim.to - hourAnim.from) * k) % 24) + 24) % 24;
      env.setHour(hour, hourAnim.t >= 1);
      ui.setHour(hour);
      if (hourAnim.t >= 1) hourAnim = null;
    } else if (playing) {
      hour = (hour + dt * 0.35) % 24;
      env.setHour(hour);
      ui.setHour(hour);
    }

    ctrl.update(dt);
    const focus = ctrl.mode === 'map' ? ctrl.target : camera.position;
    const dist = ctrl.mode === 'map' ? camera.position.distanceTo(ctrl.target) : Math.max(300, camera.position.y * 2);
    tiles.update(camera, focus);
    env.updateShadow(focus, dist);
    env.updateFog(camera.position.y);
    setTreeShadows(dist < 1600);
    for (const p of patches) {
      // park trees only when reasonably close (thousands of instances); lamps stay on
      const c = p.ground.geometry.boundingSphere!.center;
      const near = Math.hypot(camera.position.x - c.x, camera.position.z - c.z) < 6500;
      for (const ch of p.group.children) if (ch.userData.kind === 'trees') ch.visible = near;
    }
    sky.follow(camera);

    water.render(renderer, scene, camera, sky.mesh);
    composer.render();

    frames++; fpsT += dt;
    if (fpsT > 0.5) {
      const [lon, lat] = proj.inverse(focus.x, focus.z);
      ui.setStatus({ fps: frames / fpsT, lon, lat, alt: camera.position.y, heading: ctrl.heading() });
      frames = 0; fpsT = 0;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // gentle intro move once things are loading
  setTimeout(() => ctrl.flyTo({ target: new THREE.Vector3(cx, 0, cz), distance: cam0.distance, heading: cam0.heading, pitch: cam0.pitch }, 4.5), 600);
  (window as any).nyc = {
    scene, camera, ctrl, tiles, env, renderer,
    /** debug helper: jump to a view instantly */
    view: (lon: number, lat: number, distance: number, heading: number, pitch: number, y = 0) => {
      const [x, z] = proj.forward(lon, lat);
      ctrl.flyTo({ target: new THREE.Vector3(x, y, z), distance, heading, pitch }, 0.05);
    },
    setHour: (h: number) => { hour = h; env.setHour(h, true); ui.setHour(h); } };
}

/** Rasterise region boundaries into a soft mask texture (r = 1 inside detailed regions). */
function regionMask(m: Manifest, rect: THREE.Vector4): THREE.Texture {
  const N = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
  g.filter = 'blur(3px)';
  g.fillStyle = '#fff';
  for (const r of m.regions) {
    for (const ring of r.mask ?? (r.boundary?.length ? [r.boundary] : [])) {
      g.beginPath();
      ring.forEach(([x, z], i) => {
        const px = ((x - rect.x) / rect.z) * N, py = ((z - rect.y) / rect.w) * N;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      });
      g.closePath(); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  return t;
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('loading-text');
  if (el) el.textContent = `Failed to start: ${e.message ?? e}`;
});
