import * as THREE from 'three';
import type { Projection } from '../core/projection';
import { decodeTile } from '../core/tileFormat';
import type { Manifest } from '../core/manifest';
import { STYLE, Y } from '../core/constants';
import { createBuildingMaterial } from './materials';
import { shared } from './uniforms';
import { createGlowPoints } from './Lights';

/**
 * Hand-modelled landmarks whose real shape a footprint extrusion can't capture.
 * Each landmark names a lon/lat inside its footprint; the tile worker skips
 * that footprint and the model below is placed using the footprint's
 * orientation and size, so it lines up with the data.
 */
export interface LandmarkInfo { name: string; height: number; year: number; description: string }

interface LandmarkDef {
  id: string; lon: number; lat: number; info: LandmarkInfo;
  /** 'footprint': replace the building footprint containing lon/lat; 'free': place at lon/lat */
  anchor?: 'footprint' | 'free';
  /** compass bearing (deg) of the model's main axis, for 'free' landmarks */
  bearing?: number;
  build: (fp: Footprint) => THREE.Object3D;
}

interface Footprint { center: THREE.Vector2; angle: number; w: number; d: number; ring: [number, number][] }

const LANDMARKS: LandmarkDef[] = [
  {
    id: 'one-wtc', lon: -74.01337, lat: 40.71298,
    info: { name: 'One World Trade Center', height: 541.3, year: 2014, description: 'Tallest building in the Western Hemisphere. Roof 417 m, spire to 1,776 ft.' },
    build: buildOneWTC,
  },
  {
    // Span centre and axis derived from the NYC Planimetric bridge-deck polygon
    // (Transportation Structures) intersected with the borough shorelines.
    id: 'brooklyn-bridge', lon: -73.99691, lat: 40.70614, anchor: 'free', bearing: 136.7,
    info: { name: 'Brooklyn Bridge', height: 84.3, year: 1883, description: 'Hybrid cable-stayed / suspension bridge, main span 486 m. Towers 84 m above the East River.' },
    build: (fp) => buildSuspensionBridge(fp, BROOKLYN),
  },
  {
    // derived the same way from the Manhattan Bridge deck polygon
    id: 'manhattan-bridge', lon: -73.99055, lat: 40.70713, anchor: 'free', bearing: 157.0,
    info: { name: 'Manhattan Bridge', height: 102, year: 1909, description: 'Suspension bridge, main span 448 m, carrying road traffic and four subway tracks.' },
    build: (fp) => buildSuspensionBridge(fp, MANHATTAN),
  },
  {
    id: 'williamsburg-bridge', lon: -73.97204, lat: 40.71352, anchor: 'free', bearing: 110.4,
    info: { name: 'Williamsburg Bridge', height: 102, year: 1903, description: 'Suspension bridge with steel lattice towers, main span 488 m, from Delancey St to Williamsburg.' },
    build: (fp) => buildSuspensionBridge(fp, WILLIAMSBURG),
  },
  {
    // axis from the OSM bridge ways (towers split the ways); +t points to New Jersey
    id: 'george-washington-bridge', lon: -73.95455, lat: 40.852075, anchor: 'free', bearing: 284.0,
    info: { name: 'George Washington Bridge', height: 184, year: 1931, description: 'Double-deck suspension bridge across the Hudson to Fort Lee, NJ. Main span 1,067 m; the world\'s busiest motor-vehicle bridge.' },
    build: (fp) => buildSuspensionBridge(fp, GWB),
  },
];

export async function loadLandmarks(manifest: Manifest, dataRoot: string, proj: Projection) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const exclude: [number, number][] = [];
  const beacons: number[] = [];
  for (const def of LANDMARKS) {
    const [x, z] = proj.forward(def.lon, def.lat);
    let fp: Footprint | null;
    if (def.anchor === 'free') {
      // bearing (from north, clockwise) -> angle in the x,z plane
      const b = ((def.bearing ?? 0) * Math.PI) / 180;
      fp = { center: new THREE.Vector2(x, z), angle: Math.atan2(-Math.cos(b), Math.sin(b)), w: 0, d: 0, ring: [] };
    } else {
      fp = await findFootprint(manifest, dataRoot, x, z).catch((e) => { console.warn(`landmark ${def.id}:`, e); return null; });
      if (!fp) { console.warn(`landmark ${def.id}: footprint not found`); continue; }
      exclude.push([x, z]);
    }
    const obj = def.build(fp);
    obj.traverse((o) => { o.userData.landmark = def.info; });
    obj.userData.landmark = def.info;
    group.add(obj);
    if (obj.userData.beacon) beacons.push(...(obj.userData.beacon as number[]));
  }
  return { group, exclude, beacons };
}

