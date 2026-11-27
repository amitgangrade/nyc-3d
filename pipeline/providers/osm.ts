/**
 * OpenStreetMap provider (via an Overpass API mirror), used for New Jersey
 * regions where NYC Open Data does not reach.
 *
 *   buildings  – building outlines + building:part volumes (Simple 3D Buildings):
 *                height / min_height / levels; otherwise Microsoft Global ML
 *                Building Footprints height estimate; otherwise a per-type default
 *   roads      – highway centre-lines, stored as polylines with a width by class
 *   paths      – footways / cycleways / steps (narrow polylines)
 *   parks      – parks, gardens, grass, woods, cemeteries, wetlands
 *   plazas     – pedestrian areas, squares, parking lots
 *   piers      – man_made=pier areas
 *   water      – ponds / reservoirs (rivers and the harbour are the global water plane)
 *   trees      – natural=tree nodes
 *
 * OSM data © OpenStreetMap contributors, ODbL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import type { Projection } from '../../src/core/projection';
import { cachedJSON, fetchRetry } from '../fetch';
import { centroid, cleanPoly, pointInRing, ringBBox, signedArea, type Poly, type Pt, type Ring } from '../geo';
import type { Feature, LayerSpec, Provider } from './types';

const OVERPASS = process.env.OVERPASS_URL ?? 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';

const LAYERS: Record<string, LayerSpec> = {
  buildings: { props: { height: 'f32', minHeight: 'f32', year: 'u16', bin: 'u32', kind: 'u8', osmType: 'u8' }, tolerance: 0.08 },
  roads: { props: { width: 'f32', elev: 'f32', lit: 'u8' }, tolerance: 0.3, geometry: 'line' },
  paths: { props: { width: 'f32', elev: 'f32' }, tolerance: 0.3, geometry: 'line' },
  parks: { props: {}, tolerance: 0.3 },
  plazas: { props: {}, tolerance: 0.2 },
  piers: { props: { elevation: 'f32' }, tolerance: 0.2 },
  water: { props: {}, tolerance: 0.3 },
  trees: { props: { dbh: 'u8', cls: 'u8' }, tolerance: 0, geometry: 'point' },
};

// ------------------------------------------------------------------ Overpass
interface OsmEl {
  type: 'node' | 'way' | 'relation'; id: number; tags?: Record<string, string>;
  lat?: number; lon?: number;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

/** Two lighter queries per chunk: public mirrors cut requests off after ~20 s. */
function overpassQueries([w, s, e, n]: number[]): string[] {
  const b = `${s},${w},${n},${e}`;
  const head = '[out:json][timeout:180][maxsize:1000000000];';
  return [
    `${head}(way["building"](${b}); relation["building"]["type"="multipolygon"](${b});
      way["building:part"](${b}); relation["building:part"]["type"="multipolygon"](${b}););out geom qt;`,
    `${head}(way["highway"](${b});
      way["leisure"~"^(park|garden|playground|pitch|dog_park|nature_reserve|golf_course|common)$"](${b});
      relation["leisure"~"^(park|garden|nature_reserve|golf_course)$"](${b});
      way["landuse"~"^(grass|recreation_ground|cemetery|meadow|village_green|forest)$"](${b});
      relation["landuse"~"^(grass|recreation_ground|cemetery|forest)$"](${b});
      way["natural"~"^(wood|scrub|grassland|water|wetland)$"](${b});
      relation["natural"~"^(wood|wetland)$"](${b});
      way["man_made"="pier"](${b}); way["amenity"="parking"](${b}); way["place"="square"](${b});
      node["natural"="tree"](${b}););out geom qt;`,
  ];
}

async function loadOsm(bbox: [number, number, number, number], refresh: boolean, cacheDir: string): Promise<OsmEl[]> {
  if (memo.has(cacheDir) && !refresh) return memo.get(cacheDir)!;
  // Query in a grid of chunks: public Overpass mirrors time out on large areas.
  const N = 6;
  const seen = new Map<string, OsmEl>();
  const [w, s, e, n] = bbox;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const cb: [number, number, number, number] = [w + ((e - w) * i) / N, s + ((n - s) * j) / N, w + ((e - w) * (i + 1)) / N, s + ((n - s) * (j + 1)) / N];
    const whole = join(cacheDir, `osm-${N}-${i}-${j}.json`); // older single-query cache
    const els = !refresh && existsSync(whole) ? (JSON.parse(readFileSync(whole, 'utf8')) as OsmEl[]) : [];
    if (!els.length) {
      const qs = overpassQueries(cb);
      for (let q = 0; q < qs.length; q++) {
        els.push(...await cachedJSON<OsmEl[]>(join(cacheDir, `osm-${N}-${i}-${j}-${q}.json`), refresh, async () => {
          process.stdout.write(`    Overpass chunk ${i * N + j + 1}/${N * N} part ${q + 1}… `);
          const jj = JSON.parse(await overpass(qs[q], cacheDir)) as { elements: OsmEl[] };
          console.log(`${jj.elements.length} elements`);
          return jj.elements;
        }));
      }
    }
    for (const el of els) seen.set(`${el.type}/${el.id}`, el);
  }
  const all = [...seen.values()];
  memo.set(cacheDir, all);
  return all;
}
const memo = new Map<string, OsmEl[]>();

