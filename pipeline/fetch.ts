import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with retries + exponential backoff (NYC Open Data is occasionally flaky). */
export async function fetchRetry(url: string, tries = 7, init?: RequestInit): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) { last = e; }
    const wait = 1500 * 2 ** i;
    console.warn(`  retry ${i + 1}/${tries} in ${wait / 1000}s: ${(last as Error).message ?? last}`);
    await sleep(wait);
  }
  throw last;
}

/** Read JSON from cache or produce it with `make` and cache it. */
export async function cachedJSON<T>(path: string, refresh: boolean, make: () => Promise<T>): Promise<T> {
  if (!refresh && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const v = await make();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v));
  return v;
}

/**
 * Download every GeoJSON feature of a Socrata dataset intersecting a lon/lat bbox.
 */
export async function socrataGeoJSON(
  domain: string, dataset: string, bbox: [number, number, number, number], extraWhere?: string, geoColumn = 'the_geom',
): Promise<GeoJSON.Feature[]> {
  const [w, s, e, n] = bbox;
  const poly = `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
  let where = `intersects(${geoColumn},'${poly}')`;
  if (extraWhere) where += ` AND (${extraWhere})`;
  const out: GeoJSON.Feature[] = [];
  const page = 20000;
  for (let offset = 0; ; offset += page) {
    const q = new URLSearchParams({ $where: where, $limit: String(page), $offset: String(offset), $order: ':id' });
    const res = await fetchRetry(`https://${domain}/resource/${dataset}.geojson?${q}`);
    const fc = (await res.json()) as GeoJSON.FeatureCollection;
    out.push(...fc.features);
    process.stdout.write(`    ${dataset}: ${out.length} features\r`);
    if (fc.features.length < page) break;
  }
  process.stdout.write('\n');
  return out;
}
