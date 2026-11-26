/** Planar geometry helpers operating in scene metres ([x, z] pairs). */
export type Pt = [number, number];
export type Ring = Pt[];
/** A polygon: rings[0] outer, rest holes. */
export type Poly = Ring[];

/** Signed area in the (x, north) plane; > 0 means CCW seen from above. */
export function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    // north = -z
    a += r[j][0] * -r[i][1] - r[i][0] * -r[j][1];
  }
  return a / 2;
}

export function ringBBox(r: Ring): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of r) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1]; if (p[0] > c) c = p[0]; if (p[1] > d) d = p[1]; }
  return [a, b, c, d];
}

/** Area-weighted centroid of the outer ring (falls back to vertex mean). */
export function centroid(r: Ring): Pt {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f; cx += (r[j][0] + r[i][0]) * f; cz += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0; for (const p of r) { sx += p[0]; sz += p[1]; }
    return [sx / r.length, sz / r.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(p: Pt, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(p: Pt, poly: Poly): boolean {
  if (!pointInRing(p, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(p, poly[i])) return false;
  return true;
}

function segDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - p[0], ez = a[1] + t * dz - p[1];
  return ex * ex + ez * ez;
}

/** Distance from point to polygon set (0 if inside). */
export function distToPolys(p: Pt, polys: Poly[]): number {
  let best = Infinity;
  for (const poly of polys) {
    if (pointInPoly(p, poly)) return 0;
    for (const r of poly) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const d = segDist2(p, r[j], r[i]); if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** Douglas–Peucker on a closed ring; also removes duplicate points. */
export function simplifyRing(r: Ring, tol: number): Ring {
  const pts: Ring = [];
  for (const p of r) {
    const q = pts[pts.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-3 || Math.abs(q[1] - p[1]) > 1e-3) pts.push(p);
  }
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3) pts.pop();
  }
  if (pts.length < 4 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  const t2 = tol * tol;
  // split the ring at its two farthest-apart-ish points (0 and the farthest from 0)
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const stack: [number, number][] = [[0, far], [far, pts.length]];
  keep[0] = keep[far] = 1;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const pe = pts[e % pts.length];
    let idx = -1, md = t2;
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(pts[i], pts[s], pe);
      if (d > md) { md = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Normalise: drop degenerate rings, outer CCW, holes CW. Returns null if outer degenerate. */
export function cleanPoly(poly: Poly, tol: number, minArea = 0.5): Poly | null {
  const out: Poly = [];
  for (let i = 0; i < poly.length; i++) {
    const r = simplifyRing(poly[i], tol);
    if (r.length < 3) { if (i === 0) return null; continue; }
    const a = signedArea(r);
    if (Math.abs(a) < minArea) { if (i === 0) return null; continue; }
    if ((i === 0 && a < 0) || (i > 0 && a > 0)) r.reverse();
    out.push(r);
  }
  return out;
}
