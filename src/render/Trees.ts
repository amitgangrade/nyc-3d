import * as THREE from 'three';
import { TREE_STRIDE } from '../workers/meshWorker';
import { Y } from '../core/constants';

/**
 * Instanced trees: a lumpy low-poly crown + trunk per tree, coloured per
 * instance (species class + random variation). Cheap enough for tens of
 * thousands of trees, and they cast shadows for dappled streets.
 */
let crownGeo: THREE.BufferGeometry | null = null;
let coneGeo: THREE.BufferGeometry | null = null;
let trunkGeo: THREE.BufferGeometry | null = null;
let crownMat: THREE.MeshStandardMaterial | null = null;
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
    crownMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true });
    trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3b2e, roughness: 1 });
  }
  return { crownGeo: crownGeo!, coneGeo: coneGeo!, trunkGeo: trunkGeo!, crownMat: crownMat!, trunkMat: trunkMat! };
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

export function createTrees(data: Float32Array, origin: [number, number]): THREE.Group {
  const { crownGeo, coneGeo, trunkGeo, crownMat, trunkMat } = shared();
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
