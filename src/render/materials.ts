import * as THREE from 'three';
import { GLSL_COMMON } from './shaders/common.glsl';
import { shared } from './uniforms';

/**
 * Building material: MeshStandardMaterial (so it gets PBR lighting, shadows,
 * environment reflections, fog) with a procedural facade injected:
 * per-style window grids, glass vs. masonry, roof variation, lit windows at night.
 *
 * Geometry attributes: `facade` vec2 (metres along wall, metres above base)
 *                      `info`   vec4 (height, seed, style, featureIndex)
 */
export function createBuildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, envMapIntensity: 1 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uLights = shared.uLights;
    s.uniforms.uTime = shared.uTime;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 facade; attribute vec4 info;
        varying vec2 vFac; varying vec4 vInfo; varying vec3 vWN; varying vec3 vWP;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vFac = facade; vInfo = info;
        vWN = normalize(mat3(modelMatrix) * objectNormal);
        vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uLights; uniform float uTime;
        varying vec2 vFac; varying vec4 vInfo; varying vec3 vWN; varying vec3 vWP;
        ${GLSL_COMMON}
        ${FACADE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        Surface S = surface();
        diffuseColor.rgb = S.albedo;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = S.rough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = S.metal;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance = S.emit;`);
  };
  m.customProgramCacheKey = () => 'nyc-building-v1';
  return m;
}

const FACADE_GLSL = /* glsl */ `
struct Surface { vec3 albedo; float rough; float metal; vec3 emit; };

vec3 pick4(float r, vec3 a, vec3 b, vec3 c, vec3 d){ return r < 0.25 ? a : r < 0.5 ? b : r < 0.75 ? c : d; }

Surface roofSurface(float seed){
  float r = h11(seed * 91.7);
  vec3 c = r < 0.40 ? vec3(0.40, 0.40, 0.39) : r < 0.78 ? vec3(0.17, 0.17, 0.18) : r < 0.93 ? vec3(0.30, 0.27, 0.24) : vec3(0.24, 0.32, 0.22);
  float n = fbm(vWP.xz * 0.35) * 0.35 + vnoise(vWP.xz * 2.1) * 0.12;
  c *= 0.8 + n;
  // mechanical boxes / bulkheads as darker patches
  vec2 cell = floor(vWP.xz / 4.0 + vec2(vnoise(vWP.xz * 0.1)) * 2.0);
  float box = step(0.9, h21(cell + seed * 13.0));
  c = mix(c, vec3(0.55, 0.56, 0.57), box * 0.5);
  Surface S; S.albedo = c; S.rough = 0.9; S.metal = 0.0; S.emit = vec3(0.0);
  return S;
}

Surface surface(){
  float h = vInfo.x, seed = vInfo.y; int style = int(vInfo.z + 0.5);
  vec3 N = normalize(vWN);
  if (N.y > 0.5) return roofSurface(seed);

  float u = vFac.x, v = vFac.y;
  float rs = h11(seed * 37.1);
  // ---- style parameters
  float bayW = 3.0, floorH = 3.5, winW = 0.5, winH = 0.55, glassMetal = 0.4;
  vec3 wall = vec3(0.6); vec3 glass = vec3(0.06, 0.07, 0.08);
  float glassRough = 0.12;
  if (style == 0) {           // brick walk-ups / lofts
    bayW = 2.5 + rs * 0.9; floorH = 3.3 + rs * 0.5; winW = 0.42; winH = 0.56;
    wall = pick4(h11(seed * 7.3), vec3(0.42, 0.18, 0.12), vec3(0.50, 0.29, 0.20), vec3(0.33, 0.20, 0.16), vec3(0.62, 0.50, 0.38));
  } else if (style == 1) {    // limestone / pre-war
    bayW = 2.8 + rs * 0.8; floorH = 3.7 + rs * 0.5; winW = 0.40; winH = 0.58;
    wall = pick4(h11(seed * 7.3), vec3(0.72, 0.66, 0.55), vec3(0.62, 0.58, 0.51), vec3(0.78, 0.74, 0.66), vec3(0.55, 0.50, 0.44));
  } else if (style == 2) {    // post-war concrete / ribbon windows
    bayW = 3.0 + rs * 2.0; floorH = 3.6 + rs * 0.4; winW = 0.80 + rs * 0.12; winH = 0.46 + rs * 0.12;
    wall = pick4(h11(seed * 7.3), vec3(0.62, 0.62, 0.60), vec3(0.48, 0.48, 0.50), vec3(0.74, 0.73, 0.69), vec3(0.40, 0.38, 0.36));
    glassMetal = 0.55; glass = vec3(0.07, 0.08, 0.09);
  } else if (style == 3) {    // glass curtain wall
    bayW = 1.5 + rs * 0.6; floorH = 3.9 + rs * 0.4; winW = 0.93; winH = 0.78 + rs * 0.12;
    glass = pick4(h11(seed * 7.3), vec3(0.42, 0.56, 0.62), vec3(0.52, 0.56, 0.60), vec3(0.36, 0.48, 0.62), vec3(0.55, 0.52, 0.44));
    wall = glass * 0.35 + 0.04;
    glassMetal = 0.92; glassRough = 0.07;
  } else {                    // plain: garages, sheds
    bayW = 7.0; floorH = 4.0; winW = 0.0; winH = 0.0;
    wall = vec3(0.45, 0.44, 0.42);
  }

  vec2 cell = vec2(u / bayW, v / floorH);
  vec2 id = floor(cell);
  vec2 fw = fwidth(cell);
  float lod = smoothstep(0.3, 0.75, max(fw.x, fw.y));

  // storefront level for buildings > 8 m (taller, wider glazing)
  bool ground = v < 4.6 && h > 8.0;
  float ww = ground ? 0.86 : winW, wh = ground ? 0.72 : winH;
  if (ground) { cell.y = v / 4.6; id.y = -1.0; }

  float mask = pulseAA(cell.x, ww, fw.x) * pulseAA(cell.y, wh, fw.y);
  float parapet = 1.0 - smoothstep(h - 1.6, h - 1.2, v);
  float avgMask = ww * wh;
  mask = mix(mask, avgMask, lod) * parapet;

  // wall shading: grime near the street, subtle per-floor variation
  float grime = mix(0.72, 1.0, smoothstep(0.0, 14.0, v));
  float wn = 0.92 + 0.16 * vnoise(vec2(u * 0.15, v * 0.08) + seed * 50.0);
  vec3 wallC = wall * grime * wn;

  float pv = h21(id + seed * 113.0);           // per-pane variation
  vec3 glassC = glass * (0.8 + 0.4 * pv);
  float gRough = mix(glassRough + pv * 0.08, glassRough + 0.04, lod);

  Surface S;
  S.albedo = mix(wallC, glassC, mask);
  S.rough = mix(0.88, gRough, mask);
  S.metal = mix(0.0, glassMetal, mask);

  // ---- night lights
  vec3 emit = vec3(0.0);
  if (uLights > 0.001 && style != 4) {
    float floorLit = h21(vec2(id.y, seed * 71.0));
    float office = style == 3 || style == 2 ? 1.0 : 0.0;
    float p = uLights * mix(0.04, 0.62, floorLit * floorLit) * mix(1.0, 0.8, office);
    if (ground) p = uLights * 0.6;
    float r = h21(id * vec2(1.0, 3.1) + seed * 17.0);
    float on = step(r, p);
    float temp = h21(vec2(seed * 5.0, id.y));
    vec3 warm = vec3(1.0, 0.62, 0.32), neutral = vec3(1.0, 0.82, 0.6), cool = vec3(0.78, 0.86, 1.0);
    vec3 wc = office > 0.5 ? (temp < 0.55 ? cool : neutral) : (temp < 0.7 ? warm : neutral);
    float inten = mix(0.3, 1.05, pow(h21(id + seed * 3.0), 1.5));
    // interior falloff: ceiling brighter
    float fy = fract(cell.y);
    inten *= 0.75 + 0.5 * smoothstep(0.2, 0.9, fy);
    if (ground) { wc = vec3(1.0, 0.78, 0.5); inten = 1.1; }
    vec3 sharp = on * wc * inten * mask;
    vec3 avg = p * mix(neutral, office > 0.5 ? cool : warm, 0.5) * 0.8 * avgMask * parapet;
    emit = mix(sharp, avg, lod);

    // crown lighting on towers
    if (h > 110.0 && v > h - 9.0) {
      float cr = h11(seed * 9.9);
      vec3 cc = cr < 0.65 ? vec3(1.0, 0.92, 0.8) : cr < 0.82 ? vec3(0.45, 0.65, 1.0) : vec3(1.0, 0.7, 0.35);
      emit += cc * 1.1 * uLights * smoothstep(h - 9.0, h - 3.0, v) * step(0.35, h11(seed * 4.4));
    }
  }
  S.emit = emit;
  return S;
}
`;

/** Flat ground layers: standard material + subtle world-space noise so large areas aren't flat colour. */
export function createGroundMaterial(color: number, opts: { rough?: number; noise?: number; scale?: number; kind?: 'park' | 'road' | 'plain' } = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.92, metalness: 0 });
  const noise = opts.noise ?? 0.15, scale = opts.scale ?? 0.25, kind = opts.kind ?? 'plain';
  m.onBeforeCompile = (s) => {
    s.uniforms.uLights = shared.uLights;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP2;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP2 = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWP2; uniform float uLights;\n${GLSL_COMMON}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 p = vWP2.xz;
          float n = fbm(p * ${scale.toFixed(3)}) - 0.5;
          ${kind === 'park' ? `
            float canopy = smoothstep(0.45, 0.7, fbm(p * 0.09 + 3.0));
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.75, 0.5), canopy);
            float path = smoothstep(0.47, 0.5, vnoise(p * 0.03)) * (1.0 - smoothstep(0.5, 0.53, vnoise(p * 0.03)));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.52, 0.46), path * 0.7);
          ` : ''}
          ${kind === 'road' ? `
            float patchN = vnoise(p * 0.07);
            diffuseColor.rgb *= 0.85 + 0.3 * patchN;
          ` : ''}
          diffuseColor.rgb *= 1.0 + n * ${(noise * 2).toFixed(3)};
        }`);
  };
  m.customProgramCacheKey = () => `nyc-ground-${kind}-${scale}-${noise}`;
  return m;
}