async function findFootprint(manifest: Manifest, root: string, x: number, z: number): Promise<Footprint | null> {
  const T = manifest.tileSize;
  const ix = Math.floor(x / T), iz = Math.floor(z / T);
  for (const r of manifest.regions) {
    for (const t of r.layers.buildings ?? []) {
      if (Math.abs(t.ix - ix) > 1 || Math.abs(t.iz - iz) > 1) continue;
      const res = await fetch(`${root}/${t.url}`);
      if (!res.ok) continue;
      const tile = decodeTile(await res.arrayBuffer());
      const [ox, oz] = tile.header.origin;
      const fr = tile.sections.featRings, rv = tile.sections.ringVerts, c = tile.sections.coords;
      for (let f = 0; f < tile.header.featureCount; f++) {
        const a = rv[fr[f]], b = rv[fr[f] + 1];
        const ring: [number, number][] = [];
        for (let k = a; k < b; k++) ring.push([c[k * 2] + ox, c[k * 2 + 1] + oz]);
        if (inRing(x, z, ring)) return minAreaRect(ring);
      }
    }
  }
  return null;
}

function inRing(x: number, z: number, r: [number, number][]) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
}

/** Minimum-area bounding rectangle over the ring's edge directions. */
function minAreaRect(ring: [number, number][]): Footprint {
  let best = { area: Infinity, angle: 0, w: 0, d: 0, cx: 0, cz: 0 };
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const ang = Math.atan2(ring[j][1] - ring[i][1], ring[j][0] - ring[i][0]);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, z] of ring) {
      const u = x * ca + z * sa, v = -x * sa + z * ca;
      a = Math.min(a, u); c = Math.max(c, u); b = Math.min(b, v); d = Math.max(d, v);
    }
    const area = (c - a) * (d - b);
    if (area < best.area) {
      const mu = (a + c) / 2, mv = (b + d) / 2;
      best = { area, angle: ang, w: c - a, d: d - b, cx: mu * ca - mv * sa, cz: mu * sa + mv * ca };
    }
  }
  return { center: new THREE.Vector2(best.cx, best.cz), angle: best.angle, w: best.w, d: best.d, ring };
}

// ------------------------------------------------------------------ One WTC
/** Builder that writes the same attributes as the tile worker (facade + info). */
class FacetBuilder {
  pos: number[] = []; nor: number[] = []; fac: number[] = []; info: number[] = [];
  constructor(private infoVec: number[], private cx: number, private cz: number) {}
  /** flat-shaded triangle, auto-oriented to face away from the vertical axis through (cx,cz) (or up) */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    let n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const mx = (a.x + b.x + c.x) / 3 - this.cx, mz = (a.z + b.z + c.z) / 3 - this.cz;
    const out = Math.abs(n.y) > 0.9 ? n.y : n.x * mx + n.z * mz;
    if (out < 0) { const t = b; b = c; c = t; n = n.negate(); }
    const uAxis = new THREE.Vector3(0, 1, 0).cross(n).normalize();
    if (uAxis.lengthSq() < 0.5) uAxis.set(1, 0, 0);
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z);
      this.fac.push(p.dot(uAxis) + 500, p.y - Y.buildingBase);
      this.info.push(...this.infoVec);
    }
  }
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) { this.tri(a, b, c); this.tri(a, c, d); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('facade', new THREE.Float32BufferAttribute(this.fac, 2));
    g.setAttribute('info', new THREE.Float32BufferAttribute(this.info, 4));
    return g;
  }
}

