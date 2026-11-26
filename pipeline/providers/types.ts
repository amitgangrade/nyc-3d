import type { Projection } from '../../src/core/projection';
import type { Poly, Pt } from '../geo';

/** A cleaned polygon (or point) feature in scene metres with numeric attributes. */
export interface Feature { poly?: Poly; point?: Pt; props: Record<string, number> }

export interface LayerSpec {
  /** attribute name -> storage type in the tile */
  props: Record<string, 'f32' | 'u32' | 'u16' | 'u8'>;
  /** simplification tolerance in metres */
  tolerance: number;
  /** set prop `overWater`=1 on features whose centroid is not on borough land (bridge decks) */
  flagOverWater?: boolean;
  /** geometry kind stored in tiles (default polygon) */
  geometry?: 'polygon' | 'point';
}

export interface RegionDef {
  id: string; name: string; description?: string; provider: string;
  borough?: string; boundary: [number, number][];
  camera?: { lon: number; lat: number; distance: number; heading: number; pitch: number };
}

/**
 * A provider knows how to obtain the standard layers for some jurisdiction.
 * To add e.g. Jersey City, write a provider (OSM / NJGIN / Hudson County GIS)
 * that returns the same layer names + props, and reference it from regions.json.
 */
export interface Provider {
  id: string;
  layers: Record<string, LayerSpec>;
  fetchLayer(layer: string, bbox: [number, number, number, number], proj: Projection, refresh: boolean, cacheDir: string): Promise<Feature[]>;
}
