import * as THREE from 'three';
import { Y } from '../core/constants';
import type { BuildRequest } from '../workers/meshWorker';
import { createBuildingMaterial, createGroundMaterial } from './materials';

/**
 * Registry of renderable tile layers. To add a new layer:
 *   1. emit it from a provider in pipeline/providers/*
 *   2. describe how to mesh + shade it here.
 */
export interface LayerDef {
  name: string;
  build: Omit<BuildRequest, 'id' | 'url'>;
  material: () => THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
  pickable?: boolean;
  renderOrder?: number;
  /** render only in the main pass (skipped in the water reflection) */
  detail?: boolean;
}

const lazy = <T,>(f: () => T) => { let v: T | undefined; return () => (v ??= f()); };

export const LAYERS: LayerDef[] = [
  { name: 'buildings', build: { kind: 'buildings' }, material: lazy(createBuildingMaterial), castShadow: true, receiveShadow: true, pickable: true },
  { name: 'roads', build: { kind: 'flat', y: Y.roads, lights: true }, material: lazy(() => createGroundMaterial(0x3a3b3e, { kind: 'road', noise: 0.08, scale: 0.4, glow: [0.11, 0.065, 0.035] })), receiveShadow: true },
  { name: 'sidewalks', build: { kind: 'flat', y: Y.sidewalks, skirt: 0.16 }, material: lazy(() => createGroundMaterial(0x9a968e, { noise: 0.06, scale: 0.6, glow: [0.13, 0.10, 0.075] })), receiveShadow: true },
  { name: 'paths', build: { kind: 'flat', y: Y.paths }, material: lazy(() => createGroundMaterial(0x9a968e, { noise: 0.06, scale: 0.6, kind: 'walk', glow: [0.16, 0.12, 0.08] })), receiveShadow: true, detail: true },
  { name: 'plazas', build: { kind: 'flat', y: Y.plazas }, material: lazy(() => createGroundMaterial(0xa49c8e, { noise: 0.07, glow: [0.11, 0.09, 0.07] })), receiveShadow: true },
  { name: 'trees', build: { kind: 'trees' }, material: lazy(() => new THREE.MeshBasicMaterial()) },
  { name: 'parks', build: { kind: 'flat', y: Y.parks, scatterTrees: 9 }, material: lazy(() => createGroundMaterial(0x5d8a45, { kind: 'park', noise: 0.12, scale: 0.12, glow: [0.025, 0.075, 0.03] })), receiveShadow: true },
  { name: 'piers', build: { kind: 'raised' }, material: lazy(() => createGroundMaterial(0x7d776e, { noise: 0.08, glow: [0.08, 0.065, 0.05] })), receiveShadow: true, castShadow: true },
  { name: 'water', build: { kind: 'flat', y: Y.inlandWater }, material: lazy(() => new THREE.MeshStandardMaterial({ color: 0x0d2a33, roughness: 0.05, metalness: 0.3 })), receiveShadow: true },
];
