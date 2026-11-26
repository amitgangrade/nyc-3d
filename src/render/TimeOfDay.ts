import * as THREE from 'three';

/** Everything that depends on the time of day, recomputed when the clock changes. */
export interface Atmosphere {
  hour: number;
  sunDir: THREE.Vector3;       // unit vector towards the sun (scene space, y up, -z north)
  moonDir: THREE.Vector3;
  sunElevation: number;        // degrees
  zenith: THREE.Color;
  horizon: THREE.Color;
  horizonSun: THREE.Color;     // horizon colour in the sun's direction
  sunColor: THREE.Color;       // direct light colour * intensity
  sunIntensity: number;
  ambientSky: THREE.Color;
  ambientGround: THREE.Color;
  ambientIntensity: number;
  fogColor: THREE.Color;
  fogDensity: number;
  night: number;               // 0 day .. 1 full night (stars, moon)
  lights: number;              // 0..1 artificial lights (windows, street lamps)
  exposure: number;
  bloom: { strength: number; radius: number; threshold: number };
  cloudLight: THREE.Color;
  envIntensity: number;
}

export const PRESETS = { day: 13.5, evening: 18.55, night: 21.75 } as const;
export type PresetName = keyof typeof PRESETS;

const LAT = 40.71 * (Math.PI / 180);
const DAY_OF_YEAR = 262; // ~Sept 19: sun sets almost due west, straight down the Hudson

/** Approximate solar position for NYC (EDT clock hours). */
export function sunPosition(hour: number): { el: number; az: number } {
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (DAY_OF_YEAR - 81)) * (Math.PI / 180);
  const solar = hour - 1 + 4 / 60 + 6 / 60; // DST, longitude, equation-of-time (approx.)
  const H = (15 * (solar - 12) * Math.PI) / 180;
  const el = Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI; // from north, clockwise
  return { el, az };
}

/** azimuth (from north, clockwise) + elevation -> scene direction */
function dirFrom(az: number, el: number, out = new THREE.Vector3()) {
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

// Keyframes indexed by sun elevation (degrees). Hand-tuned for a cinematic NYC look.
interface Key {
  el: number; zenith: number; horizon: number; horizonSun: number; sun: number; sunI: number;
  amb: number; ambI: number; fog: number; fogD: number; exposure: number; cloud: number; env: number;
}
const K: Key[] = [
  { el: -18, zenith: 0x02050f, horizon: 0x0c1122, horizonSun: 0x0e1224, sun: 0x000000, sunI: 0, amb: 0x1a2648, ambI: 0.5, fog: 0x0b0f1c, fogD: 8e-5, exposure: 1.0, cloud: 0x2a1c18, env: 0.35 },
  { el: -9, zenith: 0x060c22, horizon: 0x1b1d33, horizonSun: 0x3a2a3a, sun: 0x000000, sunI: 0, amb: 0x2b3660, ambI: 0.6, fog: 0x161a2c, fogD: 8e-5, exposure: 1.0, cloud: 0x3a2630, env: 0.4 },
  { el: -3, zenith: 0x14204a, horizon: 0x5a4a6a, horizonSun: 0xc8604a, sun: 0xff6a3a, sunI: 0.0, amb: 0x5a5a88, ambI: 0.7, fog: 0x4a4560, fogD: 9e-5, exposure: 0.95, cloud: 0xd06a5a, env: 0.6 },
  { el: 1, zenith: 0x2a4a8a, horizon: 0xb88a7a, horizonSun: 0xff7a35, sun: 0xff8a45, sunI: 1.5, amb: 0x8a8ab0, ambI: 0.75, fog: 0x9a8a92, fogD: 1.0e-4, exposure: 0.85, cloud: 0xff9a6a, env: 0.8 },
  { el: 6, zenith: 0x3d6db5, horizon: 0xd6b496, horizonSun: 0xffb060, sun: 0xffb070, sunI: 2.6, amb: 0x9fb0d0, ambI: 0.8, fog: 0xbcb2aa, fogD: 9e-5, exposure: 0.75, cloud: 0xffd0a0, env: 1.0 },
  { el: 18, zenith: 0x3a78d0, horizon: 0xb4cce6, horizonSun: 0xe8e2d4, sun: 0xfff0dc, sunI: 3.0, amb: 0xb0c8ec, ambI: 0.85, fog: 0xb8cce0, fogD: 7e-5, exposure: 0.7, cloud: 0xfff6ea, env: 1.0 },
  { el: 50, zenith: 0x2f6ccc, horizon: 0xa9c7ea, horizonSun: 0xd8e6f4, sun: 0xfffaf0, sunI: 3.2, amb: 0xb8d0f0, ambI: 0.9, fog: 0xb0c8e4, fogD: 6.5e-5, exposure: 0.7, cloud: 0xffffff, env: 1.0 },
];

const tmpA = new THREE.Color(), tmpB = new THREE.Color();
const lerpHex = (a: number, b: number, t: number, out: THREE.Color) =>
  out.copy(tmpA.setHex(a)).lerp(tmpB.setHex(b), t);
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function computeAtmosphere(hour: number): Atmosphere {
  const { el, az } = sunPosition(hour);
  const elDeg = (el * 180) / Math.PI;
  const sunDir = dirFrom(az, el);
  // moon: roughly opposite the sun, a bit higher so it is visible at night
  const moonDir = dirFrom(az + Math.PI * 0.85, Math.max(0.35, -el * 0.8 + 0.25));

  let i = 0;
  while (i < K.length - 2 && elDeg > K[i + 1].el) i++;
  const a = K[i], b = K[i + 1];
  const t = Math.min(1, Math.max(0, (elDeg - a.el) / (b.el - a.el)));
  const lerp = (x: number, y: number) => x + (y - x) * t;
  const c = (k: keyof Key) => lerpHex(a[k] as number, b[k] as number, t, new THREE.Color());

  const night = smooth(-2, -14, elDeg);
  const lights = smooth(7, -5, elDeg);
  const sunI = lerp(a.sunI, b.sunI) * smooth(-2.5, 0.5, elDeg);
  return {
    hour, sunDir, moonDir, sunElevation: elDeg,
    zenith: c('zenith'), horizon: c('horizon'), horizonSun: c('horizonSun'),
    sunColor: c('sun'), sunIntensity: sunI,
    ambientSky: c('amb'), ambientGround: new THREE.Color(0x3a3530).lerp(new THREE.Color(0x0a0a10), night),
    ambientIntensity: lerp(a.ambI, b.ambI),
    fogColor: c('fog'), fogDensity: lerp(a.fogD, b.fogD),
    night, lights,
    exposure: lerp(a.exposure, b.exposure),
    bloom: {
      strength: 0.10 + 0.42 * lights,
      radius: 0.4 + 0.2 * lights,
      threshold: 1.8 - 0.72 * lights,
    },
    cloudLight: c('cloud'),
    envIntensity: lerp(a.env, b.env),
  };
}
