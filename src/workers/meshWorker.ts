/// <reference lib="webworker" />
/**
 * Off-main-thread geometry builder: NY3D tile bytes -> GPU-ready typed arrays.
 * One handler per layer "kind" (see src/render/layers.ts).
 */
import earcut from 'earcut';
import { decodeTile, type DecodedTile } from '../core/tileFormat';
import { STYLE, Y } from '../core/constants';

export interface BuildRequest {
  id: number;
  url: string;
  kind: 'buildings' | 'flat' | 'raised' | 'land' | 'trees';
  y?: number;
  /** curb / skirt depth for 'flat' layers (0 = none) */
  skirt?: number;
  /** scene-space points; buildings whose footprint contains one are skipped (replaced by a custom landmark model) */
  exclude?: [number, number][];
  /** terrain patch relief grid: buildings standing inside it are lifted onto the terrain */
  terrain?: TerrainGrid;
  /** buildings whose centroid lies within r of (x,z) get a special lighting code (see materials.ts) */
  specials?: { x: number; z: number; r: number; code: number }[];
  /** emit streetlight positions along polygon outlines (roads) */
  lights?: boolean;
  /** scatter procedural trees inside polygons with this mean spacing (metres) */
  scatterTrees?: number;
}

/** Tree instances, 7 floats each: x, z, crownRadius, height, class, seed, groundY (tile-local x,z). */
export const TREE_STRIDE = 7;

export interface TerrainGrid {
  origin: [number, number]; axisU: [number, number]; axisV: [number, number];
  cell: number; nu: number; nv: number; scale: number; heights: Int16Array;
}

/** Bilinear relief (metres) at a scene point; 0 outside the grid. */
export function sampleTerrain(t: TerrainGrid, x: number, z: number): number {
  const dx = x - t.origin[0], dz = z - t.origin[1];
  const u = (dx * t.axisU[0] + dz * t.axisU[1]) / t.cell, v = (dx * t.axisV[0] + dz * t.axisV[1]) / t.cell;
  if (u < 0 || v < 0 || u >= t.nu - 1 || v >= t.nv - 1) return 0;
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, H = t.heights, n = t.nu;
  const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
  return ((a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv) * t.scale;
}

export interface GeometryArrays {
  position: Float32Array;
  normal: Float32Array;
  uv?: Float32Array;
  info?: Float32Array;
  index: Uint32Array;
}

export interface BuildResult {
  id: number;
  geometry: GeometryArrays | null;
  /** per-feature attributes for picking (buildings) */
  features?: { height: Float32Array; year: Uint16Array; bin: Uint32Array; centroid: Float32Array; osmType?: Uint8Array };
  lights?: Float32Array;
  trees?: Float32Array;
  origin: [number, number];
  error?: string;
}

// --------------------------------------------------------------- utilities
class Buf {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; info: number[] = []; idx: number[] = [];
  get count() { return this.pos.length / 3; }
}

function hash(n: number) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function ringsOf(t: DecodedTile, f: number) {
  const fr = t.sections.featRings, rv = t.sections.ringVerts, c = t.sections.coords as Float32Array;
  const rings: Float32Array[] = [];
  for (let r = fr[f]; r < fr[f + 1]; r++) rings.push(c.subarray(rv[r] * 2, rv[r + 1] * 2));
  return rings;
}

function pointInRing(x: number, z: number, r: Float32Array) {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Triangulate a polygon (rings in tile-local x,z) at height y, facing up. */
function cap(b: Buf, rings: Float32Array[], y: number, info: number[] | null, uvScale = 1) {
  const flat: number[] = []; const holes: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    if (i) holes.push(flat.length / 2);
    for (let k = 0; k < rings[i].length; k++) flat.push(rings[i][k]);
  }
  const tri = earcut(flat, holes, 2);
  const base = b.count;
  for (let i = 0; i < flat.length; i += 2) {
    b.pos.push(flat[i], y, flat[i + 1]); b.nor.push(0, 1, 0);
    b.uv.push(flat[i] * uvScale, flat[i + 1] * uvScale);
    if (info) b.info.push(info[0], info[1], info[2], info[3]);
  }
  // make every triangle front-facing when seen from +y
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i] * 2, c = tri[i + 1] * 2, d = tri[i + 2] * 2;
    const ux = flat[c] - flat[a], uz = flat[c + 1] - flat[a + 1], vx = flat[d] - flat[a], vz = flat[d + 1] - flat[a + 1];
    if (uz * vx - ux * vz > 0) b.idx.push(base + tri[i], base + tri[i + 1], base + tri[i + 2]);
    else b.idx.push(base + tri[i], base + tri[i + 2], base + tri[i + 1]);
  }
}