/**
 * Context land (boroughs / NJ outside the detailed regions): a procedural
 * "urban fabric" by day and a glowing street grid by night, faded out where
 * a detailed region exists (uRegionMask).
 */
export function createContextLandMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x8a8780, roughness: 0.95, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uLights = shared.uLights;
    s.uniforms.uRegionMask = shared.uRegionMask;
    s.uniforms.uRegionMaskRect = shared.uRegionMaskRect;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP2; varying vec3 vWN2;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP2 = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN2 = objectNormal;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWP2; varying vec3 vWN2; uniform float uLights;
        uniform sampler2D uRegionMask; uniform vec4 uRegionMaskRect;
        ${GLSL_COMMON}
        vec3 gEmit = vec3(0.0);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 p = vWP2.xz;
          vec2 muv = (p - uRegionMaskRect.xy) / uRegionMaskRect.zw;
          float detailed = (muv.x > 0.0 && muv.x < 1.0 && muv.y > 0.0 && muv.y < 1.0) ? texture2D(uRegionMask, muv).r : 0.0;
          if (vWN2.y < 0.5) {
            diffuseColor.rgb = vec3(0.32, 0.30, 0.28); // seawall
          } else {
            // pick a street-grid orientation by neighbourhood
            float sel = vnoise(p * 0.00035);
            float ang = sel < 0.45 ? 0.506 : sel < 0.7 ? 0.0 : -0.35;
            mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
            vec2 q = rot * p;
            vec2 blk = vec2(78.0, sel < 0.45 ? 230.0 : 120.0);
            vec2 g = q / blk;
            vec2 fwv = fwidth(g);
            float streetW = 14.0;
            float sx = 1.0 - pulseAA(g.x + 0.5, 1.0 - streetW / blk.x, fwv.x);
            float sz = 1.0 - pulseAA(g.y + 0.5, 1.0 - streetW / blk.y, fwv.y);
            float street = max(sx, sz);
            vec2 bid = floor(g);
            float bh = h21(bid);
            float lod0 = smoothstep(0.08, 0.5, max(fwv.x, fwv.y));
            float green = smoothstep(0.62, 0.72, fbm(p * 0.0012 + 7.0));
            vec3 blockC = mix(vec3(0.27, 0.26, 0.25), vec3(0.40, 0.37, 0.33), bh) * (0.75 + 0.5 * vnoise(p * 0.02));
            blockC = mix(blockC, vec3(0.20, 0.28, 0.15), green);
            vec3 c = mix(blockC, vec3(0.21, 0.21, 0.22), street * (1.0 - lod0) * 0.55);
            c *= 0.9 + 0.2 * vnoise(p * 0.05);
            diffuseColor.rgb = mix(c, vec3(0.30, 0.29, 0.27), detailed);
            // night: lit street grid + scattered windows
            float lod = smoothstep(0.2, 0.8, max(fwv.x, fwv.y));
            vec3 sodium = vec3(1.0, 0.62, 0.30);
            float flick = 0.55 + 0.9 * vnoise(p * 0.004) * vnoise(p * 0.013 + 3.0);
            vec3 st = sodium * mix(street, 0.16, lod) * 0.16 * flick;
            vec2 wc = floor(q / 9.0);
            float win = step(0.93, h21(wc)) * (1.0 - street) * (1.0 - green);
            vec3 wn = vec3(1.0, 0.8, 0.55) * mix(win * 0.7, 0.05 * (1.0 - green), smoothstep(0.1, 0.6, length(fwidth(q / 9.0)))) * flick;
            gEmit = (st + wn) * uLights * (1.0 - detailed) * (1.0 - green * 0.7);
          }
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = gEmit;');
  };
  m.customProgramCacheKey = () => 'nyc-context-land';
  return m;
}
