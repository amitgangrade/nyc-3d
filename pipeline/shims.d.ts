declare module 'shapefile' {
  export function read(shp: string, dbf?: string): Promise<GeoJSON.FeatureCollection>;
}