/** Downward-facing cap (underside of a raised building:part). */
function capDown(b: Buf, rings: Float32Array[], y: number, info: number[] | null) {
  const start = b.idx.length, v0 = b.count;
  cap(b, rings, y, info);
  for (let i = v0 * 3 + 1; i < b.nor.length; i += 3) b.nor[i] = -1;
  for (let i = start; i < b.idx.length; i += 3) { const t = b.idx[i + 1]; b.idx[i + 1] = b.idx[i + 2]; b.idx[i + 2] = t; }
}

/**
 * Vertical walls along every ring from y0 to y1. Outer rings are CCW (seen from
 * above), so the outward normal of edge (dx,dz) is (-dz, dx). Adjacent edges
 * bending < ~28° share a smoothed normal so curved facades shade smoothly.
 * uv = (distance along facade, height above y0).
 */
function walls(b: Buf, rings: Float32Array[], y0: number, y1: number, info: number[] | null, v0 = 0) {
  for (const r of rings) {
    const n = r.length / 2;
    if (n < 3) continue;
    const en: number[] = []; // edge normals
    const len: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = r[j * 2] - r[i * 2], dz = r[j * 2 + 1] - r[i * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      en.push(-dz / l, dx / l); len.push(l);
    }
    const SMOOTH = Math.cos((28 * Math.PI) / 180);
    let u = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = (i - 1 + n) % n, q = (j) % n;
      // normal at start vertex (i) and end vertex (j) of edge i
      let nx0 = en[i * 2], nz0 = en[i * 2 + 1], nx1 = nx0, nz1 = nz0;
      if (en[p * 2] * nx0 + en[p * 2 + 1] * nz0 > SMOOTH) {
        const ax = en[p * 2] + nx0, az = en[p * 2 + 1] + nz0, l = Math.hypot(ax, az); nx0 = ax / l; nz0 = az / l;
      }
      if (en[q * 2] * nx1 + en[q * 2 + 1] * nz1 > SMOOTH) {
        const ax = en[q * 2] + nx1, az = en[q * 2 + 1] + nz1, l = Math.hypot(ax, az); nx1 = ax / l; nz1 = az / l;
      }
      const x0 = r[i * 2], z0 = r[i * 2 + 1], x1 = r[j * 2], z1 = r[j * 2 + 1];
      const base = b.count;
      const h = y1 - y0;
      b.pos.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0);
      b.nor.push(nx0, 0, nz0, nx1, 0, nz1, nx1, 0, nz1, nx0, 0, nz0);
      b.uv.push(u, v0, u + len[i], v0, u + len[i], v0 + h, u, v0 + h);
      if (info) for (let k = 0; k < 4; k++) b.info.push(info[0], info[1], info[2], info[3]);
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      u += len[i];
    }
  }
}

function finish(b: Buf, withInfo: boolean): GeometryArrays | null {
  if (!b.idx.length) return null;
  const g: GeometryArrays = {
    position: new Float32Array(b.pos), normal: new Float32Array(b.nor), uv: new Float32Array(b.uv), index: new Uint32Array(b.idx),
  };
  if (withInfo) g.info = new Float32Array(b.info);
  return g;
}

// --------------------------------------------------------------- facade style
function pickStyle(height: number, year: number, kind: number, seed: number): number {
  if (kind === 3) return STYLE.PLAIN; // canopies, tanks…
  if (kind === 2) return seed < 0.6 ? STYLE.PLAIN : STYLE.CONCRETE; // garages
  const y = year || (height > 150 ? 1990 : height > 70 ? 1960 : 1915);
  if (y < 1935) {
    if (height > 70) return seed < 0.75 ? STYLE.STONE : STYLE.BRICK;
    return seed < 0.68 ? STYLE.BRICK : STYLE.STONE;
  }
  if (y < 1950) return seed < 0.5 ? STYLE.BRICK : STYLE.STONE;
  if (y < 1985) {
    if (height > 90) return seed < 0.55 ? STYLE.GLASS : STYLE.CONCRETE;
    return seed < 0.45 ? STYLE.BRICK : STYLE.CONCRETE;
  }
  if (height > 45) return seed < 0.72 ? STYLE.GLASS : STYLE.CONCRETE;
  return seed < 0.35 ? STYLE.GLASS : seed < 0.7 ? STYLE.CONCRETE : STYLE.BRICK;
}