function buildOneWTC(fp: Footprint): THREE.Object3D {
  const g = new THREE.Group();
  const side = Math.min(62, Math.min(fp.w, fp.d));
  const half = side / 2;
  const y0 = Y.buildingBase, y1 = y0 + 56, y2 = y0 + 417;
  const ca = Math.cos(fp.angle), sa = Math.sin(fp.angle);
  const P = (u: number, v: number, y: number) => new THREE.Vector3(fp.center.x + u * ca - v * sa, y, fp.center.y + u * sa + v * ca);
  // corners CCW seen from above (x east, z south => use order that gives outward normals)
  const corners: [number, number][] = [[-half, -half], [-half, half], [half, half], [half, -half]];
  const fb = new FacetBuilder([417, 0.731, STYLE.GLASS, -1], fp.center.x, fp.center.y);
  const B = (i: number, y: number) => P(corners[i % 4][0], corners[i % 4][1], y);
  const M = (i: number, y: number) => {
    const a = corners[i % 4], b = corners[(i + 1) % 4];
    return P((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, y);
  };
  for (let i = 0; i < 4; i++) {
    fb.quad(B(i, y0), B(i + 1, y0), B(i + 1, y1), B(i, y1));   // podium
    fb.tri(B(i, y1), B(i + 1, y1), M(i, y2));                 // tapering shaft:
    fb.tri(M(i, y2), B(i + 1, y1), M(i + 1, y2));             // 8 isosceles triangles
  }
  fb.tri(M(0, y2), M(1, y2), M(2, y2));
  fb.tri(M(0, y2), M(2, y2), M(3, y2));
  const tower = new THREE.Mesh(fb.geometry(), createBuildingMaterial());
  tower.castShadow = tower.receiveShadow = true;
  g.add(tower);

  // spire: base ring + tapering mast
  const metal = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.9, roughness: 0.3, emissive: 0xffffff, emissiveIntensity: 0 });
  metal.onBeforeRender = () => { metal.emissiveIntensity = 1.4 * shared.uLights.value; };
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(9, 10, 12, 24, 1, true), metal);
  ring.position.set(fp.center.x, y2 + 6, fp.center.y);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 2.0, 112, 12), metal);
  mast.position.set(fp.center.x, y2 + 12 + 56, fp.center.y);
  for (const m of [ring, mast]) { m.castShadow = true; g.add(m); }
  g.userData.beacon = [fp.center.x, y2 + 124.5, fp.center.y];
  return g;
}

// ------------------------------------------------------------------ suspension bridges
interface BridgeSpec {
  /** half of the main span (centre to tower) and side-span length, metres */
  mainHalf: number; side: number;
  /** deck extent along the axis (negative = Manhattan side) */
  endM: number; endB: number;
  towerH: number; deckMid: number; deckTower: number; deckAnchor: number;
  deckHalfW: number; deckThick: number;
  cableS: number[]; cableMid: number; cableAnchor: number;
  stays: boolean;
  tower: 'gothic' | 'steel';
  /** massive masonry anchorages at the ends of the side spans (GWB) */
  anchorages?: boolean;
  colors: {
    stone: number;            // daytime tower colour
    towerGlow: number[];      // night tower wash, cycles slowly through these
    necklace: 'rainbow' | number;
    lines: number;            // night colour of suspenders / stays
  };
}

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

