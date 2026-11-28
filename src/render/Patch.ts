import * as THREE from 'three';
import { GLSL_COMMON } from './shaders/common.glsl';
import { shared } from './uniforms';
import { createTrees } from './Trees';
import { createStreetLights } from './Lights';
import type { TerrainGrid } from '../workers/meshWorker';

/** Mirrors pipeline/patches.ts PatchMeta. */
export interface PatchMeta {
  id: string; name: string;
  origin: [number, number]; axisU: [number, number]; axisV: [number, number];
  resolution: number; width: number; height: number;
  grid: { cell: number; nu: number; nv: number; scale: number };
  baseY: number;
  outline: [number, number][];
  trees: number; lamps: number;
  files: { classes: string; heights: string; trees: string; lamps: string };
}

export interface LoadedPatch { group: THREE.Group; meta: PatchMeta; terrain: TerrainGrid; ground: THREE.Mesh }

/**
 * A terrain patch (Central Park): one draped mesh whose surface is coloured
 * per-pixel from a 1 m surface-class raster, plus its trees and path lamps.
 */
export async function loadPatch(root: string, url: string): Promise<LoadedPatch> {
  const meta = (await (await fetch(`${root}/${url}`)).json()) as PatchMeta;
  const [img, hbuf, tbuf, lbuf] = await Promise.all([
    fetch(`${root}/${meta.files.classes}`).then((r) => r.blob()).then((b) => createImageBitmap(b)),
    fetch(`${root}/${meta.files.heights}`).then((r) => r.arrayBuffer()),
    fetch(`${root}/${meta.files.trees}`).then((r) => r.arrayBuffer()),
    fetch(`${root}/${meta.files.lamps}`).then((r) => r.arrayBuffer()),
  ]);

  // ---- class raster -> R8 texture (nearest; the shader blends classes itself)
  const W = meta.width, H = meta.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const classes = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) classes[i] = rgba[i * 4];
  const tex = new THREE.DataTexture(classes, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;

  // ---- terrain grid
  const { cell, nu, nv, scale } = meta.grid;
  const heights = new Int16Array(hbuf);
  const terrain: TerrainGrid = { origin: meta.origin, axisU: meta.axisU, axisV: meta.axisV, cell, nu, nv, scale, heights };
  const classAt = (u: number, v: number) => {
    const px = Math.min(W - 1, Math.max(0, Math.floor(u / meta.resolution))), py = Math.min(H - 1, Math.max(0, Math.floor(v / meta.resolution)));
    return classes[py * W + px];
  };
  const pos = new Float32Array(nu * nv * 3), puv = new Float32Array(nu * nv * 2);
  const inside = new Uint8Array(nu * nv);
  const [ox, oz] = meta.origin, [ux, uz] = meta.axisU, [vx, vz] = meta.axisV;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const k = j * nu + i, u = i * cell, v = j * cell;
    pos[k * 3] = ox + ux * u + vx * v;
    pos[k * 3 + 1] = meta.baseY + heights[k] * scale;
    pos[k * 3 + 2] = oz + uz * u + vz * v;
    puv[k * 2] = u / (W * meta.resolution); puv[k * 2 + 1] = v / (H * meta.resolution);
    // a node counts as inside if any pixel around it is park
    let any = 0;
    for (const du of [-cell, 0, cell]) for (const dv of [-cell, 0, cell]) if (classAt(u + du, v + dv) !== 255) any = 1;
    inside[k] = any;
  }
  const idx: number[] = [];
  for (let j = 0; j < nv - 1; j++) for (let i = 0; i < nu - 1; i++) {
    const a = j * nu + i, b = a + 1, c = a + nu, d = c + 1;
    if (!(inside[a] || inside[b] || inside[c] || inside[d])) continue;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('puv', new THREE.BufferAttribute(puv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // make sure faces point up
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  if (nrm.getY(Math.floor(nrm.count / 2)) < 0) { for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]; geo.setIndex(idx); geo.computeVertexNormals(); }
  geo.computeBoundingSphere();

  const ground = new THREE.Mesh(geo, patchMaterial(tex, W, H));
  ground.receiveShadow = true;
  ground.userData.pickable = false;
  ground.userData.patch = meta.id;

  const group = new THREE.Group();
  group.name = `patch:${meta.id}`;
  group.add(ground);

  // low stone perimeter wall along the park edge
  group.add(perimeterWall(meta));

  // trees (absolute coords, stride 7)
  const trees = new Float32Array(tbuf);
  if (trees.length) group.add(createTrees(trees, [0, 0], true));
  // lamps: short park lamp posts with warm pools
  const L = new Float32Array(lbuf), n = L.length / 3;
  const xz = new Float32Array(n * 2), ys = new Float32Array(n);
  for (let i = 0; i < n; i++) { xz[i * 2] = L[i * 3]; ys[i] = L[i * 3 + 1]; xz[i * 2 + 1] = L[i * 3 + 2]; }
  if (n) group.add(createStreetLights(xz, [0, 0], ys, 3.6));

  // let the flat land / harbour water know where to stay away
  shared.uPatchClass.value = tex;
  shared.uPatchOrigin.value.set(ox, oz);
  shared.uPatchU.value.set(ux, uz);
  shared.uPatchV.value.set(vx, vz);
  shared.uPatchSizeM.value.set(W * meta.resolution, H * meta.resolution);
  shared.uPatchOn.value = 1;
  return { group, meta, terrain, ground };
}

/** Per-pixel park surface: lawns, woods, rock, ballfields, paths, water… with day and night looks. */
function patchMaterial(tex: THREE.Texture, W: number, H: number) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uClass = { value: tex };
    s.uniforms.uSize = { value: new THREE.Vector2(W, H) };
    s.uniforms.uLights = shared.uLights;
    s.uniforms.uTime = shared.uTime;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 puv; varying vec2 vPUv; varying vec3 vPW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPUv = puv; vPW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uClass; uniform vec2 uSize; uniform float uLights; uniform float uTime;
        varying vec2 vPUv; varying vec3 vPW;
        ${GLSL_COMMON}
        ${PATCH_SURFACE_GLSL}
        Surf gS;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 t = vPUv * uSize - 0.5;
          vec2 f = fract(t);
          ivec2 i0 = ivec2(floor(t));
          int cN = cls(ivec2(floor(vPUv * uSize)));
          if (cN == 255) discard;
          int c00 = cls(i0), c10 = cls(i0 + ivec2(1, 0)), c01 = cls(i0 + ivec2(0, 1)), c11 = cls(i0 + ivec2(1, 1));
          vec2 p = vPW.xz;
          Surf a = surf(c00 == 255 ? cN : c00, p), b = surf(c10 == 255 ? cN : c10, p);
          Surf c = surf(c01 == 255 ? cN : c01, p), d = surf(c11 == 255 ? cN : c11, p);
          gS = mixS(mixS(a, b, f.x), mixS(c, d, f.x), f.y);
          diffuseColor.rgb = gS.albedo;
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gS.rough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (gS.water > 0.01) {
          // wind ripples on the lakes (world space -> view space)
          vec2 q = vPW.xz;
          float px = length(fwidth(q));
          float aa1 = 1.0 - smoothstep(0.25, 1.2, px * 1.1), aa2 = 1.0 - smoothstep(0.25, 1.2, px * 2.7);
          vec2 g = vec2(0.0);
          g += vec2(cos(dot(q, vec2(0.9, 0.3)) * 0.9 + uTime * 1.3), cos(dot(q, vec2(-0.3, 0.9)) * 1.1 + uTime * 1.1)) * 0.06 * aa1;
          g += vec2(cos(dot(q, vec2(0.5, -0.8)) * 2.3 + uTime * 2.1), cos(dot(q, vec2(0.8, 0.6)) * 2.7 + uTime * 1.7)) * 0.035 * aa2;
          vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
          normal = normalize(mix(normal, normalize((viewMatrix * vec4(nW, 0.0)).xyz), gS.water));
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = gS.glow * uLights;');
  };
  m.customProgramCacheKey = () => 'nyc-patch-v1';
  return m;
}

