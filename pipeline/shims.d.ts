declare module 'shapefile' {
  export function read(shp: string, dbf?: string): Promise<GeoJSON.FeatureCollection>;
  export function open(shp: string, dbf?: string): Promise<{ read(): Promise<{ done: boolean; value: GeoJSON.Feature }> }>;
}
