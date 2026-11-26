/**
 * Spherical Transverse Mercator projection centred on a fixed world origin.
 *
 * World/scene convention (used everywhere, pipeline and viewer):
 *   x  = metres east of origin
 *   y  = metres up (0 = mean water level)
 *   z  = metres SOUTH of origin   (three.js: -z is "forward"/north)
 *
 * Over a ~50 km city-scale extent the scale error is < 0.003%, which is well
 * below footprint accuracy, so regions built at different times always line up.
 */
const R = 6378137;
const D2R = Math.PI / 180;

export interface GeoOrigin { lon: number; lat: number }

export class Projection {
  private lon0: number;
  private lat0: number;
  constructor(public readonly origin: GeoOrigin) {
    this.lon0 = origin.lon * D2R;
    this.lat0 = origin.lat * D2R;
  }

  /** lon/lat (degrees) -> [x, z] scene metres */
  forward(lon: number, lat: number): [number, number] {
    const phi = lat * D2R;
    const dl = lon * D2R - this.lon0;
    const B = Math.cos(phi) * Math.sin(dl);
    const x = R * Math.atanh(B);
    const n = R * (Math.atan2(Math.tan(phi), Math.cos(dl)) - this.lat0);
    return [x, -n];
  }

  /** [x, z] scene metres -> [lon, lat] degrees */
  inverse(x: number, z: number): [number, number] {
    const D = -z / R + this.lat0;
    const xr = x / R;
    const lat = Math.asin(Math.sin(D) / Math.cosh(xr));
    const lon = this.lon0 + Math.atan2(Math.sinh(xr), Math.cos(D));
    return [lon / D2R, lat / D2R];
  }
}
