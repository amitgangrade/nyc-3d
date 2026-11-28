/**
 * Terrain patches: hand-tuned, high-fidelity treatment of special areas (Central Park).
 *
 * A patch is rendered as ONE draped terrain mesh instead of flat polygon layers:
 *   - relief from NYC Planimetric spot elevations, made relative to the park edge
 *     (harmonic baseline) so the park meets the surrounding streets at street level
 *     while keeping its hills, rock outcrops, lake basins and sunken transverse roads
 *   - a 1 m/px "surface class" raster rasterised from OpenStreetMap (lawns, woods,
 *     rock, ballfields, gardens, playgrounds, paths, drives, steps, plazas, water, bridges)
 *   - trees (OSM-mapped trees + woodland/lawn fill) and path lamps placed on the terrain
 *
 * Outputs public/data/patches/<id>.{json,class.png,height.bin,trees.bin,lamps.bin}
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Projection } from '../src/core/projection';
import { cachedJSON, socrataGeoJSON } from './fetch';
import { pointInRing, signedArea, type Poly, type Pt } from './geo';
import { overpass, elPolys, elLine, parseLength, type OsmEl } from './providers/osm';

export interface PatchDef {
  id: string; name: string;
  /** OSM name of the leisure=park outline */
  osmName: string;
  bbox: [number, number, number, number];
  /** metres per raster pixel / per height-grid cell */
  resolution: number; gridCell: number;
  /** remove these layers of the named regions inside the patch outline */
  replaces: { region: string; layers: string[] }[];
}

/** Surface classes (must match src/render/Patch.ts). */
export const C = {
  LAWN: 0, GRASS: 1, WOOD: 2, GARDEN: 3, ROCK: 4, CLAY: 5, PITCH: 6, PLAYGROUND: 7, PLAZA: 8,
  PATH: 9, GRAVEL: 10, ROAD: 11, STEPS: 12, WATER: 13, ICE: 14, BRIDGE: 15, OUTSIDE: 255,
} as const;

export interface PatchMeta {
  id: string; name: string;
  /** patch frame: scene point of raster pixel (0,0) corner, unit axes */
  origin: [number, number]; axisU: [number, number]; axisV: [number, number];
  resolution: number; width: number; height: number;
  grid: { cell: number; nu: number; nv: number; scale: number };
  baseY: number;
  outline: [number, number][];
  trees: number; lamps: number;
  files: { classes: string; heights: string; trees: string; lamps: string };
}

const FT = 0.3048;

