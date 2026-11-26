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
    build: buildBrooklynBridge,
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
      fp = await findFootprint(manifest, dataRoot, x, z);
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
      const tile = decodeTile(await (await fetch(`${root}/${t.url}`)).arrayBuffer());
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

// ------------------------------------------------------------------ Brooklyn Bridge
function buildBrooklynBridge(fp: Footprint): THREE.Object3D {
  const g = new THREE.Group();
  const ax = new THREE.Vector2(Math.cos(fp.angle), Math.sin(fp.angle)); // towards Brooklyn
  const nx = new THREE.Vector2(-ax.y, ax.x);
  const P = (t: number, s: number, y: number) =>
    new THREE.Vector3(fp.center.x + ax.x * t + nx.x * s, y, fp.center.y + ax.y * t + nx.y * s);

  const TOWER = 243, ANCHOR = 526, END_M = -983, END_B = 898;
  const deckY = (t: number) => {
    const a = Math.abs(t);
    if (a <= TOWER) return 42 - (t / TOWER) ** 2 * 4.5;
    if (a <= ANCHOR) return 37.5 - ((a - TOWER) / (ANCHOR - TOWER)) * 8;
    const end = t < 0 ? -END_M : END_B;
    const k = Math.min(1, (a - ANCHOR) / (end - ANCHOR));
    return 29.5 * (1 - k * k * (3 - 2 * k)) + 2 * k;
  };

  const stone = new THREE.MeshStandardMaterial({ color: 0xa3927a, roughness: 0.92, emissive: 0xffcf96, emissiveIntensity: 0 });
  stone.onBeforeRender = () => { stone.emissiveIntensity = 0.16 * shared.uLights.value; };
  const steel = new THREE.MeshStandardMaterial({ color: 0x5a554d, roughness: 0.7, metalness: 0.4 });
  const road = new THREE.MeshStandardMaterial({ color: 0x3b3a39, roughness: 0.9 });

  // ---- deck: box ribbon sampled along the profile
  const W = 13, TH = 4;
  const dpos: number[] = [], didx: number[] = [], rpos: number[] = [], ridx: number[] = [];
  const quad = (arr: number[], idx: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    const o = arr.length / 3; arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  for (let t = END_M; t < END_B; t += 8) {
    const t2 = Math.min(END_B, t + 8), y1 = deckY(t), y2 = deckY(t2);
    quad(rpos, ridx, P(t, -W, y1), P(t, W, y1), P(t2, W, y2), P(t2, -W, y2));               // roadway (top)
    quad(dpos, didx, P(t, W, y1), P(t, W, y1 - TH), P(t2, W, y2 - TH), P(t2, W, y2));       // side
    quad(dpos, didx, P(t2, -W, y2), P(t2, -W, y2 - TH), P(t, -W, y1 - TH), P(t, -W, y1));   // side
    quad(dpos, didx, P(t, -W, y1 - TH), P(t, W, y1 - TH), P(t2, W, y2 - TH), P(t2, -W, y2 - TH)); // underside
  }
  const mk = (pos: number[], idx: number[], mat: THREE.Material) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true;
    (mat as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    return m;
  };
  g.add(mk(rpos, ridx, road), mk(dpos, didx, steel));

  // ---- towers: base block, three piers, crown block
  const box = (t: number, s: number, y0: number, y1: number, lt: number, ls: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(lt, y1 - y0, ls), stone);
    const c = P(t, s, (y0 + y1) / 2);
    m.position.copy(c);
    m.rotation.y = -fp.angle;
    m.castShadow = m.receiveShadow = true;
    return m;
  };
  for (const tt of [-TOWER, TOWER]) {
    const dy = deckY(tt);
    g.add(box(tt, 0, -3, dy - 2, 22, 44));                 // caisson + base
    g.add(box(tt, -17.5, dy - 2, 66, 16, 9));              // outer pier
    g.add(box(tt, 17.5, dy - 2, 66, 16, 9));               // outer pier
    g.add(box(tt, 0, dy - 2, 66, 16, 8));                  // centre pier
    g.add(box(tt, 0, 58, 66, 15, 44));                     // arch spandrel
    g.add(box(tt, 0, 66, 81, 18, 44));                     // crown
    g.add(box(tt, 0, 81, 84.3, 20, 46));                   // cornice
  }

  // ---- main cables (4), suspenders, diagonal stays
  const cableS = [-15.5, -5, 5, 15.5];
  const cableY = (t: number) => {
    const a = Math.abs(t);
    if (a <= TOWER) return 46 + 34 * (t / TOWER) ** 2;          // main span: 46 m at centre -> 80 m at towers
    const k = (a - TOWER) / (ANCHOR - TOWER);                    // side span: tower 80 -> anchorage 33 with sag
    return 80 + (33 - 80) * k - 9 * Math.sin(Math.PI * k);
  };
  const cablePts: number[] = [], susp: number[] = [], stays: number[] = [], necklace: number[] = [];
  for (const s of cableS) {
    for (let t = -ANCHOR; t < ANCHOR; t += 4) {
      const a = P(t, s, cableY(t)), b = P(t + 4, s, cableY(t + 4));
      cablePts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (let t = -ANCHOR + 6; t < ANCHOR; t += 6) {
      if (Math.abs(Math.abs(t) - TOWER) < 10) continue;
      const a = P(t, s, cableY(t)), b = P(t, s, deckY(t));
      susp.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    if (Math.abs(s) > 10) for (let t = -ANCHOR; t <= ANCHOR; t += 7) necklace.push(...P(t, s, cableY(t) + 0.6).toArray());
  }
  // diagonal stays radiating from each tower top to the deck
  for (const tt of [-TOWER, TOWER]) for (const dir of [-1, 1]) for (const s of [-15.5, 15.5]) {
    const top = P(tt, s, 79);
    for (let d = 14; d <= 140; d += 9) {
      const t = tt + dir * d;
      if (Math.abs(t) > ANCHOR) continue;
      const b = P(t, s, deckY(t));
      stays.push(top.x, top.y, top.z, b.x, b.y, b.z);
    }
  }
  const line = (pts: number[], color: number, opacity: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  };
  g.add(line(cablePts, 0x2e2b28, 1), line(susp, 0x3b3835, 0.55), line(stays, 0x3b3835, 0.5));
  g.add(createGlowPoints(necklace));
  // lamp posts along the promenade
  const lamps: number[] = [];
  for (let t = END_M + 40; t < END_B - 40; t += 30) for (const s of [-3, 3]) lamps.push(...P(t, s, deckY(t) + 4).toArray());
  g.add(createGlowPoints(lamps, new THREE.Color(1.0, 0.72, 0.42), 1500));
  return g;
}
