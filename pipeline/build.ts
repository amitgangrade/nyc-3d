/**
 * Data pipeline entry point.
 *
 *   npm run data -- lower-manhattan          build one region
 *   npm run data -- --all                    build every region in config/regions.json
 *   npm run data -- --context                build shared context land (all boroughs + nearby NJ/NY counties)
 *   npm run data -- --patches                build terrain patches (Central Park) — run before the regions they cut into
 *   add --refresh to re-download instead of using data-cache/
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { Projection } from '../src/core/projection';
import { encodeTile, type TypedArray } from '../src/core/tileFormat';
import type { Manifest, ManifestRegion, ManifestTile } from '../src/core/manifest';
import { cachedJSON, fetchRetry } from './fetch';
import { centroid, cleanPoly, distToPolys, pointInRing, ringBBox, signedArea, type Poly } from './geo';
import type { Feature, Provider, RegionDef } from './providers/types';
import { nycProvider, geomToPolys } from './providers/nyc';
import { osmProvider } from './providers/osm';
import * as shapefile from 'shapefile';
import polygonClipping from 'polygon-clipping';
import { buildPatch, patchOutline, type PatchDef } from './patches';
import { Y } from '../src/core/constants';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'public/data');
const CACHE = join(ROOT, 'data-cache');
const world = JSON.parse(readFileSync(join(ROOT, 'config/world.json'), 'utf8'));
const regionsCfg = JSON.parse(readFileSync(join(ROOT, 'config/regions.json'), 'utf8'));
const proj = new Projection(world.origin);
const TILE: number = world.tileSize;

const PROVIDERS: Record<string, Provider> = { nyc: nycProvider, osm: osmProvider };

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');

// ---------------------------------------------------------------- helpers
function encodeFeatures(feats: Feature[], propTypes: Record<string, string>, header: {
  layer: string; region: string; tile: [number, number] | null; origin: [number, number];
}) {
  const ctor: Record<string, any> = { f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array };
  const addProps = (sections: Record<string, TypedArray>) => {
    for (const [name, t] of Object.entries(propTypes)) {
      const a = new ctor[t](feats.length);
      feats.forEach((f, i) => { a[i] = f.props[name] ?? 0; });
      sections[name] = a;
    }
    return sections;
  };
  if (feats.length && feats[0].point) {
    const coords = new Float32Array(feats.length * 2);
    feats.forEach((f, i) => { coords[i * 2] = f.point![0] - header.origin[0]; coords[i * 2 + 1] = f.point![1] - header.origin[1]; });
    return encodeTile({ ...header, featureCount: feats.length, meta: { geometry: 'point' } }, addProps({ coords }));
  }
  const isLine = !!(feats.length && feats[0].line);
  const rings = (f: Feature) => (isLine ? [f.line!] : f.poly!);
  let ringCount = 0, vertCount = 0;
  for (const f of feats) { ringCount += rings(f).length; for (const r of rings(f)) vertCount += r.length; }
  const featRings = new Uint32Array(feats.length + 1);
  const ringVerts = new Uint32Array(ringCount + 1);
  const coords = new Float32Array(vertCount * 2);
  let ri = 0, vi = 0;
  feats.forEach((f, fi) => {
    featRings[fi] = ri;
    for (const r of rings(f)) {
      ringVerts[ri++] = vi;
      for (const p of r) { coords[vi * 2] = p[0] - header.origin[0]; coords[vi * 2 + 1] = p[1] - header.origin[1]; vi++; }
    }
  });
  featRings[feats.length] = ri; ringVerts[ringCount] = vi;
  return encodeTile({ ...header, featureCount: feats.length, meta: isLine ? { geometry: 'line' } : undefined }, addProps({ featRings, ringVerts, coords }));
}

function readManifest(): Manifest {
  const p = join(OUT, 'manifest.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  return { version: 1, origin: world.origin, tileSize: TILE, regions: [], context: [] };
}
function writeManifest(m: Manifest) {
  m.origin = world.origin; m.tileSize = TILE;
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(m, null, 1));
}

// ---------------------------------------------------------------- boroughs
async function boroughs(): Promise<Record<string, Poly[]>> {
  const raw = await cachedJSON(join(CACHE, 'boroughs.geojson'), refresh, async () => {
    const res = await fetchRetry('https://data.cityofnewyork.us/resource/gthc-hcne.geojson');
    return ((await res.json()) as GeoJSON.FeatureCollection).features;
  });
  const out: Record<string, Poly[]> = {};
  for (const f of raw as GeoJSON.Feature[]) {
    const name = String(f.properties!.boroname);
    out[name] = geomToPolys(f.geometry, proj).map((p) => cleanPoly(p, 0.4, 20)).filter(Boolean) as Poly[];
  }
  return out;
}

// ---------------------------------------------------------------- region build
async function buildRegion(def: RegionDef) {
  console.log(`\n▶ Region ${def.id} (${def.name})`);
  const provider = PROVIDERS[def.provider];
  if (!provider) throw new Error(`Unknown provider ${def.provider}`);
  const lons = def.boundary.map((p) => p[0]), lats = def.boundary.map((p) => p[1]);
  const bbox: [number, number, number, number] = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const boundary = def.boundary.map(([lon, lat]) => proj.forward(lon, lat));
  const boros = def.borough || def.excludeNYC ? await boroughs() : null;
  const allBoroPolys = boros ? Object.values(boros).flat() : [];
  // cache nearest-borough lookups (bbox prefilter keeps this fast)
  const boroBoxes = boros ? Object.entries(boros).map(([n, ps]) => ({ n, ps, bb: ringBBox(ps.flatMap((p) => p[0])) })) : [];
  const nearestBorough = (p: [number, number]) => {
    let best = '', bd = Infinity;
    for (const b of boroBoxes) {
      const dx = Math.max(b.bb[0] - p[0], 0, p[0] - b.bb[2]), dz = Math.max(b.bb[1] - p[1], 0, p[1] - b.bb[3]);
      if (Math.hypot(dx, dz) > bd) continue;
      const d = distToPolys(p, b.ps);
      if (d < bd) { bd = d; best = b.n; }
    }
    return best;
  };

  const regionDir = join(OUT, 'tiles', def.id);
  if (existsSync(regionDir)) rmSync(regionDir, { recursive: true });
  const entry: ManifestRegion = {
    id: def.id, name: def.name, description: def.description, provider: def.provider, builtAt: new Date().toISOString(),
    bounds: [Infinity, Infinity, -Infinity, -Infinity], camera: def.camera, layers: {},
    boundary: boundary.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as [number, number]),
  };

  // terrain patches replace some of this region's layers inside their outline
  const patchCuts: { outline: [number, number][]; layers: string[] }[] = [];
  for (const pd of (regionsCfg.patches ?? []) as PatchDef[]) for (const rep of pd.replaces) {
    if (rep.region !== def.id) continue;
    const ol = patchOutline(OUT, pd.id);
    if (ol) patchCuts.push({ outline: ol, layers: rep.layers });
    else console.warn(`  ! patch ${pd.id} not built yet — run with --patches first`);
  }

  for (const [layer, spec] of Object.entries(provider.layers)) {
    console.log(`  • ${layer}`);
    const feats = await provider.fetchLayer(layer, bbox, proj, refresh, join(CACHE, def.id));
    const tiles = new Map<string, Feature[]>();
    let kept = 0;
    for (const f of feats) {
      const c = f.point ?? (f.line ? f.line[f.line.length >> 1] : centroid(f.poly![0]));
      if (!pointInRing(c, boundary)) continue;
      if (def.borough && nearestBorough(c) !== def.borough) continue;
      if (def.excludeNYC && distToPolys(c, allBoroPolys) === 0) continue;
      if (patchCuts.some((pc) => pc.layers.includes(layer) && pointInRing(c, pc.outline))) continue;
      if (spec.flagOverWater && boros) {
        f.props.overWater = Object.values(boros).some((ps) => distToPolys(c, ps) === 0) ? 0 : 1;
      }
      kept++;
      const key = `${Math.floor(c[0] / TILE)}_${Math.floor(c[1] / TILE)}`;
      (tiles.get(key) ?? tiles.set(key, []).get(key)!).push(f);
      const bb = f.point ? [c[0], c[1], c[0], c[1]] : ringBBox(f.line ?? f.poly![0]);
      entry.bounds[0] = Math.min(entry.bounds[0], bb[0]); entry.bounds[1] = Math.min(entry.bounds[1], bb[1]);
      entry.bounds[2] = Math.max(entry.bounds[2], bb[2]); entry.bounds[3] = Math.max(entry.bounds[3], bb[3]);
    }
    const list: ManifestTile[] = [];
    mkdirSync(join(regionDir, layer), { recursive: true });
    for (const [key, fs] of tiles) {
      const [ix, iz] = key.split('_').map(Number);
      // largest first so the viewer can show big buildings early if it streams progressively
      if (!spec.geometry || spec.geometry === 'polygon') fs.sort((a, b) => Math.abs(signedArea(b.poly![0])) - Math.abs(signedArea(a.poly![0])));
      const buf = encodeFeatures(fs, spec.props, { layer, region: def.id, tile: [ix, iz], origin: [ix * TILE, iz * TILE] });
      const url = `tiles/${def.id}/${layer}/${key}.bin`;
      writeFileSync(join(OUT, url), buf);
      list.push({ ix, iz, url, featureCount: fs.length, bytes: buf.byteLength });
    }
    entry.layers[layer] = list.sort((a, b) => a.iz - b.iz || a.ix - b.ix);
    const kb = list.reduce((s, t) => s + t.bytes, 0) / 1024;
    console.log(`    kept ${kept}/${feats.length} in ${list.length} tiles (${kb.toFixed(0)} KB)`);
  }
  // land mask: the part of the boundary that is the region's own land
  try {
    const bnd = [[...boundary, boundary[0]]] as any;
    let mask: any = null;
    if (boros && def.borough) mask = polygonClipping.intersection(bnd, boros[def.borough] as any); // one multipolygon arg
    else if (boros && def.excludeNYC) mask = polygonClipping.difference(bnd, ...(allBoroPolys as any));
    if (mask) {
      entry.mask = (mask as Poly[]).map((p) => cleanPoly([p[0]], 15, 2000)?.[0]).filter(Boolean)
        .map((r) => r!.map(([x, z]) => [Math.round(x), Math.round(z)] as [number, number]));
    }
  } catch (e) { console.warn('  mask failed', e); }
  const m = readManifest();
  m.regions = m.regions.filter((r) => r.id !== def.id).concat(entry);
  writeManifest(m);
}

// ---------------------------------------------------------------- context land
/** Neighbouring counties (TIGER/Line) drawn as land around NYC; water areas are subtracted. */
const CONTEXT_COUNTIES = ['34017', '34003', '34013', '34039', '34031', '36119', '36059'];