export async function buildPatch(def: PatchDef, proj: Projection, cacheDir: string, outDir: string, refresh: boolean, baseY: number): Promise<PatchMeta> {
  console.log(`\n▶ Patch ${def.id} (${def.name})`);
  mkdirSync(cacheDir, { recursive: true });
  const [w, s, e, n] = def.bbox;
  const b = `${s},${w},${n},${e}`;

  // ---------------------------------------------------------------- OSM
  const osm = await cachedJSON<OsmEl[]>(join(cacheDir, 'osm.json'), refresh, async () => {
    const all = new Map<string, OsmEl>();
    const queries = [
      `[out:json][timeout:180];(way["leisure"](${b});relation["leisure"](${b});way["landuse"](${b});relation["landuse"](${b});
        way["natural"](${b});relation["natural"](${b});way["man_made"](${b});way["amenity"](${b});way["place"](${b});
        way["area:highway"](${b}););out geom qt;`,
      `[out:json][timeout:180];(way["highway"](${b}););out geom qt;`,
      `[out:json][timeout:180];(node["natural"="tree"](${b});node["highway"="street_lamp"](${b}););out qt;`,
    ];
    for (const q of queries) {
      process.stdout.write('    Overpass… ');
      const els = (JSON.parse(await overpass(q, cacheDir)) as { elements: OsmEl[] }).elements;
      console.log(`${els.length} elements`);
      for (const el of els) all.set(`${el.type}/${el.id}`, el);
    }
    return [...all.values()];
  });

  // park outline: largest polygon of the named leisure=park
  let outline: Pt[] | null = null;
  for (const el of osm) {
    if (el.tags?.leisure !== 'park' || el.tags?.name !== def.osmName) continue;
    for (const p of elPolys(el, proj)) if (!outline || Math.abs(signedArea(p[0])) > Math.abs(signedArea(outline))) outline = p[0];
  }
  if (!outline) throw new Error(`no leisure=park named "${def.osmName}" found`);
  if (signedArea(outline) < 0) outline = outline.slice().reverse();
  console.log(`    outline: ${outline.length} vertices, ${(Math.abs(signedArea(outline)) / 1e6).toFixed(2)} km²`);

  // ---------------------------------------------------------------- frame (min-area rectangle)
  let best = { area: Infinity, a: 0, u0: 0, u1: 0, v0: 0, v1: 0 };
  for (let i = 0; i < outline.length; i++) {
    const j = (i + 1) % outline.length;
    const a = Math.atan2(outline[j][1] - outline[i][1], outline[j][0] - outline[i][0]);
    const ca = Math.cos(a), sa = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of outline) { const u = x * ca + z * sa, v = -x * sa + z * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) best = { area, a, u0, u1, v0, v1 };
  }
  const M = 12; // margin
  const ca = Math.cos(best.a), sa = Math.sin(best.a);
  const axisU: [number, number] = [ca, sa], axisV: [number, number] = [-sa, ca];
  const U0 = best.u0 - M, V0 = best.v0 - M;
  const origin: [number, number] = [U0 * ca - V0 * sa, U0 * sa + V0 * ca];
  const R = def.resolution;
  const W = Math.ceil((best.u1 - best.u0 + 2 * M) / R), H = Math.ceil((best.v1 - best.v0 + 2 * M) / R);
  const toUV = (x: number, z: number): [number, number] => {
    const dx = x - origin[0], dz = z - origin[1];
    return [(dx * axisU[0] + dz * axisU[1]) / R, (dx * axisV[0] + dz * axisV[1]) / R];
  };
  const toXZ = (u: number, v: number): [number, number] => [origin[0] + (axisU[0] * u + axisV[0] * v) * R, origin[1] + (axisU[1] * u + axisV[1] * v) * R];
  console.log(`    raster ${W}×${H} @ ${R} m/px`);

  // ---------------------------------------------------------------- rasteriser
  const cls = new Uint8Array(W * H).fill(C.LAWN);
  const fillPoly = (poly: Poly, c: number, target = cls) => {
    const rings = poly.map((r) => r.map(([x, z]) => toUV(x, z)));
    let vmin = Infinity, vmax = -Infinity;
    for (const r of rings) for (const [, v] of r) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
    for (let py = Math.max(0, Math.floor(vmin)); py <= Math.min(H - 1, Math.ceil(vmax)); py++) {
      const yc = py + 0.5, xs: number[] = [];
      for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [ax, ay] = r[j], [bx, by] = r[i];
        if ((ay > yc) !== (by > yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let px = x0; px <= x1; px++) target[py * W + px] = c;
      }
    }
  };
  const stroke = (line: Pt[], width: number, c: number) => {
    const r = width / 2 / R;
    const pts = line.map(([x, z]) => toUV(x, z));
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r));
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5, cy = py + 0.5;
        const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / l2));
        const ex = ax + t * dx - cx, ey = ay + t * dy - cy;
        if (ex * ex + ey * ey <= r * r) cls[py * W + px] = c;
      }
    }
  };

  // area classes, drawn lowest priority first
  const T = (el: OsmEl) => el.tags ?? {};
  const areaRules: [(t: Record<string, string>) => boolean, number][] = [
    [(t) => /^(grass|meadow|village_green|recreation_ground)$/.test(t.landuse ?? '') || t.natural === 'grassland', C.GRASS],
    [(t) => t.leisure === 'garden' || t.landuse === 'flowerbed' || /^(scrub|shrubbery|heath)$/.test(t.natural ?? '') || t.man_made === 'planter', C.GARDEN],
    [(t) => t.natural === 'wood' || t.landuse === 'forest', C.WOOD],
    [(t) => t.leisure === 'pitch' && !/^(clay|dirt|sand|earth|ground)$/.test(t.surface ?? ''), C.PITCH],
    [(t) => (t.leisure === 'pitch' && /^(clay|dirt|sand|earth|ground)$/.test(t.surface ?? '')) || t.natural === 'sand' || t.leisure === 'track', C.CLAY],
    [(t) => t.leisure === 'playground', C.PLAYGROUND],
    [(t) => t.natural === 'bare_rock' || t.natural === 'rock' || t.natural === 'stone', C.ROCK],
    [(t) => t.natural === 'water' || t.amenity === 'fountain' || t.leisure === 'swimming_pool' || t.water !== undefined, C.WATER],
    [(t) => t.leisure === 'ice_rink', C.ICE],
    [(t) => (t.highway === 'pedestrian' && t.area === 'yes') || t['area:highway'] !== undefined || t.place === 'square' || t.amenity === 'parking', C.PLAZA],
    [(t) => t.man_made === 'bridge', C.BRIDGE],
  ];
  for (const [test, c] of areaRules) {
    for (const el of osm) {
      if (el.type === 'node' || !test(T(el))) continue;
      if (T(el).leisure === 'park' && T(el).name === def.osmName) continue;
      for (const p of elPolys(el, proj)) fillPoly(p, c);
    }
  }
  // linear features
  const roadW: Record<string, number> = { primary: 10, secondary: 9, tertiary: 8, residential: 7, unclassified: 7, service: 5, living_street: 6 };
  const lines: { line: Pt[]; w: number; c: number; bridge: boolean; lamp: boolean }[] = [];
  for (const el of osm) {
    const t = T(el);
    if (el.type !== 'way' || !t.highway || t.area === 'yes' || t.highway === 'proposed' || t.highway === 'construction') continue;
    const line = elLine(el, proj);
    if (!line) continue;
    const unpaved = /^(unpaved|gravel|fine_gravel|dirt|compacted|ground|earth|woodchips|sand|grass|pebblestone)$/.test(t.surface ?? '');
    let w = parseLength(t.width) ?? 0, c: number = C.PATH, lamp = true;
    if (roadW[t.highway]) { c = C.ROAD; w ||= roadW[t.highway]; lamp = false; }
    else if (t.highway === 'steps') { c = C.STEPS; w ||= 3; }
    else if (t.highway === 'bridleway') { c = C.GRAVEL; w ||= 3.5; }
    else if (/^(footway|path|pedestrian|cycleway|track)$/.test(t.highway)) { c = unpaved ? C.GRAVEL : C.PATH; w ||= t.highway === 'pedestrian' ? 6 : t.highway === 'path' ? 2.2 : 3; if (t.footway === 'sidewalk') w = Math.max(w, 3); }
    else continue;
    lines.push({ line, w: Math.min(w, 14), c, bridge: !!t.bridge && t.bridge !== 'no', lamp });
  }
  for (const l of lines) if (!l.bridge) stroke(l.line, l.w, l.c);
  for (const l of lines) if (l.bridge) stroke(l.line, l.w + 1, C.BRIDGE);

  // outside the park → transparent
  const inside = new Uint8Array(W * H);
  fillPoly([outline], 1, inside);
  let insideCount = 0;
  for (let i = 0; i < W * H; i++) { if (!inside[i]) cls[i] = C.OUTSIDE; else insideCount++; }
  const hist = new Map<number, number>();
  for (let i = 0; i < W * H; i++) if (inside[i]) hist.set(cls[i], (hist.get(cls[i]) ?? 0) + 1);
  console.log('    surface mix:', [...hist].sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `${Object.keys(C).find((n2) => (C as any)[n2] === k)} ${(100 * v / insideCount).toFixed(1)}%`).join(', '));

  // ---------------------------------------------------------------- terrain
  const elev = await cachedJSON<GeoJSON.Feature[]>(join(cacheDir, 'elevation.geojson'), refresh,
    () => socrataGeoJSON('data.cityofnewyork.us', '9uxf-ng6q', [w - 0.004, s - 0.004, e + 0.004, n + 0.004]));
  const pts = elev.map((f) => {
    const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
    const [x, z] = proj.forward(lon, lat);
    const [u, v] = toUV(x, z);
    return { u: u * R, v: v * R, h: parseFloat((f.properties as any).elevation) * FT };
  }).filter((p) => isFinite(p.h) && p.h > -5 && p.h < 120);
  console.log(`    ${pts.length} spot elevations`);
  const G = def.gridCell;
  const nu = Math.ceil((W * R) / G) + 1, nv = Math.ceil((H * R) / G) + 1;
  // bucket points
  const BK = 30, buckets = new Map<string, typeof pts>();
  for (const p of pts) { const k = `${Math.floor(p.u / BK)},${Math.floor(p.v / BK)}`; (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(p); }
  const dem = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const u = i * G, v = j * G;
    let sw = 0, sh = 0, rad = 1;
    for (; rad <= 4 && sw === 0; rad++) {
      const bu = Math.floor(u / BK), bv = Math.floor(v / BK);
      for (let a = -rad; a <= rad; a++) for (let c2 = -rad; c2 <= rad; c2++) for (const p of buckets.get(`${bu + a},${bv + c2}`) ?? []) {
        const d2 = (p.u - u) ** 2 + (p.v - v) ** 2;
        const wgt = 1 / (d2 + 9) ** 1.5;
        sw += wgt; sh += wgt * p.h;
      }
    }
    dem[j * nu + i] = sw ? sh / sw : NaN;
  }
  // fill gaps
  let mean = 0, cnt = 0;
  for (const h of dem) if (isFinite(h)) { mean += h; cnt++; }
  mean /= cnt || 1;
  for (let k = 0; k < dem.length; k++) if (!isFinite(dem[k])) dem[k] = mean;

  // which grid nodes are inside the park (sample class raster)
  const nodeInside = new Uint8Array(nu * nv);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const px = Math.min(W - 1, Math.floor((i * G) / R)), py = Math.min(H - 1, Math.floor((j * G) / R));
    nodeInside[j * nu + i] = inside[py * W + px];
  }
  // harmonic baseline from the park edge (Jacobi relaxation, multi-resolution warm start)
  const base = Float32Array.from(dem);
  for (let k = 0; k < base.length; k++) if (nodeInside[k]) base[k] = mean;
  for (let it = 0; it < 4000; it++) {
    let maxd = 0;
    for (let j = 1; j < nv - 1; j++) for (let i = 1; i < nu - 1; i++) {
      const k = j * nu + i;
      if (!nodeInside[k]) continue;
      const nv2 = (base[k - 1] + base[k + 1] + base[k - nu] + base[k + nu]) * 0.25;
      maxd = Math.max(maxd, Math.abs(nv2 - base[k]));
      base[k] = nv2;
    }
    if (maxd < 0.002) break;
  }
  let relief = new Float32Array(nu * nv);
  for (let k = 0; k < relief.length; k++) relief[k] = nodeInside[k] ? dem[k] - base[k] : 0;
  // suppress spikes (spot heights on structures) with a median filter, then soften with a small blur
  {
    const med = Float32Array.from(relief), win: number[] = [];
    for (let j = 1; j < nv - 1; j++) for (let i = 1; i < nu - 1; i++) {
      const k = j * nu + i; if (!nodeInside[k]) continue;
      win.length = 0;
      for (let a = -1; a <= 1; a++) for (let c2 = -1; c2 <= 1; c2++) win.push(relief[k + a * nu + c2]);
      win.sort((x, y) => x - y); med[k] = win[4];
    }
    const blur = Float32Array.from(med);
    for (let pass = 0; pass < 2; pass++) {
      const src = Float32Array.from(blur);
      for (let j = 1; j < nv - 1; j++) for (let i = 1; i < nu - 1; i++) {
        const k = j * nu + i; if (!nodeInside[k]) continue;
        blur[k] = (src[k] * 4 + src[k - 1] + src[k + 1] + src[k - nu] + src[k + nu]) / 8;
      }
    }
    relief = blur;
  }
  for (let k = 0; k < relief.length; k++) relief[k] = nodeInside[k] ? Math.max(-12, Math.min(18, relief[k])) : 0;

  // flatten water bodies to a level surface a little below their banks
  const sampleRelief = (u: number, v: number) => {
    const fu = Math.max(0, Math.min(nu - 1.001, u / G)), fv = Math.max(0, Math.min(nv - 1.001, v / G));
    const i = Math.floor(fu), j = Math.floor(fv), tu = fu - i, tv = fv - j;
    const a = relief[j * nu + i], b2 = relief[j * nu + i + 1], c2 = relief[(j + 1) * nu + i], d = relief[(j + 1) * nu + i + 1];
    return (a * (1 - tu) + b2 * tu) * (1 - tv) + (c2 * (1 - tu) + d * tu) * tv;
  };
  let lakes = 0;
  for (const el of osm) {
    const t = T(el);
    if (el.type === 'node' || !(t.natural === 'water' || t.water !== undefined)) continue;
    for (const p of elPolys(el, proj)) {
      const ring = p[0].map(([x, z]) => toUV(x, z)).map(([u, v]) => [u * R, v * R] as Pt);
      const edge = ring.map(([u, v]) => sampleRelief(u, v)).sort((a, b2) => a - b2);
      if (!edge.length) continue;
      const level = edge[Math.floor(edge.length * 0.2)] - 0.6;
      let touched = 0;
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        if (pointInRing([i * G, j * G], ring)) { relief[j * nu + i] = Math.min(relief[j * nu + i], level); touched++; }
      }
      // nodes just outside the shore: never below the water level (keeps a bank)
      if (touched) lakes++;
    }
  }
  let rmin = Infinity, rmax = -Infinity;
  for (let k = 0; k < relief.length; k++) if (nodeInside[k]) { rmin = Math.min(rmin, relief[k]); rmax = Math.max(rmax, relief[k]); }
  console.log(`    terrain ${nu}×${nv} @ ${G} m, relief ${rmin.toFixed(1)}…${rmax.toFixed(1)} m, ${lakes} water bodies levelled`);

  // ---------------------------------------------------------------- trees
  const classAt = (x: number, z: number) => {
    const [u, v] = toUV(x, z);
    const px = Math.floor(u), py = Math.floor(v);
    return px < 0 || py < 0 || px >= W || py >= H ? C.OUTSIDE : cls[py * W + px];
  };
  const reliefAt = (x: number, z: number) => { const [u, v] = toUV(x, z); return sampleRelief(u * R, v * R); };
  const trees: number[] = [];
  const grid = new Map<string, Pt[]>();
  const near = (x: number, z: number, d: number) => {
    const gx = Math.floor(x / 8), gz = Math.floor(z / 8);
    for (let a = -1; a <= 1; a++) for (let c2 = -1; c2 <= 1; c2++) for (const q of grid.get(`${gx + a},${gz + c2}`) ?? []) if ((q[0] - x) ** 2 + (q[1] - z) ** 2 < d * d) return true;
    return false;
  };
  const addTree = (x: number, z: number, r: number, h: number, kind: number, seed: number) => {
    const k = `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push([x, z]);
    trees.push(x, z, r, h, kind, seed, baseY + reliefAt(x, z));
  };
  const hash = (a: number, b2: number) => { let h = Math.imul(a | 0, 374761393) + Math.imul(b2 | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  let mapped = 0;
  for (const el of osm) {
    if (el.type !== 'node' || el.tags?.natural !== 'tree') continue;
    const [x, z] = proj.forward(el.lon!, el.lat!);
    const c = classAt(x, z);
    if (c === C.OUTSIDE || c === C.WATER) continue;
    const t = el.tags;
    const g = `${t.genus ?? ''} ${t.species ?? ''} ${t['species:en'] ?? ''}`.toLowerCase();
    const kind = t.leaf_type === 'needleleaved' || /pinus|picea|abies|tsuga|taxus|thuja|pine|spruce|fir|hemlock/.test(g) ? 2
      : /gleditsia|robinia|ginkgo|locust/.test(g) ? 1 : /prunus|malus|pyrus|cornus|cercis|magnolia|cherry/.test(g) ? 3 : 0;
    const h = Math.min(30, parseLength(t.height) ?? 12 + hash(el.id, 7) * 12);
    const circ = parseLength(t.circumference);
    const r = Math.min(10, circ ? 1.5 + circ * 1.6 : h * 0.32);
    addTree(x, z, r, h, kind, hash(el.id, 3));
    mapped++;
  }
  // woodland / lawn fill on a jittered grid
  let filled = 0;
  const fill = (spacing: number, accept: (c: number) => number, seedOff: number, minD: number) => {
    const [u0, v0, u1, v1] = [0, 0, W * R, H * R];
    for (let gv = Math.floor(v0 / spacing); gv * spacing < v1; gv++) for (let gu = Math.floor(u0 / spacing); gu * spacing < u1; gu++) {
      const h1 = hash(gu * 31 + seedOff, gv), h2 = hash(gu, gv * 17 + seedOff), h3 = hash(gu + seedOff, gv + 999);
      const u = (gu + 0.1 + 0.8 * h1) * spacing, v = (gv + 0.1 + 0.8 * h2) * spacing;
      const [x, z] = toXZ(u / R, v / R);
      const p = accept(classAt(x, z));
      if (h3 > p || near(x, z, minD)) continue;
      // keep trees a few metres off paths and water
      let clear = true;
      for (const [du, dv] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
        const [xx, zz] = toXZ((u + du) / R, (v + dv) / R);
        const c2 = classAt(xx, zz);
        if (c2 === C.PATH || c2 === C.ROAD || c2 === C.WATER || c2 === C.PLAZA || c2 === C.STEPS || c2 === C.GRAVEL) { clear = false; break; }
      }
      if (!clear) continue;
      const hgt = 10 + h1 * h2 * 16 + h3 * 4;
      addTree(x, z, Math.min(9, 2.6 + hgt * 0.22), hgt, hash(gu, gv + 5) < 0.08 ? 2 : 0, hash(gu + 3, gv));
      filled++;
    }
  };
  fill(6, (c) => (c === C.WOOD ? 0.92 : c === C.GARDEN ? 0.35 : 0), 1, 4.2);
  fill(12, (c) => (c === C.LAWN ? 0.55 : c === C.ROCK ? 0.15 : 0), 2, 6.5);
  fill(30, (c) => (c === C.GRASS ? 0.22 : 0), 3, 12);
  console.log(`    trees: ${mapped} mapped + ${filled} woodland/lawn fill`);

  // ---------------------------------------------------------------- lamps along paths
  const lamps: number[] = [];
  const osmLamps = osm.filter((el) => el.type === 'node' && el.tags?.highway === 'street_lamp');
  for (const el of osmLamps) {
    const [x, z] = proj.forward(el.lon!, el.lat!);
    if (classAt(x, z) !== C.OUTSIDE) lamps.push(x, baseY + reliefAt(x, z), z);
  }
  if (lamps.length / 3 < 600) { // too few mapped inside the park: place lamps along paths
    const lg = new Map<string, Pt[]>();
    for (let k = 0; k < lamps.length; k += 3) { const kk = `${Math.floor(lamps[k] / 20)},${Math.floor(lamps[k + 2] / 20)}`; (lg.get(kk) ?? lg.set(kk, []).get(kk)!).push([lamps[k], lamps[k + 2]]); }
    const lampNear = (x: number, z: number) => {
      const gx = Math.floor(x / 20), gz = Math.floor(z / 20);
      for (let a = -1; a <= 1; a++) for (let c2 = -1; c2 <= 1; c2++) for (const q of lg.get(`${gx + a},${gz + c2}`) ?? []) if ((q[0] - x) ** 2 + (q[1] - z) ** 2 < 18 * 18) return true;
      return false;
    };
    for (const l of lines) {
      if (!l.lamp || l.c === C.GRAVEL) continue;
      let carry = 12;
      for (let i = 0; i + 1 < l.line.length; i++) {
        const [x0, z0] = l.line[i], [x1, z1] = l.line[i + 1];
        const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
        if (len < 1e-3) continue;
        const ox = (-dz / len) * (l.w / 2 + 0.6), oz = (dx / len) * (l.w / 2 + 0.6);
        let sd = carry;
        for (; sd < len; sd += 26) {
          const x = x0 + (dx * sd) / len + ox, z = z0 + (dz * sd) / len + oz;
          const c = classAt(x, z);
          if (c === C.OUTSIDE || c === C.WATER || lampNear(x, z)) continue;
          const k = `${Math.floor(x / 20)},${Math.floor(z / 20)}`;
          (lg.get(k) ?? lg.set(k, []).get(k)!).push([x, z]);
          lamps.push(x, baseY + reliefAt(x, z), z);
        }
        carry = sd - len;
      }
    }
  }
  console.log(`    lamps: ${lamps.length / 3}`);

  // ---------------------------------------------------------------- write
  const dir = join(outDir, 'patches');
  mkdirSync(dir, { recursive: true });
  const png = new PNG({ width: W, height: H, colorType: 0, inputColorType: 0, bitDepth: 8 });
  png.data = Buffer.from(cls);
  writeFileSync(join(dir, `${def.id}.class.png`), PNG.sync.write(png, { colorType: 0, inputColorType: 0 }));
  const SCALE = 0.02; // 2 cm units
  const h16 = new Int16Array(nu * nv);
  for (let k = 0; k < relief.length; k++) h16[k] = Math.round(relief[k] / SCALE);
  writeFileSync(join(dir, `${def.id}.height.bin`), Buffer.from(h16.buffer));
  writeFileSync(join(dir, `${def.id}.trees.bin`), Buffer.from(new Float32Array(trees).buffer));
  writeFileSync(join(dir, `${def.id}.lamps.bin`), Buffer.from(new Float32Array(lamps).buffer));
  const meta: PatchMeta = {
    id: def.id, name: def.name, origin, axisU, axisV, resolution: R, width: W, height: H,
    grid: { cell: G, nu, nv, scale: SCALE }, baseY,
    outline: outline.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]),
    trees: trees.length / 7, lamps: lamps.length / 3,
    files: { classes: `patches/${def.id}.class.png`, heights: `patches/${def.id}.height.bin`, trees: `patches/${def.id}.trees.bin`, lamps: `patches/${def.id}.lamps.bin` },
  };
  writeFileSync(join(dir, `${def.id}.json`), JSON.stringify(meta));
  return meta;
}

/** Outline of an already-built patch (used to cut it out of region layers). */
export function patchOutline(outDir: string, id: string): Pt[] | null {
  const p = join(outDir, 'patches', `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as PatchMeta).outline : null;
}