const PATCH_SURFACE_GLSL = /* glsl */ `
struct Surf { vec3 albedo; float rough; vec3 glow; float water; };
int cls(ivec2 ip){
  ip = clamp(ip, ivec2(0), ivec2(uSize) - 1);
  return int(texelFetch(uClass, ip, 0).r * 255.0 + 0.5);
}
Surf mixS(Surf a, Surf b, float t){
  Surf s; s.albedo = mix(a.albedo, b.albedo, t); s.rough = mix(a.rough, b.rough, t);
  s.glow = mix(a.glow, b.glow, t); s.water = mix(a.water, b.water, t); return s;
}
Surf surf(int c, vec2 p){
  Surf s; s.rough = 0.95; s.glow = vec3(0.0); s.water = 0.0;
  float n1 = fbm(p * 0.06), n2 = vnoise(p * 0.7), n3 = vnoise(p * 3.1);
  vec3 grassGlow = vec3(0.018, 0.05, 0.022);
  vec3 pathGlow = vec3(0.10, 0.075, 0.05);
  if (c == 0) {        // lawn / meadow
    s.albedo = mix(vec3(0.13, 0.25, 0.06), vec3(0.21, 0.34, 0.09), n1) * (0.88 + 0.24 * n2);
    s.glow = grassGlow;
  } else if (c == 1) { // manicured lawns (Sheep Meadow, Great Lawn): mowing stripes
    float stripe = 0.5 + 0.5 * sin(dot(p, vec2(0.48, 0.88)) * 0.55);
    s.albedo = mix(vec3(0.17, 0.33, 0.07), vec3(0.23, 0.40, 0.10), stripe * 0.7 + n1 * 0.3) * (0.95 + 0.1 * n2);
    s.glow = grassGlow * 1.2;
  } else if (c == 2) { // woodland floor
    s.albedo = mix(vec3(0.09, 0.13, 0.05), vec3(0.17, 0.15, 0.08), n2) * (0.85 + 0.3 * n1);
    s.glow = grassGlow * 0.6;
  } else if (c == 3) { // gardens, shrubs, flower beds
    s.albedo = mix(vec3(0.11, 0.22, 0.06), vec3(0.19, 0.31, 0.10), n2);
    float fl = step(0.86, h21(floor(p * 1.6)));
    vec3 bloom = h21(floor(p * 1.6) + 3.0) < 0.33 ? vec3(0.85, 0.35, 0.55) : h21(floor(p * 1.6) + 7.0) < 0.5 ? vec3(0.95, 0.82, 0.25) : vec3(0.6, 0.45, 0.85);
    s.albedo = mix(s.albedo, bloom, fl * 0.85);
    s.glow = grassGlow + bloom * fl * 0.12;
  } else if (c == 4) { // Manhattan schist outcrops
    float streak = vnoise(vec2(dot(p, vec2(0.87, 0.48)) * 1.6, dot(p, vec2(-0.48, 0.87)) * 0.25));
    s.albedo = vec3(0.29, 0.29, 0.28) * (0.6 + 0.45 * n1 + 0.3 * streak) + vec3(0.02, 0.015, 0.0) * n3;
    s.rough = 0.75;
  } else if (c == 5) { // clay infields / sand
    s.albedo = vec3(0.55, 0.33, 0.20) * (0.92 + 0.12 * n2);
  } else if (c == 6) { // ballfields
    float stripe = step(0.5, fract(dot(p, vec2(0.48, 0.88)) / 6.0));
    s.albedo = mix(vec3(0.18, 0.37, 0.08), vec3(0.23, 0.44, 0.11), stripe) * (0.96 + 0.08 * n2);
    s.glow = grassGlow * 1.4;
  } else if (c == 7) { // playgrounds: coloured safety surfacing
    float r = h21(floor(p / 5.0));
    s.albedo = r < 0.33 ? vec3(0.62, 0.25, 0.20) : r < 0.66 ? vec3(0.20, 0.42, 0.62) : vec3(0.80, 0.62, 0.20);
    s.rough = 0.85; s.glow = pathGlow * 0.8;
  } else if (c == 8) { // plazas, terraces (Bethesda)
    vec2 g = fract(p / 1.2);
    float joint = step(0.94, max(g.x, g.y));
    s.albedo = vec3(0.64, 0.59, 0.51) * (0.92 + 0.12 * n2) * (1.0 - joint * 0.25);
    s.rough = 0.8; s.glow = pathGlow * 1.3;
  } else if (c == 9) { // asphalt footpaths
    s.albedo = vec3(0.25, 0.25, 0.26) * (0.9 + 0.2 * n3);
    s.rough = 0.88; s.glow = pathGlow;
  } else if (c == 10) { // bridle path / gravel
    s.albedo = vec3(0.50, 0.42, 0.31) * (0.9 + 0.2 * n3);
    s.glow = pathGlow * 0.6;
  } else if (c == 11) { // park drives & transverse roads
    s.albedo = vec3(0.21, 0.21, 0.22) * (0.92 + 0.12 * n2);
    s.rough = 0.85; s.glow = vec3(0.09, 0.055, 0.03);
  } else if (c == 12) { // stone steps
    s.albedo = vec3(0.56, 0.53, 0.48) * (0.85 + 0.25 * step(0.5, fract(dot(p, vec2(0.48, 0.88)) * 2.5)));
    s.glow = pathGlow;
  } else if (c == 13) { // lakes, the Reservoir, fountains
    s.albedo = mix(vec3(0.025, 0.06, 0.07), vec3(0.03, 0.075, 0.085), n1);
    s.rough = 0.04; s.water = 1.0; s.glow = vec3(0.012, 0.03, 0.06); // night: city & moon glow on the water
  } else if (c == 14) { // Wollman / Lasker rinks: floodlit ice
    s.albedo = vec3(0.82, 0.88, 0.94);
    s.rough = 0.15; s.glow = vec3(0.45, 0.5, 0.6);
  } else if (c == 15) { // bridges (Bow Bridge, Gapstow…)
    s.albedo = vec3(0.60, 0.55, 0.48) * (0.9 + 0.15 * n3);
    s.rough = 0.7; s.glow = pathGlow * 1.4;
  } else {
    s.albedo = vec3(0.3);
  }
  return s;
}
`;

/** The park's ~1 m schist/sandstone perimeter wall. */
function perimeterWall(meta: PatchMeta): THREE.Mesh {
  const ol = meta.outline, Hh = 1.05, T = 0.6, y0 = meta.baseY - 0.3;
  const pos: number[] = [], idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const o = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  for (let i = 0; i < ol.length; i++) {
    const [x0, z0] = ol[i], [x1, z1] = ol[(i + 1) % ol.length];
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
    if (l < 0.5) continue;
    const nx = (-dz / l) * T * 0.5, nz = (dx / l) * T * 0.5;
    const yt = meta.baseY + Hh;
    quad([x0 + nx, y0, z0 + nz], [x1 + nx, y0, z1 + nz], [x1 + nx, yt, z1 + nz], [x0 + nx, yt, z0 + nz]);
    quad([x1 - nx, y0, z1 - nz], [x0 - nx, y0, z0 - nz], [x0 - nx, yt, z0 - nz], [x1 - nx, yt, z1 - nz]);
    quad([x0 - nx, yt, z0 - nz], [x0 + nx, yt, z0 + nz], [x1 + nx, yt, z1 + nz], [x1 - nx, yt, z1 - nz]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x7d766b, roughness: 0.95, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  return m;
}