async function readShp(zip: string, url: string): Promise<GeoJSON.Feature[]> {
  if (!existsSync(zip) || refresh) {
    const res = await fetchRetry(url);
    mkdirSync(join(CACHE, 'raw'), { recursive: true });
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const dir = zip.replace(/\.zip$/, '');
  if (!existsSync(dir)) execSync(`unzip -o -q "${zip}" -d "${dir}"`);
  const shp = readdirSync(dir).find((f) => f.endsWith('.shp'))!;
  const fc = await shapefile.read(join(dir, shp), join(dir, shp.replace('.shp', '.dbf')));
  return fc.features as GeoJSON.Feature[];
}

async function buildContext() {
  console.log('\n▶ Context land');
  const feats: Feature[] = [];
  const boros = await boroughs();
  const BORO_CODE: Record<string, number> = { Manhattan: 1, Bronx: 2, Brooklyn: 3, Queens: 4, 'Staten Island': 5 };
  for (const [name, polys] of Object.entries(boros)) for (const poly of polys) feats.push({ poly, props: { kind: BORO_CODE[name] ?? 9 } });
  console.log(`  boroughs: ${feats.length} polygons`);

  const counties = (await readShp(join(CACHE, 'raw/tl_county.zip'), 'https://www2.census.gov/geo/tiger/TIGER2023/COUNTY/tl_2023_us_county.zip'))
    .filter((f) => CONTEXT_COUNTIES.includes(String(f.properties!.GEOID)));
  for (const c of counties) {
    const geoid = String(c.properties!.GEOID);
    const water = (await readShp(join(CACHE, `raw/aw_${geoid}.zip`), `https://www2.census.gov/geo/tiger/TIGER2023/AREAWATER/tl_2023_${geoid}_areawater.zip`))
      .filter((f) => Number(f.properties!.AWATER) > 15000);
    const toPC = (g: GeoJSON.Geometry) => geomToPolys(g, proj) as any;
    let land: any = toPC(c.geometry);
    const waterPolys = water.flatMap((w) => toPC(w.geometry));
    if (waterPolys.length) land = polygonClipping.difference(land, ...waterPolys);
    let n = 0;
    for (const p of land as Poly[]) {
      // polygon-clipping returns closed rings
      const clean = cleanPoly(p, 1.5, 200);
      if (clean) { feats.push({ poly: clean, props: { kind: 10 } }); n++; }
    }
    console.log(`  ${c.properties!.NAME} County (${geoid}): ${n} land polygons, ${waterPolys.length} water bodies removed`);
  }
  mkdirSync(join(OUT, 'context'), { recursive: true });
  const buf = encodeFeatures(feats, { kind: 'u8' }, { layer: 'land', region: 'context', tile: null, origin: [0, 0] });
  writeFileSync(join(OUT, 'context/land.bin'), buf);
  console.log(`  wrote context/land.bin (${(buf.byteLength / 1024).toFixed(0)} KB)`);
  const m = readManifest();
  m.context = m.context.filter((c) => c.id !== 'land').concat({ id: 'land', layer: 'land', url: 'context/land.bin', bytes: buf.byteLength });
  writeManifest(m);
}

// ---------------------------------------------------------------- main
(async () => {
  mkdirSync(OUT, { recursive: true });
  const all: RegionDef[] = regionsCfg.regions;
  const ids = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--context')) await buildContext();
  if (args.includes('--patches')) {
    const m = readManifest();
    m.patches = [];
    for (const pd of (regionsCfg.patches ?? []) as PatchDef[]) {
      const meta = await buildPatch(pd, proj, join(CACHE, 'patch-' + pd.id), OUT, refresh, Y.sidewalks);
      m.patches.push({ id: meta.id, name: meta.name, url: `patches/${meta.id}.json` });
    }
    writeManifest(m);
  }
  const todo = args.includes('--all') ? all : all.filter((r) => ids.includes(r.id));
  for (const id of ids) if (!all.find((r) => r.id === id)) throw new Error(`No region "${id}" in config/regions.json`);
  for (const r of todo) await buildRegion(r);
  if (!todo.length && !args.includes('--context') && !args.includes('--patches')) console.log('Nothing to do. Usage: npm run data -- <region-id> | --all | --context [--refresh]');
})().catch((e) => { console.error(e); process.exit(1); });