// --------------------------------------------------------------- builders
function buildBuildings(t: DecodedTile, req: BuildRequest): BuildResult {
  const b = new Buf();
  const n = t.header.featureCount;
  const H = t.sections.height as Float32Array, YR = t.sections.year as Uint16Array;
  const BIN = t.sections.bin as Uint32Array, KIND = t.sections.kind as Uint8Array;
  const MINH = t.sections.minHeight as Float32Array | undefined;
  const [ox, oz] = t.header.origin;
  const centroid = new Float32Array(n * 2);
  const ex = (req.exclude ?? []).map(([x, z]) => [x - ox, z - oz]);
  for (let f = 0; f < n; f++) {
    const rings = ringsOf(t, f);
    const outer = rings[0];
    let cx = 0, cz = 0;
    for (let k = 0; k < outer.length; k += 2) { cx += outer[k]; cz += outer[k + 1]; }
    cx /= outer.length / 2; cz /= outer.length / 2;
    centroid[f * 2] = cx + ox; centroid[f * 2 + 1] = cz + oz;
    if (ex.some(([x, z]) => pointInRing(x, z, outer) || Math.hypot(cx - x, cz - z) < 40)) continue;
    const h = Math.max(1.5, H[f]);
    const seed = hash((BIN[f] || f * 7919 + ox) | 0);
    let style = pickStyle(h, YR[f], KIND[f], seed);
    for (const sp of req.specials ?? []) {
      if (Math.hypot(cx + ox - sp.x, cz + oz - sp.z) < sp.r) {
        if (sp.code !== 7) style = STYLE.STONE; // landmark towers: masonry facades
        style += sp.code * 10;
        break;
      }
    }
    // info: (height, seed, style, featureIndex)
    const info = [h, seed, style, f];
    const minH = MINH ? Math.min(MINH[f], h - 0.5) : 0;
    let lift = 0;
    if (req.terrain) {
      // stand at the terrain height under the footprint centre, sunk 1 m so slopes don't leave gaps
      lift = sampleTerrain(req.terrain, cx + ox, cz + oz);
      if (lift !== 0) lift += Y.sidewalks - Y.buildingBase - 1.0;
    }
    const y0 = Y.buildingBase + lift + minH, y1 = Y.buildingBase + lift + h;
    walls(b, rings, y0, y1, info, minH);
    cap(b, rings, y1, info);
    if (minH > 0.5) capDown(b, rings, y0, info);
  }
  return {
    id: req.id, geometry: finish(b, true), origin: t.header.origin,
    features: { height: H.slice(), year: YR.slice(), bin: BIN.slice(), centroid, osmType: (t.sections.osmType as Uint8Array | undefined)?.slice() },
  };
}

/**
 * Polyline layers (OSM roads/paths): flat ribbons of the feature's width with
 * round-ish joins; bridges (elev > 0) are lifted with side skirts.
 */
function buildLines(t: DecodedTile, req: BuildRequest): BuildResult {
  const b = new Buf();
  const W = t.sections.width as Float32Array, E = t.sections.elev as Float32Array | undefined, LIT = t.sections.lit as Uint8Array | undefined;
  const baseY = req.y ?? 1;
  const lightPts: number[] = [];
  const quad = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, y: number) => {
    const o = b.count;
    b.pos.push(ax, y, az, bx, y, bz, cx, y, cz, dx, y, dz);
    b.nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    b.uv.push(ax, az, bx, bz, cx, cz, dx, dz);
    b.idx.push(o, o + 1, o + 2, o, o + 2, o + 3); // faces +y
  };
  for (let f = 0; f < t.header.featureCount; f++) {
    const line = ringsOf(t, f)[0];
    const n = line.length / 2;
    const hw = W[f] / 2;
    const elev = E ? E[f] : 0;
    const y = baseY + elev;
    for (let i = 0; i < n - 1; i++) {
      const x0 = line[i * 2], z0 = line[i * 2 + 1], x1 = line[i * 2 + 2], z1 = line[i * 2 + 3];
      const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
      if (l < 1e-3) continue;
      const nx = (-dz / l) * hw, nz = (dx / l) * hw;
      quad(x0 + nx, z0 + nz, x1 + nx, z1 + nz, x1 - nx, z1 - nz, x0 - nx, z0 - nz, y);
      if (elev > 0) {
        // deck edges
        for (const sgn of [1, -1]) {
          const o = b.count, ex = nx * sgn, ez = nz * sgn;
          b.pos.push(x0 + ex, y, z0 + ez, x1 + ex, y, z1 + ez, x1 + ex, y - 1.6, z1 + ez, x0 + ex, y - 1.6, z0 + ez);
          const nn = [ex / hw, 0, ez / hw];
          for (let k = 0; k < 4; k++) b.nor.push(...nn);
          b.uv.push(0, 0, 0, 0, 0, 0, 0, 0);
          if (sgn > 0) b.idx.push(o, o + 1, o + 2, o, o + 2, o + 3); else b.idx.push(o, o + 2, o + 1, o, o + 3, o + 2);
        }
      }
      if (req.lights && LIT?.[f] && hw > 2.5) {
        for (let s = 15; s < l; s += 32) for (const sgn of [1, -1]) {
          const k = 1 + 1.6 / hw;
          lightPts.push(x0 + (dx * s) / l + nx * k * sgn, z0 + (dz * s) / l + nz * k * sgn);
        }
      }
    }
    // joints: small polygon disc at interior vertices
    for (let i = 1; i < n - 1; i++) {
      const cx = line[i * 2], cz = line[i * 2 + 1], o = b.count, SEG = 8;
      b.pos.push(cx, y, cz); b.nor.push(0, 1, 0); b.uv.push(cx, cz);
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        b.pos.push(cx + Math.cos(a) * hw, y, cz + Math.sin(a) * hw); b.nor.push(0, 1, 0); b.uv.push(cx, cz);
      }
      for (let k = 0; k < SEG; k++) b.idx.push(o, o + 1 + ((k + 1) % SEG), o + 1 + k);
    }
  }
  const res: BuildResult = { id: req.id, geometry: finish(b, false), origin: t.header.origin };
  if (req.lights) res.lights = thin(lightPts, 14);
  return res;
}

