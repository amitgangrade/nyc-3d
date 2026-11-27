import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import type { Manifest, ManifestTile } from '../core/manifest';
import type { BuildResult, GeometryArrays } from '../workers/meshWorker';
import { LAYERS, type LayerDef } from '../render/layers';
import { createStreetLights } from '../render/Lights';
import { createTrees, DETAIL_LAYER } from '../render/Trees';
import { WorkerPool } from './WorkerPool';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface BuildingInfo {
  region: string; tileKey: string; index: number;
  height: number; year: number; bin: number; centroid: [number, number];
  /** set for OpenStreetMap-sourced buildings */
  osm?: { type: 'way' | 'relation'; id: number };
}

interface TileState {
  key: string; region: string; provider?: string; layer: LayerDef; tile: ManifestTile;
  center: THREE.Vector2; radius: number;
  status: 'idle' | 'loading' | 'loaded';
  object?: THREE.Object3D;
  mesh?: THREE.Mesh;
  features?: BuildResult['features'];
}

/**
 * Streams region tiles in and out around the camera. Every region/layer/tile
 * from the manifest is a candidate; tiles within `loadRadius` (grows with
 * altitude) are meshed in workers and added to the scene; far tiles are freed.
 */
export class TileManager {
  readonly group = new THREE.Group();
  private tiles: TileState[] = [];
  private pool = new WorkerPool();
  private inflight = 0;
  private maxInflight = 10;
  /** loaded / total among tiles within ~2.5 km of the focus (drives the splash screen) */
  nearProgress = 0;
  onProgress?: (loaded: number, total: number) => void;
  onTileLoaded?: (t: { layer: string; features?: BuildResult['features']; origin: [number, number] }) => void;
  exclude: [number, number][] = [];

  constructor(manifest: Manifest, private dataRoot: string) {
    const T = manifest.tileSize;
    for (const region of manifest.regions) {
      for (const layer of LAYERS) {
        for (const tile of region.layers[layer.name] ?? []) {
          this.tiles.push({
            key: `${region.id}/${layer.name}/${tile.ix}_${tile.iz}`, region: region.id, provider: region.provider, layer, tile,
            center: new THREE.Vector2((tile.ix + 0.5) * T, (tile.iz + 0.5) * T), radius: T * 0.75,
            status: 'idle',
          });
        }
      }
    }
  }

  get total() { return this.tiles.length; }
  get loaded() { return this.tiles.filter((t) => t.status === 'loaded').length; }

  /** Call every frame. */
  update(camera: THREE.Camera, focus: THREE.Vector3) {
    const alt = Math.max(0, camera.position.y);
    const loadR = 7000 + alt * 2.5;
    const dropR = loadR * 1.4;
    const p = new THREE.Vector2(focus.x, focus.z);
    const camPos = new THREE.Vector2(camera.position.x, camera.position.z);
    const candidates = this.tiles
      .map((t) => ({ t, d: Math.max(0, p.distanceTo(t.center) - t.radius) }))
      .sort((a, b) => a.d - b.d);
    let near = 0, nearLoaded = 0;
    for (const { t, d } of candidates) {
      if (t.status === 'idle' && d < loadR && this.inflight < this.maxInflight) this.load(t);
      else if (t.status === 'loaded' && d > dropR) this.unload(t);
      if (d < 2500) { near++; if (t.status === 'loaded') nearLoaded++; }
      // fine detail (trees) only near the camera
      if (t.object) {
        const dc = Math.max(0, camPos.distanceTo(t.center) - t.radius);
        for (const c of t.object.children) if (c.userData.kind === 'trees') c.visible = dc < 3500;
      }
    }
    this.nearProgress = near ? nearLoaded / near : 1;
  }

