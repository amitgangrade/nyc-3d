import type { Projection } from '../../src/core/projection';
import type { Poly, Pt } from '../geo';

/** A cleaned polygon, polyline or point feature in scene metres with numeric attributes. */
export interface Feature { poly?: Poly; line?: Pt[]; point?: Pt; props: Record<string, number> }

export interface LayerSpec {
  /** attribute name -> storage type in the tile */
  props: Record<string, 'f32' | 'u32' | 'u16' | 'u8'>;
  /** simplification tolerance in metres */
  tolerance: number;
  /** set prop `overWater`=1 on features whose centroid is not on borough land (bridge decks) */
  flagOverWater?: boolean;
  /** geometry kind stored in tiles (default polygon) */
  geometry?: 'polygon' | 'line' | 'point';
}

export interface RegionDef {
  id: string; name: string; description?: string; provider: string;
  borough?: string; boundary: [number, number][];
  /** drop features lying on NYC borough land (for providers whose data overlaps NYC, e.g. OSM in NJ) */
  excludeNYC?: boolean;
  camera?: { lon: number; lat: number; distance: number; heading: number; pitch: number };
}

/**
 * A provider knows how to obtain the standard layers for some jurisdiction.
 * Providers: nyc.ts (NYC Open Data), osm.ts (OpenStreetMap via Overpass, used
 * for New Jersey). Reference one from a region in config/regions.json.
 */
export interface Provider {
  id: string;
  layers: Record<string, LayerSpec>;
  fetchLayer(layer: string, bbox: [number, number, number, number], proj: Projection, refresh: boolean, cacheDir: string): Promise<Feature[]>;
}