function buildFlat(t: DecodedTile, req: BuildRequest): BuildResult {
  if ((t.header.meta as { geometry?: string } | undefined)?.geometry === 'line') return buildLines(t, req);
  const b = new Buf();
  const y = req.y ?? 1;
  const skirt = req.skirt ?? 0;
  const elev = t.sections.elevation as Float32Array | undefined;
  const overWater = t.sections.overWater as Uint8Array | undefined;
  const raised = req.kind === 'raised';
  const lightPts: number[] = [];
  const treeOut: number[] = [];
  for (let f = 0; f < t.header.featureCount; f++) {
    if (overWater?.[f]) continue; // bridge roadways are modelled as landmarks, not flat on the water
    const rings = ringsOf(t, f);
    if (req.scatterTrees) scatter(rings, req.scatterTrees, t.header.origin, treeOut);
    const top = raised && elev ? Y.land + elev[f] * 0.5 : y;
    cap(b, rings, top, null, 1);
    if (skirt > 0 || raised) walls(b, rings, raised ? -2 : top - skirt, top, null);
    if (req.lights) placeLights(rings, lightPts);
  }
  const res: BuildResult = { id: req.id, geometry: finish(b, false), origin: t.header.origin };
  if (req.lights) res.lights = thin(lightPts, 14);
  if (treeOut.length) res.trees = new Float32Array(treeOut);
  return res;
}

/** Jittered-grid scatter of park trees, clumped with low-frequency noise, kept off polygon edges. */
function scatter(rings: Float32Array[], spacing: number, origin: [number, number], out: number[]) {
  const outer = rings[0];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < outer.length; k += 2) { x0 = Math.min(x0, outer[k]); x1 = Math.max(x1, outer[k]); z0 = Math.min(z0, outer[k + 1]); z1 = Math.max(z1, outer[k + 1]); }
  if ((x1 - x0) * (z1 - z0) < 300) return;
  for (let gx = Math.floor(x0 / spacing); gx * spacing < x1; gx++) {
    for (let gz = Math.floor(z0 / spacing); gz * spacing < z1; gz++) {
      const wx = gx + Math.floor(origin[0] / spacing), wz = gz + Math.floor(origin[1] / spacing);
      const h1 = hash(wx * 73856093 ^ wz * 19349663), h2 = hash(wx * 83492791 ^ wz * 2971215073), h3 = hash(wx * 2654435761 ^ wz * 40503);
      // clumps: keep ~60% of cells, using a coarse cell hash as noise
      const clump = hash(Math.floor(wx / 5) * 15485863 ^ Math.floor(wz / 5) * 32452843);
      if (h3 > 0.25 + clump * 0.65) continue;
      const x = (gx + 0.15 + h1 * 0.7) * spacing, z = (gz + 0.15 + h2 * 0.7) * spacing;
      if (!pointInRing(x, z, outer)) continue;
      let inHole = false;
      for (let r = 1; r < rings.length && !inHole; r++) inHole = pointInRing(x, z, rings[r]);
      if (inHole || distToRing(x, z, outer) < 3) continue;
      const dbh = 8 + h1 * h2 * 30;
      out.push(x, z, crownRadius(dbh), treeHeight(dbh), h3 < 0.1 ? 2 : 0, h2, Y.sidewalks);
    }
  }
}

