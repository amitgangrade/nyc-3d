/** Shape of public/data/manifest.json, written by the pipeline, read by the viewer. */
export interface ManifestTile {
  /** tile grid index */
  ix: number; iz: number;
  /** path relative to the data root */
  url: string;
  featureCount: number;
  bytes: number;
}

export interface ManifestRegion {
  id: string;
  name: string;
  description?: string;
  builtAt: string;
  /** scene-space bounds [minX, minZ, maxX, maxZ] */
  bounds: [number, number, number, number];
  /** region boundary polygon in scene x,z (used to mask procedural context land) */
  boundary: [number, number][];
  camera?: { lon: number; lat: number; distance: number; heading: number; pitch: number };
  layers: Record<string, ManifestTile[]>;
}

export interface ManifestContext {
  id: string;
  layer: string;
  url: string;
  bytes: number;
}

export interface Manifest {
  version: 1;
  origin: { lon: number; lat: number };
  tileSize: number;
  regions: ManifestRegion[];
  context: ManifestContext[];
}