function buildSuspensionBridge(fp: Footprint, b: BridgeSpec): THREE.Object3D {
  const g = new THREE.Group();
  const ax = new THREE.Vector2(Math.cos(fp.angle), Math.sin(fp.angle)); // towards Brooklyn
  const nx = new THREE.Vector2(-ax.y, ax.x);
  const P = (t: number, s: number, y: number) =>
    new THREE.Vector3(fp.center.x + ax.x * t + nx.x * s, y, fp.center.y + ax.y * t + nx.y * s);
  const T = b.mainHalf, A = b.mainHalf + b.side;
  const deckY = (t: number) => {
    const a = Math.abs(t);
    if (a <= T) return b.deckMid - (t / T) ** 2 * (b.deckMid - b.deckTower);
    if (a <= A) return lerpN(b.deckTower, b.deckAnchor, (a - T) / b.side);
    const end = t < 0 ? -b.endM : b.endB;
    const k = Math.min(1, (a - A) / (end - A));
    return b.deckAnchor * (1 - k * k * (3 - 2 * k)) + 2 * k;
  };
  const cableY = (t: number) => {
    const a = Math.abs(t);
    if (a <= T) return b.cableMid + (b.towerH - 4 - b.cableMid) * (t / T) ** 2;
    const k = (a - T) / b.side;
    return lerpN(b.towerH - 4, b.cableAnchor, k) - 0.06 * b.side * Math.sin(Math.PI * k);
  };

  // ---- materials: towers get a slowly cycling coloured wash at night
  const towerMat = new THREE.MeshStandardMaterial({
    color: b.colors.stone, roughness: b.tower === 'gothic' ? 0.92 : 0.55, metalness: b.tower === 'gothic' ? 0 : 0.5, emissive: 0xffffff, emissiveIntensity: 0,
  });
  const glowCols = b.colors.towerGlow.map((c) => new THREE.Color(c));
  towerMat.onBeforeRender = () => {
    const L = shared.uLights.value;
    const k = (shared.uTime.value * 0.05) % glowCols.length;
    const i = Math.floor(k), f = k - i;
    towerMat.emissive.copy(glowCols[i]).lerp(glowCols[(i + 1) % glowCols.length], f * f * (3 - 2 * f));
    towerMat.emissiveIntensity = (b.tower === 'gothic' ? 0.55 : 0.7) * L;
  };
  const steel = new THREE.MeshStandardMaterial({ color: b.tower === 'steel' ? b.colors.stone : 0x5a554d, roughness: 0.6, metalness: 0.5 });
  const road = new THREE.MeshStandardMaterial({ color: 0x3b3a39, roughness: 0.9, emissive: new THREE.Color(1.0, 0.65, 0.35), emissiveIntensity: 0 });
  road.onBeforeRender = () => { road.emissiveIntensity = 0.12 * shared.uLights.value; };

  // ---- deck: box ribbon following the profile
  const W = b.deckHalfW, TH = b.deckThick;
  const dpos: number[] = [], didx: number[] = [], rpos: number[] = [], ridx: number[] = [];
  const quad = (arr: number[], idx: number[], p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3) => {
    const o = arr.length / 3; arr.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  for (let t = b.endM; t < b.endB; t += 8) {
    const t2 = Math.min(b.endB, t + 8), y1 = deckY(t), y2 = deckY(t2);
    quad(rpos, ridx, P(t, -W, y1), P(t, W, y1), P(t2, W, y2), P(t2, -W, y2));
    quad(dpos, didx, P(t, W, y1), P(t, W, y1 - TH), P(t2, W, y2 - TH), P(t2, W, y2));
    quad(dpos, didx, P(t2, -W, y2), P(t2, -W, y2 - TH), P(t, -W, y1 - TH), P(t, -W, y1));
    quad(dpos, didx, P(t, -W, y1 - TH), P(t, W, y1 - TH), P(t2, W, y2 - TH), P(t2, -W, y2 - TH));
  }
  const mk = (pos: number[], idx: number[], mat: THREE.MeshStandardMaterial) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    geo.computeVertexNormals();
    mat.side = THREE.DoubleSide;
    const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true;
    return m;
  };
  g.add(mk(dpos, didx, steel), mk(rpos, ridx, road));

  // ---- towers
  const box = (t: number, s: number, y0: number, y1: number, lt: number, ls: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(lt, y1 - y0, ls), towerMat);
    m.position.copy(P(t, s, (y0 + y1) / 2));
    m.rotation.y = -fp.angle;
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  };
  for (const tt of [-T, T]) {
    const dy = deckY(tt), H = b.towerH, Wt = W + 4;
    if (b.tower === 'gothic') {
      box(tt, 0, -3, dy - 2, 22, Wt * 2 + 6);
      box(tt, -Wt + 1, dy - 2, H * 0.78, 16, 9);
      box(tt, Wt - 1, dy - 2, H * 0.78, 16, 9);
      box(tt, 0, dy - 2, H * 0.78, 16, 8);
      box(tt, 0, H * 0.69, H * 0.78, 15, Wt * 2);
      box(tt, 0, H * 0.78, H - 3.3, 18, Wt * 2 + 1);
      box(tt, 0, H - 3.3, H, 20, Wt * 2 + 3);
    } else {
      box(tt, 0, -3, 6, 16, Wt * 2 + 8);                                      // pier
      for (const sgn of [-1, 1]) box(tt, sgn * Wt, 6, H, 7, 6);               // legs
      for (const f of [0.42, 0.62, 0.82]) box(tt, 0, H * f - 2, H * f + 2, 4, Wt * 2); // portal bracing
      box(tt, 0, H - 4, H, 8, Wt * 2 + 6);                                    // crown
    }
  }

  if (b.anchorages) for (const tt of [-A, A]) box(tt + Math.sign(tt) * 25, 0, -3, b.deckAnchor + 6, 60, W * 2 + 14);

  // ---- cables, suspenders, stays (night-glowing colour lines) + necklace lights
  const cablePts: number[] = [], susp: number[] = [], stays: number[] = [], necklace: number[] = [], phase: number[] = [];
  for (const s of b.cableS) {
    for (let t = -A; t < A; t += 4) cablePts.push(...P(t, s, cableY(t)).toArray(), ...P(t + 4, s, cableY(t + 4)).toArray());
    for (let t = -A + 6; t < A; t += 6) {
      if (Math.abs(Math.abs(t) - T) < 10) continue;
      susp.push(...P(t, s, cableY(t)).toArray(), ...P(t, s, deckY(t)).toArray());
    }
    if (Math.abs(s) >= Math.max(...b.cableS.map(Math.abs)) - 0.1) {
      for (let t = -A; t <= A; t += 6) { necklace.push(...P(t, s, cableY(t) + 0.6).toArray()); phase.push((t + A) / (2 * A)); }
    }
  }
  if (b.stays) for (const tt of [-T, T]) for (const dir of [-1, 1]) for (const s of [b.cableS[0], b.cableS[b.cableS.length - 1]]) {
    const top = P(tt, s, b.towerH - 5);
    for (let d = 14; d <= 140; d += 9) {
      const t = tt + dir * d;
      if (Math.abs(t) > A) continue;
      stays.push(top.x, top.y, top.z, ...P(t, s, deckY(t)).toArray());
    }
  }
  g.add(glowLines(cablePts, 0x2e2b28, b.colors.lines, 1.0), glowLines(susp, 0x3b3835, b.colors.lines, 0.55), glowLines(stays, 0x3b3835, b.colors.lines, 0.5));
  g.add(createGlowPoints(necklace, typeof b.colors.necklace === 'number' ? new THREE.Color(b.colors.necklace) : undefined, 2600, b.colors.necklace === 'rainbow' ? phase : undefined));
  const lamps: number[] = [];
  for (let t = b.endM + 40; t < b.endB - 40; t += 30) for (const s of [-W + 1, W - 1]) lamps.push(...P(t, s, deckY(t) + 4).toArray());
  g.add(createGlowPoints(lamps, new THREE.Color(1.0, 0.72, 0.42), 1500));
  return g;
}

