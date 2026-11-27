import * as THREE from 'three';
import { TREE_STRIDE } from '../workers/meshWorker';
import { Y } from '../core/constants';
import { shared as shared_ } from './uniforms';
import { GLSL_COMMON } from './shaders/common.glsl';

/**
 * Instanced trees: a lumpy low-poly crown + trunk per tree, coloured per
 * instance (species class + random variation). Cheap enough for tens of
 * thousands of trees, and they cast shadows for dappled streets.
 */
let crownGeo: THREE.BufferGeometry | null = null;
let coneGeo: THREE.BufferGeometry | null = null;
let trunkGeo: THREE.BufferGeometry | null = null;
let crownMat: THREE.MeshStandardMaterial | null = null;
let parkCrownMat: THREE.MeshStandardMaterial | null = null;
let trunkMat: THREE.MeshStandardMaterial | null = null;

function lumpy(geo: THREE.BufferGeometry, amount: number) {
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 5.1 + v.y * 2.3) * Math.cos(v.z * 4.7 - v.y * 3.1);
    v.multiplyScalar(1 + n * amount);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function shared() {
  if (!crownGeo) {
    crownGeo = lumpy(new THREE.IcosahedronGeometry(1, 1), 0.12);
    coneGeo = new THREE.ConeGeometry(1, 2, 7, 1);
    trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 5, 1, true).translate(0, 0.5, 0);
    crownMat = glowingCrown(false);
    parkCrownMat = glowingCrown(true);
    trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3b2e, roughness: 1 });
  }
  return { crownGeo: crownGeo!, coneGeo: coneGeo!, trunkGeo: trunkGeo!, crownMat: crownMat!, parkCrownMat: parkCrownMat!, trunkMat: trunkMat! };
}

/**
 * Crown material with night-time glow: a soft emissive tint of the foliage
 * colour plus twinkling fairy lights scattered over the crown surface.
 * Park trees glow more and carry multicoloured lights; street trees get sparse warm lights.
 */
function glowingCrown(park: boolean) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLights = shared_.uLights;
    sh.uniforms.uTime = shared_.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTreeWP;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vTreeWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTreeWP; uniform float uLights; uniform float uTime;
        ${GLSL_COMMON}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 leaf = diffuseColor.rgb;
          totalEmissiveRadiance += ${park ? 'leaf * vec3(0.35, 1.5, 0.75) * 0.6' : 'leaf * 0.15'} * uLights;
          // fairy lights: one candidate bulb per ~0.7 m cell
          vec3 q = vTreeWP * 1.4;
          vec3 cell = floor(q);
          float r = h31(cell);
          float dens = ${park ? '0.8' : '0.9'};
          vec3 bulbCol = ${park
            ? 'h31(cell + 5.0) < 0.5 ? vec3(1.0, 0.78, 0.45) : (h31(cell + 9.0) < 0.33 ? vec3(1.0, 0.35, 0.7) : h31(cell + 9.0) < 0.66 ? vec3(0.35, 0.75, 1.0) : vec3(0.5, 1.0, 0.55))'
            : 'vec3(1.0, 0.82, 0.55)'};
          float tw = 0.6 + 0.4 * sin(uTime * (2.0 + r * 3.0) + r * 60.0);
          float d = length(fract(q) - 0.5 - (h33(cell) - 0.5) * 0.4);
          float bulb = step(dens, r) * smoothstep(0.22, 0.05, d) * tw;
          // fade to the average when bulbs are smaller than a pixel
          float px = length(fwidth(q));
          float avg = (1.0 - dens) * 0.12;
          float b = mix(bulb, avg, smoothstep(0.3, 1.2, px));
          totalEmissiveRadiance += bulbCol * b * ${park ? '4.0' : '2.4'} * uLights;
        }`);
  };
  m.customProgramCacheKey = () => `nyc-crown-${park}`;
  return m;
}

const PALETTE = [
  [0x3f6b2a, 0x4f7d33, 0x5a8a3a, 0x355e26], // broadleaf (plane, oak, linden)
  [0x6f9a3c, 0x7ea845, 0x8fb04f, 0x66903a], // honeylocust / ginkgo: airy, yellow-green
  [0x24452a, 0x2c5230, 0x1f3d25, 0x30583a], // conifers
  [0x4c7a35, 0x5d8a3c, 0x6b8f3f, 0x7a8f45], // flowering pear / cherry
];

/** Layer used for detail that is skipped in the water reflection pass. */
export const DETAIL_LAYER = 1;
const shadowCasters = new Set<THREE.InstancedMesh>();
let treeShadows = true;
/** Tree shadows are only worth their cost when the camera is close. */
export function setTreeShadows(on: boolean) {
  if (on === treeShadows) return;
  treeShadows = on;
  for (const m of shadowCasters) {
    let root: THREE.Object3D = m;
    while (root.parent) root = root.parent;
    if (!(root as THREE.Scene).isScene) { shadowCasters.delete(m); continue; } // tile was unloaded
    m.castShadow = on;
  }
}

export function createTrees(data: Float32Array, origin: [number, number], park = false): THREE.Group {
  const { crownGeo, coneGeo, trunkGeo, crownMat: streetMat, parkCrownMat, trunkMat } = shared();
  const crownMat = park ? parkCrownMat : streetMat;
  const n = data.length / TREE_STRIDE;
  const g = new THREE.Group();
  g.position.set(origin[0], 0, origin[1]);
  let nCone = 0;
  for (let i = 0; i < n; i++) if (data[i * TREE_STRIDE + 4] === 2) nCone++;
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, n - nCone);
  const cones = new THREE.InstancedMesh(coneGeo, crownMat, Math.max(1, nCone));
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();
  let ic = 0, io = 0;
  for (let i = 0; i < n; i++) {
    const o = i * TREE_STRIDE;
    const x = data[o], z = data[o + 1], r = data[o + 2], h = data[o + 3], cls = data[o + 4], seed = data[o + 5];
    const base = Y.sidewalks;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), seed * 6.28);
    const pal = PALETTE[cls] ?? PALETTE[0];
    col.setHex(pal[Math.floor(seed * 4) % 4]).multiplyScalar(0.85 + ((seed * 97) % 1) * 0.3);
    if (cls === 2) {
      p.set(x, base + h * 0.55, z); s.set(r * 0.7, h * 0.45, r * 0.7);
      cones.setMatrixAt(io, m.compose(p, q, s)); cones.setColorAt(io++, col);
    } else {
      const flat = cls === 1 ? 0.7 : 0.85;
      p.set(x, base + h - r * flat, z); s.set(r, r * flat, r * (0.9 + seed * 0.2));
      crowns.setMatrixAt(ic, m.compose(p, q, s)); crowns.setColorAt(ic++, col);
    }
    p.set(x, base, z); s.set(0.8 + r * 0.12, h - r * 0.9, 0.8 + r * 0.12);
    trunks.setMatrixAt(i, m.compose(p, q, s));
  }
  if (!nCone) cones.count = 0;
  for (const im of [crowns, cones, trunks]) {
    im.castShadow = treeShadows; im.receiveShadow = true;
    im.layers.set(DETAIL_LAYER);
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    g.add(im);
  }
  trunks.castShadow = false;
  shadowCasters.add(crowns); shadowCasters.add(cones);
  g.userData.kind = 'trees';
  return g;
}