  private async load(t: TileState) {
    t.status = 'loading';
    this.inflight++;
    const res = await this.pool.build({
      ...t.layer.build, url: `${this.dataRoot}/${t.tile.url}`,
      exclude: t.layer.build.kind === 'buildings' ? this.exclude : undefined,
    });
    this.inflight--;
    if (res.error) console.warn(t.key, res.error);
    const group = new THREE.Group();
    group.name = t.key;
    if (res.geometry) {
      const mesh = new THREE.Mesh(toGeometry(res.geometry), t.layer.material());
      mesh.position.set(res.origin[0], 0, res.origin[1]);
      mesh.castShadow = !!t.layer.castShadow;
      mesh.receiveShadow = !!t.layer.receiveShadow;
      mesh.userData.tileKey = t.key;
      mesh.userData.pickable = t.layer.pickable;
      if (t.layer.renderOrder) mesh.renderOrder = t.layer.renderOrder;
      if (t.layer.detail) mesh.layers.set(DETAIL_LAYER);
      group.add(mesh);
      t.mesh = mesh;
    }
    if (res.lights) {
      const sl = createStreetLights(res.lights, res.origin);
      sl.traverse((o) => o.layers.set(DETAIL_LAYER));
      group.add(sl);
    }
    if (res.trees?.length) group.add(createTrees(res.trees, res.origin, t.layer.name === 'parks'));
    t.features = res.features;
    t.object = group;
    t.status = 'loaded';
    this.group.add(group);
    this.onTileLoaded?.({ layer: t.layer.name, features: res.features, origin: res.origin });
    this.onProgress?.(this.loaded, this.total);
  }

  private unload(t: TileState) {
    if (!t.object) return;
    this.group.remove(t.object);
    t.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) { m.geometry.disposeBoundsTree?.(); m.geometry.dispose(); }
    });
    t.object = t.mesh = undefined; t.features = undefined;
    t.status = 'idle';
  }

  /** Pickable meshes (buildings) currently loaded. */
  pickables(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const t of this.tiles) if (t.mesh && t.layer.pickable) {
      if (!t.mesh.geometry.boundsTree) t.mesh.geometry.computeBoundsTree();
      out.push(t.mesh);
    }
    return out;
  }

  /** Everything that can be stood on (buildings + ground layers). */
  solids(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const t of this.tiles) if (t.mesh) {
      if (!t.mesh.geometry.boundsTree) t.mesh.geometry.computeBoundsTree();
      out.push(t.mesh);
    }
    return out;
  }

  /** Resolve a raycast hit on a building mesh to its building record. */
  buildingAt(hit: THREE.Intersection): BuildingInfo | null {
    const mesh = hit.object as THREE.Mesh;
    const t = this.tiles.find((x) => x.mesh === mesh);
    if (!t || !t.features || hit.face == null) return null;
    const info = mesh.geometry.getAttribute('info');
    const i = Math.round(info.getW(hit.face.a));
    const f = t.features;
    return {
      region: t.region, tileKey: t.key, index: i, height: f.height[i], year: f.year[i], bin: f.bin[i],
      centroid: [f.centroid[i * 2], f.centroid[i * 2 + 1]],
      osm: t.provider === 'osm' ? { type: f.osmType?.[i] ? 'relation' : 'way', id: f.bin[i] } : undefined,
    };
  }

  /** Extract one building's triangles (for the selection highlight). */
  buildingGeometry(b: BuildingInfo): { geometry: THREE.BufferGeometry; position: THREE.Vector3 } | null {
    const t = this.tiles.find((x) => x.key === b.tileKey);
    if (!t?.mesh) return null;
    const g = t.mesh.geometry;
    const info = g.getAttribute('info'), pos = g.getAttribute('position'), nor = g.getAttribute('normal');
    const index = g.getIndex()!;
    const out: number[] = [], on: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      if (Math.round(info.getW(a)) !== b.index) continue;
      for (let k = 0; k < 3; k++) {
        const v = index.getX(i + k);
        out.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        on.push(nor.getX(v), nor.getY(v), nor.getZ(v));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(on, 3));
    return { geometry: geo, position: t.mesh.position.clone() };
  }
}

export function toGeometry(a: GeometryArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
  if (a.uv) g.setAttribute('facade', new THREE.BufferAttribute(a.uv, 2));
  if (a.info) g.setAttribute('info', new THREE.BufferAttribute(a.info, 4));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