/** Line segments that are dark steel by day and glow in a colour (with a moving shimmer) at night. */
function glowLines(pts: number[], day: number, night: number, opacity: number) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { uLights: shared.uLights, uTime: shared.uTime, uDay: { value: new THREE.Color(day) }, uNightC: { value: new THREE.Color(night) }, uOpacity: { value: opacity } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vP;
      void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uLights; uniform float uTime; uniform vec3 uDay; uniform vec3 uNightC; uniform float uOpacity; varying vec3 vP;
      void main(){
        #include <logdepthbuf_fragment>
        float shimmer = 0.7 + 0.3 * sin(vP.x * 0.02 + vP.z * 0.02 - uTime * 1.5);
        vec3 c = mix(uDay, uNightC * 0.75 * shimmer, uLights);
        gl_FragColor = vec4(c, mix(uOpacity, uOpacity * 0.7, uLights));
      }`,
    transparent: true, depthWrite: false,
  });
  return new THREE.LineSegments(geo, m);
}

const BROOKLYN: BridgeSpec = {
  mainHalf: 243, side: 283, endM: -983, endB: 898, towerH: 84.3, deckMid: 42, deckTower: 37.5, deckAnchor: 29.5,
  deckHalfW: 13, deckThick: 4, cableS: [-15.5, -5, 5, 15.5], cableMid: 46, cableAnchor: 33, stays: true, tower: 'gothic',
  colors: { stone: 0xa3927a, towerGlow: [0xffc98a, 0x7a8cff, 0xd070ff, 0xffc98a, 0x4fd6ff], necklace: 'rainbow', lines: 0x9fdcff },
};
const MANHATTAN: BridgeSpec = {
  mainHalf: 224, side: 221, endM: -998, endB: 937, towerH: 102, deckMid: 46, deckTower: 42, deckAnchor: 30,
  deckHalfW: 18, deckThick: 8, cableS: [-17, -6, 6, 17], cableMid: 50, cableAnchor: 30, stays: false, tower: 'steel',
  colors: { stone: 0x6f8aa3, towerGlow: [0x2f7bff, 0x31d0ff, 0x7a5cff], necklace: 0x9fe0ff, lines: 0x3fa8ff },
};
const GWB: BridgeSpec = {
  mainHalf: 533, side: 195, endM: -1500, endB: 1250, towerH: 184, deckMid: 66, deckTower: 62, deckAnchor: 58,
  deckHalfW: 18, deckThick: 10, cableS: [-15, -12.5, 12.5, 15], cableMid: 72, cableAnchor: 60, stays: false, tower: 'steel', anchorages: true,
  colors: { stone: 0x9aa3a8, towerGlow: [0xdfe8ff, 0xffffff, 0xcfe0ff], necklace: 0xfff1d6, lines: 0xcfe4ff },
};
const WILLIAMSBURG: BridgeSpec = {
  mainHalf: 244, side: 182, endM: -1229, endB: 983, towerH: 102, deckMid: 45, deckTower: 41, deckAnchor: 32,
  deckHalfW: 18, deckThick: 9, cableS: [-17, -6, 6, 17], cableMid: 49, cableAnchor: 34, stays: false, tower: 'steel',
  colors: { stone: 0x8c8a84, towerGlow: [0xff3fb4, 0xb04bff, 0xff7a3f], necklace: 0xffa6e8, lines: 0xff63c8 },
};