function distToRing(x: number, z: number, r: Float32Array) {
  let best = Infinity;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = r[j * 2], az = r[j * 2 + 1], bx = r[i * 2], bz = r[i * 2 + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - x, az + t * dz - z));
  }
  return best;
}

const crownRadius = (dbh: number) => Math.min(9, 1.4 + dbh * 0.16);
const treeHeight = (dbh: number) => Math.min(24, 4.5 + dbh * 0.42);

function buildTrees(t: DecodedTile, req: BuildRequest): BuildResult {
  const n = t.header.featureCount;
  const c = t.sections.coords as Float32Array, dbh = t.sections.dbh as Uint8Array, cls = t.sections.cls as Uint8Array;
  const out = new Float32Array(n * TREE_STRIDE);
  for (let i = 0; i < n; i++) {
    const d = dbh[i] || 8;
    out.set([c[i * 2], c[i * 2 + 1], crownRadius(d), treeHeight(d), cls[i], hash(i * 2654435761 + (t.header.origin[0] | 0)), Y.sidewalks], i * TREE_STRIDE);
  }
  return { id: req.id, geometry: null, trees: out, origin: t.header.origin };
}

/** Street lights every ~30 m along the curb, 1.6 m out onto the sidewalk. */
function placeLights(rings: Float32Array[], out: number[]) {
  const SPACING = 30, OFF = 1.6;
  for (const r of rings) {
    const n = r.length / 2;
    let carry = SPACING * 0.5;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = r[i * 2], z0 = r[i * 2 + 1], dx = r[j * 2] - x0, dz = r[j * 2 + 1] - z0;
      const l = Math.hypot(dx, dz);
      if (l < 1e-3) continue;
      const nx = -dz / l, nz = dx / l;
      let s = carry;
      while (s < l) { out.push(x0 + (dx * s) / l + nx * OFF, z0 + (dz * s) / l + nz * OFF); s += SPACING; }
      carry = s - l;
    }
  }
}

/** Remove points closer than `d` to an already kept point (grid hash). */
function thin(pts: number[], d: number): Float32Array {
  const grid = new Map<string, number[]>();
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], z = pts[i + 1];
    const gx = Math.floor(x / d), gz = Math.floor(z / d);
    let ok = true;
    for (let a = -1; a <= 1 && ok; a++) for (let c = -1; c <= 1 && ok; c++) {
      const cell = grid.get(`${gx + a},${gz + c}`);
      if (cell) for (let k = 0; k < cell.length; k += 2) if ((cell[k] - x) ** 2 + (cell[k + 1] - z) ** 2 < d * d) { ok = false; break; }
    }
    if (!ok) continue;
    out.push(x, z);
    const key = `${gx},${gz}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(x, z);
  }
  return new Float32Array(out);
}

function buildLand(t: DecodedTile, req: BuildRequest): BuildResult {
  const b = new Buf();
  const kind = t.sections.kind as Uint8Array;
  for (let f = 0; f < t.header.featureCount; f++) {
    const rings = ringsOf(t, f);
    const info = [kind[f], 0, 0, f];
    cap(b, rings, Y.land, info);
    walls(b, rings, -6, Y.land, info);
  }
  return { id: req.id, geometry: finish(b, true), origin: t.header.origin };
}

// --------------------------------------------------------------- dispatch
self.onmessage = async (e: MessageEvent<BuildRequest>) => {
  const req = e.data;
  try {
    // static hosts (GitHub Pages) occasionally answer 5xx under bursts: retry with backoff
    let res: Response | null = null;
    for (let i = 0; i < 5; i++) {
      try { res = await fetch(req.url); } catch { res = null; }
      if (res && (res.ok || res.status < 500)) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? 'network error'} for ${req.url}`);
    const tile = decodeTile(await res.arrayBuffer());
    const out = req.kind === 'buildings' ? buildBuildings(tile, req)
      : req.kind === 'land' ? buildLand(tile, req)
      : req.kind === 'trees' ? buildTrees(tile, req) : buildFlat(tile, req);
    const transfer: Transferable[] = [];
    if (out.geometry) for (const a of Object.values(out.geometry)) if (a) transfer.push((a as Float32Array).buffer);
    if (out.lights) transfer.push(out.lights.buffer);
    if (out.trees) transfer.push(out.trees.buffer);
    (self as unknown as Worker).postMessage(out, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: req.id, geometry: null, origin: [0, 0], error: String(err) } as BuildResult);
  }
};