/** POST a query with curl (more reliable than Node fetch against public Overpass mirrors), retrying 504s. */
async function overpass(query: string, cacheDir: string): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const qf = join(cacheDir, 'overpass-query.txt');
  writeFileSync(qf, query);
  for (let i = 0; ; i++) {
    try {
      return execFileSync('curl', ['-s', '-f', '-m', '400', '--data-urlencode', `data@${qf}`, OVERPASS], { maxBuffer: 1 << 30 }).toString('utf8');
    } catch (e) {
      if (i >= 15) throw e;
      const wait = 3000 * 2 ** Math.min(i, 4);
      process.stdout.write(`(retry in ${wait / 1000}s) `);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ------------------------------------------------------------------ geometry
type LL = { lat: number; lon: number };
const key = (p: LL) => `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;

/** Join open member ways into closed rings. */
function stitch(parts: LL[][]): LL[][] {
  const rings: LL[][] = [];
  const open = parts.filter((p) => p.length > 1).map((p) => p.slice());
  while (open.length) {
    let cur = open.pop()!;
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 10000) {
      const end = key(cur[cur.length - 1]);
      const i = open.findIndex((p) => key(p[0]) === end || key(p[p.length - 1]) === end);
      if (i < 0) break;
      const nxt = open.splice(i, 1)[0];
      cur = cur.concat(key(nxt[0]) === end ? nxt.slice(1) : nxt.reverse().slice(1));
    }
    if (cur.length >= 4 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

function elPolys(el: OsmEl, proj: Projection): Poly[] {
  const conv = (r: LL[]): Ring => r.map((p) => proj.forward(p.lon, p.lat));
  if (el.type === 'way') {
    const g = el.geometry;
    if (!g || g.length < 4 || key(g[0]) !== key(g[g.length - 1])) return [];
    return [[conv(g)]];
  }
  if (el.type === 'relation' && el.members) {
    const outer = stitch(el.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry!)).map(conv);
    const inner = stitch(el.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => m.geometry!)).map(conv);
    return outer.map((o) => [o, ...inner.filter((h) => pointInRing(h[0], o))]);
  }
  return [];
}

function elLine(el: OsmEl, proj: Projection): Pt[] | null {
  if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) return null;
  return el.geometry.map((p) => proj.forward(p.lon, p.lat));
}

/** Douglas–Peucker for open polylines. */
function simplifyLine(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let idx = -1, md = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i], [ax, az] = pts[a], [bx, bz] = pts[b];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
      const d = (ax + t * dx - px) ** 2 + (az + t * dz - pz) ** 2;
      if (d > md) { md = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ------------------------------------------------------------------ attributes
/** "123", "123 m", "400 ft", "400'", "12'6\"" -> metres */
export function parseLength(v?: string): number | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase().replace(',', '.');
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (ftIn) return (parseFloat(ftIn[1]) + (ftIn[2] ? parseFloat(ftIn[2]) / 12 : 0)) * 0.3048;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|feet)?$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return m[2] === 'ft' || m[2] === 'feet' ? n * 0.3048 : n;
}

const LEVEL_H = 3.2;
const DEFAULT_H: Record<string, number> = {
  house: 8.5, detached: 8.5, semidetached_house: 9, terrace: 10, residential: 10, apartments: 15,
  garage: 3.5, garages: 3.5, shed: 3, carport: 3, roof: 4, hut: 3, kiosk: 3,
  commercial: 9, retail: 7, office: 18, industrial: 9, warehouse: 10, church: 16, school: 12,
  hospital: 20, hotel: 25, train_station: 12, parking: 12,
};

function buildingKind(t: Record<string, string>): number {
  const b = t.building ?? t['building:part'];
  if (b === 'roof' || b === 'carport') return 3;
  if (b === 'garage' || b === 'garages' || b === 'parking') return 2;
  if (t['construction'] || b === 'construction') return 1;
  return 0;
}

function year(t: Record<string, string>): number {
  const m = (t.start_date ?? t['building:start_date'] ?? '').match(/(1[6-9]\d\d|20\d\d)/);
  return m ? parseInt(m[1]) : 0;
}

// ------------------------------------------------------------------ Microsoft heights
/** Height estimates from Microsoft Global ML Building Footprints for the bbox (centroid + height). */
async function msHeights(bbox: [number, number, number, number], proj: Projection, cacheDir: string): Promise<{ x: number; z: number; h: number }[]> {
  const path = join(cacheDir, 'ms-heights.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const qks = new Set<string>();
  for (const lon of [bbox[0], bbox[2]]) for (const lat of [bbox[1], bbox[3]]) qks.add(quadkey(lon, lat, 9));
  const links = await (await fetchRetry('https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv')).text();
  const out: { x: number; z: number; h: number }[] = [];
  for (const qk of qks) {
    const row = links.split('\n').find((l) => l.startsWith(`UnitedStates,${qk},`));
    if (!row) continue;
    const url = row.split(',')[2];
    console.log(`    Microsoft building heights: quadkey ${qk}`);
    const raw = join(cacheDir, `ms-${qk}.csv.gz`);
    if (!existsSync(raw)) writeFileSync(raw, Buffer.from(await (await fetchRetry(url)).arrayBuffer()));
    for (const line of gunzipSync(readFileSync(raw)).toString('utf8').split('\n')) {
      if (!line) continue;
      const i = line.indexOf('[[[');
      const j = line.indexOf(']', i);
      const [lon, lat] = line.slice(i + 3, j).split(',').map(Number);
      if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      const f = JSON.parse(line);
      const h = f.properties?.height;
      if (!(h > 0)) continue;
      const ring = (f.geometry.coordinates[0] as number[][]).map(([lo, la]) => proj.forward(lo, la));
      const [x, z] = centroid(ring);
      out.push({ x, z, h });
    }
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path, JSON.stringify(out));
  return out;
}

function quadkey(lon: number, lat: number, z: number) {
  const s = Math.sin((lat * Math.PI) / 180);
  const x = (lon + 180) / 360, y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  const n = 2 ** z, tx = Math.floor(x * n), ty = Math.floor(y * n);
  let q = '';
  for (let i = z; i > 0; i--) { const m = 1 << (i - 1); q += String((tx & m ? 1 : 0) + (ty & m ? 2 : 0)); }
  return q;
}

/** Simple uniform grid for point-in-polygon lookups. */
class Grid<T extends { x: number; z: number }> {
  private cells = new Map<string, T[]>();
  constructor(items: T[], private size = 50) {
    for (const it of items) {
      const k = `${Math.floor(it.x / size)},${Math.floor(it.z / size)}`;
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(it);
    }
  }
  within(bb: [number, number, number, number]): T[] {
    const out: T[] = [];
    for (let gx = Math.floor(bb[0] / this.size); gx <= Math.floor(bb[2] / this.size); gx++)
      for (let gz = Math.floor(bb[1] / this.size); gz <= Math.floor(bb[3] / this.size); gz++)
        out.push(...(this.cells.get(`${gx},${gz}`) ?? []));
    return out;
  }
}

// ------------------------------------------------------------------ layers
const ROAD_W: Record<string, number> = {
  motorway: 15, trunk: 13, primary: 12, secondary: 11, tertiary: 9.5, unclassified: 8, residential: 8,
  living_street: 6, service: 4.5, motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 7, tertiary_link: 6,
  busway: 7, road: 7,
};
const PATH_W: Record<string, number> = { footway: 2.6, path: 2.2, cycleway: 2.2, pedestrian: 5, steps: 2.4, track: 3, bridleway: 2.5 };
const LIT_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'trunk_link', 'primary_link', 'secondary_link']);

function bridgeElev(t: Record<string, string>): number {
  if (!t.bridge || t.bridge === 'no') return 0;
  const layer = Math.max(1, Math.min(4, parseInt(t.layer ?? '1') || 1));
  return 5 + (layer - 1) * 6;
}

function buildingFeatures(els: OsmEl[], proj: Projection, ms: { x: number; z: number; h: number }[]): Feature[] {
  const tol = LAYERS.buildings.tolerance;
  const parts: { el: OsmEl; poly: Poly; c: Pt }[] = [];
  const outlines: { el: OsmEl; poly: Poly; c: Pt }[] = [];
  for (const el of els) {
    const t = el.tags ?? {};
    const isPart = !!t['building:part'] && t['building:part'] !== 'no';
    const isBuilding = !!t.building && t.building !== 'no';
    if (!isPart && !isBuilding) continue;
    if (t.building === 'bridge' || t.location === 'underground' || t.layer?.startsWith('-')) continue;
    for (const p of elPolys(el, proj)) {
      const poly = cleanPoly(p, tol);
      if (!poly) continue;
      (isPart ? parts : outlines).push({ el, poly, c: centroid(poly[0]) });
    }
  }
  // Simple 3D Buildings: an outline that contains parts is represented by its parts
  const partGrid = new Grid(parts.map((p) => ({ x: p.c[0], z: p.c[1], p })), 40);
  const msGrid = new Grid(ms, 40);
  const out: Feature[] = [];
  let fromOsm = 0, fromMs = 0, fromDefault = 0;
  const emit = (el: OsmEl, poly: Poly, isPart: boolean, outlineTags?: Record<string, string>) => {
    const t = { ...(outlineTags ?? {}), ...(el.tags ?? {}) };
    let h = parseLength(t.height);
    const levels = parseFloat(t['building:levels'] ?? '');
    const roofLevels = parseFloat(t['roof:levels'] ?? '') || 0;
    if (h === undefined && isFinite(levels)) h = (levels + roofLevels * 0.5) * LEVEL_H + 1;
    let minH = parseLength(t.min_height);
    if (minH === undefined && t['building:min_level']) minH = (parseFloat(t['building:min_level']) || 0) * LEVEL_H;
    if (h !== undefined) fromOsm++;
    else {
      const bb = ringBBox(poly[0]);
      let best = 0;
      for (const m of msGrid.within(bb)) if (m.h > best && pointInRing([m.x, m.z], poly[0])) best = m.h;
      if (best > 0) { h = best; fromMs++; }
      else { h = DEFAULT_H[t.building ?? t['building:part'] ?? ''] ?? 8; fromDefault++; }
    }
    if ((t.building ?? t['building:part']) === 'roof' && minH === undefined) minH = Math.max(0, h - 1);
    minH = Math.max(0, Math.min(minH ?? 0, h - 0.5));
    out.push({ poly, props: { height: h, minHeight: minH, year: year(t), bin: el.id % 4294967296, kind: buildingKind(t), osmType: el.type === 'relation' ? 1 : 0 } });
  };
  for (const o of outlines) {
    const bb = ringBBox(o.poly[0]);
    const hasParts = partGrid.within(bb).some(({ p }) => pointInRing(p.c, o.poly[0]));
    if (!hasParts) emit(o.el, o.poly, false);
  }
  for (const p of parts) emit(p.el, p.poly, true);
  console.log(`    heights: ${fromOsm} OSM, ${fromMs} Microsoft estimate, ${fromDefault} default`);
  return out;
}

function polyLayer(els: OsmEl[], proj: Projection, test: (t: Record<string, string>) => boolean, tol: number, props: (t: Record<string, string>) => Record<string, number> = () => ({}), maxArea = Infinity): Feature[] {
  const out: Feature[] = [];
  for (const el of els) {
    const t = el.tags ?? {};
    if (el.type === 'node' || !test(t)) continue;
    for (const p of elPolys(el, proj)) {
      const poly = cleanPoly(p, tol, 4);
      if (!poly || Math.abs(signedArea(poly[0])) > maxArea) continue;
      out.push({ poly, props: props(t) });
    }
  }
  return out;
}

function lineLayer(els: OsmEl[], proj: Projection, widths: Record<string, number>, tol: number, extra: (t: Record<string, string>) => Record<string, number>): Feature[] {
  const out: Feature[] = [];
  for (const el of els) {
    const t = el.tags ?? {};
    const w = widths[t.highway ?? ''];
    if (el.type !== 'way' || !w || t.area === 'yes' || (t.tunnel && t.tunnel !== 'no') || t.indoor === 'yes') continue;
    const line = elLine(el, proj);
    if (!line) continue;
    const lanes = parseFloat(t.lanes ?? '');
    const width = isFinite(lanes) && widths === ROAD_W ? Math.max(w * 0.7, Math.min(w * 1.6, lanes * 3.4 + 1)) : w;
    out.push({ line: simplifyLine(line, tol), props: { width, elev: bridgeElev(t), ...extra(t) } });
  }
  return out;
}

const PARK = (t: Record<string, string>) =>
  /^(park|garden|playground|pitch|dog_park|nature_reserve|golf_course|common)$/.test(t.leisure ?? '') ||
  /^(grass|recreation_ground|cemetery|meadow|village_green|forest)$/.test(t.landuse ?? '') ||
  /^(wood|scrub|grassland|wetland)$/.test(t.natural ?? '');

export const osmProvider: Provider = {
  id: 'osm',
  layers: LAYERS,
  async fetchLayer(layer, bbox, proj, refresh, cacheDir) {
    const els = await loadOsm(bbox, refresh, cacheDir);
    switch (layer) {
      case 'buildings': return buildingFeatures(els, proj, await msHeights(bbox, proj, cacheDir));
      case 'roads': return lineLayer(els, proj, ROAD_W, LAYERS.roads.tolerance, (t) => ({ lit: LIT_CLASSES.has(t.highway) || t.lit === 'yes' ? 1 : 0 }));
      case 'paths': return lineLayer(els, proj, PATH_W, LAYERS.paths.tolerance, () => ({}));
      case 'parks': return polyLayer(els, proj, PARK, LAYERS.parks.tolerance);
      case 'plazas': return polyLayer(els, proj, (t) => t.amenity === 'parking' || t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes'), LAYERS.plazas.tolerance);
      case 'piers': return polyLayer(els, proj, (t) => t.man_made === 'pier', LAYERS.piers.tolerance, () => ({ elevation: 2 }));
      case 'water': return polyLayer(els, proj, (t) => t.natural === 'water' && !/^(river|bay|harbour|canal|basin)$/.test(t.water ?? ''), LAYERS.water.tolerance, () => ({}), 400000);
      case 'trees': {
        const out: Feature[] = [];
        for (const el of els) {
          if (el.type !== 'node' || el.tags?.natural !== 'tree') continue;
          const circ = parseLength(el.tags.circumference);
          const dbh = circ ? Math.min(60, (circ / Math.PI) * 39.37) : 10;
          out.push({ point: proj.forward(el.lon!, el.lat!), props: { dbh, cls: el.tags.leaf_type === 'needleleaved' ? 2 : 0 } });
        }
        return out;
      }
    }
    throw new Error(`osm provider has no layer ${layer}`);
  },
};


// ------------------------------------------------------------------ 3D parts overlay
export interface OsmPart { poly: Poly; height: number; minHeight: number; c: Pt; area: number }

/**
 * OSM `building:part` volumes (with heights) inside a bbox. Used by other
 * providers to refine flat footprint extrusions into stepped towers.
 */
export async function fetchOsmBuildingParts(bbox: [number, number, number, number], proj: Projection, cacheDir: string, refresh: boolean): Promise<OsmPart[]> {
  const [w, s, e, n] = bbox;
  const NX = Math.max(1, Math.ceil((e - w) / 0.02)), NY = Math.max(1, Math.ceil((n - s) / 0.015));
  const seen = new Map<string, OsmEl>();
  for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
    const b = `${s + ((n - s) * j) / NY},${w + ((e - w) * i) / NX},${s + ((n - s) * (j + 1)) / NY},${w + ((e - w) * (i + 1)) / NX}`;
    const els = await cachedJSON<OsmEl[]>(join(cacheDir, `parts-${NX}x${NY}-${i}-${j}.json`), refresh, async () => {
      process.stdout.write(`    OSM building parts ${i * NY + j + 1}/${NX * NY}… `);
      const q = `[out:json][timeout:180];(way["building:part"](${b});relation["building:part"]["type"="multipolygon"](${b}););out geom qt;`;
      const jj = JSON.parse(await overpass(q, cacheDir)) as { elements: OsmEl[] };
      console.log(`${jj.elements.length} parts`);
      return jj.elements;
    });
    for (const el of els) seen.set(`${el.type}/${el.id}`, el);
  }
  const out: OsmPart[] = [];
  for (const el of seen.values()) {
    const t = el.tags ?? {};
    if (t['building:part'] === 'no' || t.location === 'underground') continue;
    let h = parseLength(t.height);
    const lv = parseFloat(t['building:levels'] ?? '');
    if (h === undefined && isFinite(lv)) h = lv * LEVEL_H + 1;
    if (h === undefined || h <= 0) continue;
    let minH = parseLength(t.min_height);
    if (minH === undefined && t['building:min_level']) minH = (parseFloat(t['building:min_level']) || 0) * LEVEL_H;
    for (const p of elPolys(el, proj)) {
      const poly = cleanPoly(p, 0.08);
      if (!poly) continue;
      out.push({ poly, height: h, minHeight: Math.max(0, Math.min(minH ?? 0, h - 0.5)), c: centroid(poly[0]), area: Math.abs(signedArea(poly[0])) });
    }
  }
  return out;
}
