/**
 * NYC Open Data provider (data.cityofnewyork.us).
 *   buildings  – Building Footprints (roof heights, construction year, BIN)
 *   roads      – Planimetric roadbed
 *   sidewalks  – Planimetric sidewalks
 *   parks      – Planimetric open space (parks)
 *   plazas     – Planimetric open space (other: plazas, malls, cemeteries…)
 *   piers      – Planimetric hydrography structures (piers, bulkheads)
 *   water      – Planimetric hydrography (inland water, fountains, memorial pools)
 *   trees      – Forestry Tree Points (street trees, trunk diameter, genus)
 */
import type { Projection } from '../../src/core/projection';
import { cachedJSON, socrataGeoJSON } from '../fetch';
import { cleanPoly, type Poly } from '../geo';
import type { Feature, LayerSpec, Provider } from './types';

const DOMAIN = 'data.cityofnewyork.us';
const FT = 0.3048;

interface Src {
  dataset: string; where?: string; geoColumn?: string;
  props: (p: Record<string, any>) => Record<string, number> | null;
}

/** footprint feature codes → building kind (see layer docs in README) */
const KIND: Record<string, number> = { '2100': 0, '5100': 1, '5110': 2, '1001': 3, '1003': 3, '1004': 3, '1005': 3, '1006': 3 };

const SOURCES: Record<string, Src> = {
  buildings: {
    dataset: '5zhs-2jue',
    where: "feature_code in ('2100','5100','5110','1001','1003','1004','1005','1006')",
    props: (p) => {
      let h = parseFloat(p.height_roof) * FT;
      if (!isFinite(h) || h <= 0) h = 9;
      const year = parseInt(p.construction_year) || 0;
      return { height: h, year: year > 1600 && year < 2100 ? year : 0, bin: parseInt(p.bin) || 0, kind: KIND[p.feature_code] ?? 0 };
    },
  },
  roads: { dataset: 'i36f-5ih7', props: () => ({}) },
  sidewalks: { dataset: '52n9-sdep', props: () => ({}) },
  parks: { dataset: 'y6ja-fw4f', props: () => ({}) },
  plazas: { dataset: 'b7j8-z8a7', props: () => ({}) },
  piers: {
    dataset: '6hbv-tek4',
    props: (p) => ({ elevation: Math.max(0.6, Math.min(4, (parseFloat(p.elevation) || 5) * FT)) }),
  },
  water: { dataset: 'pjs3-c3z5', props: () => ({}) },
  trees: {
    dataset: 'hn5i-inap', geoColumn: 'location', where: "tpstructure='Full'",
    props: (p) => {
      const dbh = Math.min(60, Math.max(2, parseFloat(p.dbh) || 8));
      const g = String(p.genusspecies || '').toLowerCase();
      // rough crown shape/colour class: 0 broadleaf, 1 locust/airy, 2 conifer, 3 flowering/small
      const cls = /pinus|picea|abies|thuja|juniper|taxus|tsuga/.test(g) ? 2
        : /gleditsia|robinia|sophora|styphnolobium|ginkgo/.test(g) ? 1
        : /pyrus|prunus|malus|cercis|cornus|magnolia|amelanchier/.test(g) ? 3 : 0;
      return { dbh, cls };
    },
  },
};

const LAYERS: Record<string, LayerSpec> = {
  buildings: { props: { height: 'f32', year: 'u16', bin: 'u32', kind: 'u8' }, tolerance: 0.08 },
  roads: { props: { overWater: 'u8' }, tolerance: 0.15, flagOverWater: true },
  sidewalks: { props: { overWater: 'u8' }, tolerance: 0.15, flagOverWater: true },
  parks: { props: {}, tolerance: 0.2 },
  plazas: { props: {}, tolerance: 0.2 },
  piers: { props: { elevation: 'f32' }, tolerance: 0.15 },
  water: { props: {}, tolerance: 0.15 },
  trees: { props: { dbh: 'u8', cls: 'u8' }, tolerance: 0, geometry: 'point' },
};

export function geomToPolys(g: GeoJSON.Geometry, proj: Projection): Poly[] {
  const conv = (rings: number[][][]): Poly => rings.map((r) => r.map(([lon, lat]) => proj.forward(lon, lat)));
  if (g.type === 'Polygon') return [conv(g.coordinates)];
  if (g.type === 'MultiPolygon') return g.coordinates.map(conv);
  return [];
}

export const nycProvider: Provider = {
  id: 'nyc',
  layers: LAYERS,
  async fetchLayer(layer, bbox, proj, refresh, cacheDir) {
    const src = SOURCES[layer];
    if (!src) throw new Error(`nyc provider has no layer ${layer}`);
    const raw = await cachedJSON(`${cacheDir}/${layer}.geojson`, refresh, () =>
      socrataGeoJSON(DOMAIN, src.dataset, bbox, src.where, src.geoColumn));
    const out: Feature[] = [];
    for (const f of raw) {
      if (!f.geometry) continue;
      const props = src.props(f.properties ?? {});
      if (!props) continue;
      if (f.geometry.type === 'Point') {
        const [lon, lat] = f.geometry.coordinates;
        out.push({ point: proj.forward(lon, lat), props });
        continue;
      }
      for (const poly of geomToPolys(f.geometry, proj)) {
        const clean = cleanPoly(poly, LAYERS[layer].tolerance);
        if (clean) out.push({ poly: clean, props });
      }
    }
    return out;
  },
};
